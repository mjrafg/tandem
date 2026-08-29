import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AiUsage, AttachmentMeta, Chat, ChatEvent, ChangedFile, Effort, ErrorPayload, FindingsPayload, Project, Provider, RoleName, SearchMatch,
} from '../../../shared/types';
import { db, getChat, getProject } from '../db';
import { findOrCreateProject } from '../projectRoutes';
import {
  addEvent, appendAssistantText, beginAssistantMessage, broadcastChat, finishAssistantMessage,
  setChatCompaction, setChatRunning, updateEvent,
} from '../events';
import { computeUsage } from '../context';
import { getSettings } from '../settings';
import { buildScenario } from './scenarios';
import { generateCompactionSummary } from './compact';

interface RunCtx {
  chatId: string;
  runId: string;
  stopped: boolean;
  wake?: () => void;
  child?: ChildProcess;
}

const active = new Map<string, RunCtx>();

export function isRunning(chatId: string): boolean {
  return active.has(chatId);
}

export function stopRun(chatId: string): boolean {
  const ctx = active.get(chatId);
  if (!ctx) return false;
  ctx.stopped = true;
  try { ctx.child?.kill('SIGTERM'); } catch { /* already gone */ }
  ctx.wake?.();
  return true;
}

/** Helpers handed to a scenario script. All step methods respect Stop. */
export class Run {
  readonly ctx: RunCtx;
  readonly chat: Chat;
  project: Project;
  attachments: AttachmentMeta[] = [];
  readonly settings = getSettings();

  constructor(ctx: RunCtx, chat: Chat, project: Project) {
    this.ctx = ctx;
    this.chat = chat;
    this.project = project;
  }

  get stopped(): boolean {
    return this.ctx.stopped;
  }

  /** Sleep unless stopped; returns false when the run was stopped. */
  sleep(ms: number): Promise<boolean> {
    if (this.ctx.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(!this.ctx.stopped), ms);
      this.ctx.wake = () => {
        clearTimeout(t);
        resolve(false);
      };
    });
  }

  status(text: string): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'status', { text }, { runId: this.ctx.runId });
  }

  read(path: string, lines: number): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'file_read', { path, lines }, { runId: this.ctx.runId });
  }

  search(query: string, tool: string, matches: SearchMatch[]): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'search', { query, tool, matches }, { runId: this.ctx.runId });
  }

  async command(command: string, out: { stdout?: string; stderr?: string; exitCode?: number; durationMs: number }): Promise<void> {
    if (this.stopped) return;
    const ev = addEvent(this.chat.id, 'command', {
      command,
      cwd: this.project.rootPath,
      stdout: '',
      stderr: '',
      exitCode: null,
      durationMs: 0,
      status: 'running',
    }, { runId: this.ctx.runId });
    const ok = await this.sleep(Math.min(out.durationMs, 2_600));
    updateEvent(ev.id, ok
      ? { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0, durationMs: out.durationMs, status: 'done' }
      : { durationMs: out.durationMs, status: 'stopped' });
  }

  change(files: ChangedFile[]): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'file_change', { files }, { runId: this.ctx.runId });
  }

  findings(payload: FindingsPayload): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'findings', payload, { runId: this.ctx.runId });
  }

  error(payload: ErrorPayload): void {
    if (this.stopped) return;
    addEvent(this.chat.id, 'error', payload, { runId: this.ctx.runId });
  }

  async aiCall(opts: {
    role: RoleName | 'final_repair';
    prompt: string;
    responseText: string;
    durationMs: number;
    usage?: AiUsage;
  }): Promise<void> {
    if (this.stopped) return;
    const roleKey = opts.role === 'final_repair' ? 'builder' : opts.role;
    const cfg = this.settings.roles[roleKey];
    const cliBin = cfg.provider === 'claude-code' ? 'claude' : 'codex';
    const cliCmd = cfg.provider === 'claude-code'
      ? `claude -p --output-format stream-json --model ${cfg.model}`
      : `codex exec --json --sandbox read-only -m ${cfg.model}`;
    const ev = addEvent(this.chat.id, 'ai_call', {
      role: opts.role,
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.effort as Effort,
      status: 'running',
      request: { prompt: opts.prompt },
      cli: { command: cliCmd, cwd: this.project.rootPath, exitCode: null },
      startedAt: Date.now(),
      simulated: true,
    }, { runId: this.ctx.runId });
    const ok = await this.sleep(Math.min(opts.durationMs, 4_200));
    if (!ok) {
      updateEvent(ev.id, { status: 'stopped', durationMs: opts.durationMs });
      return;
    }
    updateEvent(ev.id, {
      status: 'done',
      durationMs: opts.durationMs,
      response: { text: opts.responseText, usage: opts.usage },
      cli: { command: cliCmd, cwd: this.project.rootPath, exitCode: 0 },
    });
    void cliBin;
  }

  /** Stream an assistant reply word-group by word-group. */
  async assistant(text: string): Promise<void> {
    if (this.stopped) return;
    const ev = beginAssistantMessage(this.chat.id, this.ctx.runId);
    const words = text.split(/(?<=\s)/);
    let buffer = '';
    for (let i = 0; i < words.length; i++) {
      buffer += words[i];
      if (buffer.length > 14 || i === words.length - 1) {
        appendAssistantText(ev, buffer);
        buffer = '';
        if (!(await this.sleep(24 + Math.random() * 46))) break;
      }
    }
    finishAssistantMessage(ev);
  }

  usageNow(): number {
    const chat = getChat(this.chat.id);
    return chat ? computeUsage(chat).usedTokens : 0;
  }

  /**
   * Run a REAL command (used for factual actions like `git clone` / `unzip`).
   * The command event carries the actual output, exit code, and duration.
   */
  realCommand(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const cwd = opts.cwd ?? this.project.rootPath;
    const shown = `${bin} ${args.join(' ')}`;
    const ev = addEvent(this.chat.id, 'command', {
      command: shown, cwd, stdout: '', stderr: '', exitCode: null, durationMs: 0, status: 'running',
    }, { runId: this.ctx.runId });
    const started = Date.now();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(bin, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      this.ctx.child = child;
      const cap = (s: string) => (s.length > 60_000 ? `${s.slice(0, 30_000)}\n… [truncated] …\n${s.slice(-20_000)}` : s);
      child.stdout?.on('data', (c) => (stdout += c));
      child.stderr?.on('data', (c) => (stderr += c));
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }, opts.timeoutMs ?? 5 * 60_000);
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ctx.child = undefined;
        const durationMs = Date.now() - started;
        updateEvent(ev.id, {
          stdout: cap(stdout.trim()), stderr: cap(stderr.trim()), exitCode, durationMs,
          status: this.ctx.stopped ? 'stopped' : exitCode === 0 ? 'done' : 'failed',
        });
        resolve({ exitCode, stdout, stderr });
      };
      child.on('error', (err) => {
        stderr += `\n${String(err)}`;
        finish(127);
      });
      child.on('close', (code) => finish(code));
    });
  }

  /** Re-point this chat's working directory; the UI reflects the new path. */
  switchWorkingDir(newPath: string, source: Project['source']): void {
    if (this.stopped) return;
    const project = findOrCreateProject(newPath, source);
    db.prepare('UPDATE chats SET project_id = ?, updated_at = ? WHERE id = ?').run(project.id, Date.now(), this.chat.id);
    this.project = project;
    broadcastChat(this.chat.id);
    addEvent(this.chat.id, 'status', { text: `Working directory is now ${project.rootPath}` }, { runId: this.ctx.runId });
  }
}

export async function startRun(chatId: string, userText: string, attachments: AttachmentMeta[] = []): Promise<void> {
  const chat = getChat(chatId);
  if (!chat || active.has(chatId)) return;
  const project = getProject(chat.projectId);
  if (!project) return;

  const ctx: RunCtx = { chatId, runId: randomUUID(), stopped: false };
  active.set(chatId, ctx);
  setChatRunning(chatId, true);
  addEvent(chatId, 'run', { phase: 'started' }, { runId: ctx.runId });

  const run = new Run(ctx, chat, project);
  run.attachments = attachments;
  try {
    await buildScenario(run, userText, attachments);
    addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
  } catch (err) {
    addEvent(chatId, 'error', { message: 'Agent run failed', detail: String(err), source: 'engine' }, { runId: ctx.runId });
    addEvent(chatId, 'run', { phase: 'failed' }, { runId: ctx.runId });
  } finally {
    markDanglingStopped(chatId, ctx.runId);
    active.delete(chatId);
    setChatRunning(chatId, false);
    maybeAutoCompact(chatId);
  }
}

/** Any event left in status:running after the run ends is marked stopped. */
function markDanglingStopped(chatId: string, runId: string): void {
  const rows = db.prepare('SELECT id, payload FROM events WHERE chat_id = ? AND run_id = ?').all(chatId, runId) as any[];
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (p.status === 'running') updateEvent(r.id, { status: 'stopped' });
  }
}

function maybeAutoCompact(chatId: string): void {
  const settings = getSettings();
  if (!settings.context.autoCompact) return;
  const chat = getChat(chatId);
  if (!chat) return;
  const usage = computeUsage(chat);
  if (usage.pct < settings.context.compactPct) return;
  const { summary, preserved } = generateCompactionSummary(chatId, settings);
  const after = Math.min(settings.context.autoTargetTokens, usage.usedTokens);
  const cfg = settings.roles.compactor;
  const ev = addEvent(chatId, 'compaction', {
    beforeTokens: usage.usedTokens,
    afterTokens: after,
    provider: cfg.provider as Provider,
    model: cfg.model,
    summary,
    preserved,
    durationMs: 4_800,
    simulated: true,
  });
  setChatCompaction(chatId, ev.id);
  broadcastChat(chatId);
}

export type { ChatEvent };
