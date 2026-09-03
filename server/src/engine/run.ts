import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, AttachmentMeta, Chat, ErrorPayload, Project } from '../../../shared/types';
import { db, getChat, getProject } from '../db';
import { addEvent, broadcastChat, setChatRunning, updateEvent } from '../events';
import { getSettings } from '../settings';
import { findOrCreateProject } from '../projectRoutes';

export interface RunCtx {
  chatId: string;
  runId: string;
  stopped: boolean;
  child?: ChildProcess;
  killTimer?: NodeJS.Timeout;
  /** project root at run start (same-repo concurrency guard) */
  rootPath?: string;
  /**
   * Which role the run is currently executing. Set to 'reviewer' around review
   * calls so app-state tools meant for the Builder (Project Memory) can be
   * refused server-side, not merely withheld from the Reviewer's tool list.
   */
  phase?: 'builder' | 'reviewer';
}

/** Another chat actively running in the same directory? (branch switching makes that destructive) */
export function repoBusyBy(rootPath: string, exceptChatId: string): string | null {
  for (const ctx of active.values()) {
    if (ctx.chatId !== exceptChatId && ctx.rootPath === rootPath) return ctx.chatId;
  }
  return null;
}

const active = new Map<string, RunCtx>();
/**
 * Chats inside a provider-native compaction. A compaction is not a RunCtx —
 * it registers no child and cannot be stopped — but it drives the SAME provider
 * session for minutes (`/context`, `/compact`, `/context` again). Both workflow
 * call sites launch it from a run's `finally`, i.e. AFTER releaseCtx, so
 * without this the chat looks idle for the whole compaction and the next turn
 * would resume the same session id concurrently. That was survivable while
 * auto-compaction was off and its trigger unreachable; it is the normal
 * end-of-run path now.
 */
const compacting = new Set<string>();

export function beginCompaction(chatId: string): void { compacting.add(chatId); }
export function endCompaction(chatId: string): void { compacting.delete(chatId); }

export function isRunning(chatId: string): boolean {
  return active.has(chatId) || compacting.has(chatId);
}

export function activeCtx(chatId: string): RunCtx | undefined {
  return active.get(chatId);
}

export function registerCtx(ctx: RunCtx): void {
  active.set(ctx.chatId, ctx);
}

export function releaseCtx(ctx: RunCtx): void {
  clearTimeout(ctx.killTimer);
  active.delete(ctx.chatId);
}

export function stopRun(chatId: string): boolean {
  const ctx = active.get(chatId);
  if (!ctx) return false;
  ctx.stopped = true;
  killChild(ctx);
  return true;
}

export function killChild(ctx: RunCtx): void {
  const child = ctx.child;
  if (!child) return;
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  ctx.killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }, 8_000);
}

/**
 * Boot recovery: if the service died or restarted while runs were active, the
 * agent processes are gone but chats stay flagged running=1 forever, and the
 * UI shows an eternal "Working…". Make the interruption honest and visible.
 */
/** Returns the chats whose run died with the server, so callers can tell an
 *  interrupted project apart from one that was simply idle. */
export function recoverInterruptedRuns(): Set<string> {
  const rows = db.prepare('SELECT id FROM chats WHERE running = 1').all() as { id: string }[];
  for (const { id } of rows) {
    const dangling = db.prepare(`SELECT id FROM events WHERE chat_id = ? AND payload LIKE '%"status":"running"%'`).all(id) as { id: string }[];
    for (const ev of dangling) updateEvent(ev.id, { status: 'stopped' }, { silent: true });
    addEvent(id, 'error', {
      message: 'Run interrupted — Tandem restarted while the agent was working',
      detail: 'The agent process did not survive the restart. Send a follow-up message to continue; the Builder resumes its session with the prior context.',
      source: 'engine',
    }, { silent: true });
    addEvent(id, 'run', { phase: 'stopped' }, { silent: true });
    db.prepare('UPDATE chats SET running = 0 WHERE id = ?').run(id);
  }
  if (rows.length > 0) console.log(`[tandem] recovered ${rows.length} run(s) interrupted by the previous shutdown`);
  return new Set(rows.map((r) => r.id));
}

/** Anything left in status:running after a run ends is marked stopped. */
export function markDanglingStopped(chatId: string, runId: string): void {
  const rows = db.prepare('SELECT id, payload FROM events WHERE chat_id = ? AND run_id = ?').all(chatId, runId) as any[];
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (p.status === 'running') updateEvent(r.id, { status: 'stopped' });
  }
}

/** Shared state + emit helpers handed to the provider adapters. */
export class RunHandle {
  readonly ctx: RunCtx;
  chat: Chat;
  project: Project;
  attachments: AttachmentMeta[];
  /** active Git workflow for this run (set at adoption; undefined = unavailable) */
  gitFlow?: import('../../../shared/types').GitFlowState;
  readonly settings: AppSettings;

  constructor(ctx: RunCtx, chat: Chat, project: Project, attachments: AttachmentMeta[]) {
    this.ctx = ctx;
    this.chat = chat;
    this.project = project;
    this.attachments = attachments;
    this.settings = getSettings();
  }

  get stopped(): boolean {
    return this.ctx.stopped;
  }

  status(text: string): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'status', { text }, { runId: this.ctx.runId });
  }

  error(payload: ErrorPayload): void {
    addEvent(this.chat.id, 'error', payload, { runId: this.ctx.runId });
  }

  /** Re-read chat + project (the working directory may have changed mid-run). */
  refresh(): void {
    const chat = getChat(this.chat.id);
    if (chat) {
      this.chat = chat;
      const project = getProject(chat.projectId);
      if (project) this.project = project;
    }
  }
}

/**
 * The working-directory capability: invoked by the Builder through the
 * tandem_set_working_dir MCP tool (never by intent guessing). Validates the
 * path, re-points the chat, and records what happened.
 */
export function applyWorkdirChange(chatId: string, dirPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, error: 'Unknown chat.' };
  if (!dirPath || !path.isAbsolute(dirPath)) return { ok: false, error: 'Path must be absolute.' };
  const resolved = path.resolve(dirPath);
  let st: fs.Stats;
  try { st = fs.statSync(resolved); } catch { return { ok: false, error: 'Directory does not exist.' }; }
  if (!st.isDirectory()) return { ok: false, error: 'Path is not a directory.' };
  for (const forbidden of ['/proc', '/sys', '/dev', '/boot', '/run']) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/')) return { ok: false, error: `Directories under ${forbidden} cannot be a workspace.` };
  }
  const project = findOrCreateProject(resolved, 'directory');
  db.prepare('UPDATE chats SET project_id = ?, updated_at = ? WHERE id = ?').run(project.id, Date.now(), chatId);
  broadcastChat(chatId);
  const ctx = active.get(chatId);
  addEvent(chatId, 'status', { text: `Working directory is now ${resolved}` }, { runId: ctx?.runId });
  return { ok: true, path: resolved };
}

export { setChatRunning };
