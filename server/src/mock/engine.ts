import { randomUUID } from 'node:crypto';
import type {
  AiUsage, Chat, ChatEvent, ChangedFile, Effort, FindingsPayload, Project, Provider, RoleName, SearchMatch,
} from '../../../shared/types';
import { db, getChat, getProject } from '../db';
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
}

const active = new Map<string, RunCtx>();

export function isRunning(chatId: string): boolean {
  return active.has(chatId);
}

export function stopRun(chatId: string): boolean {
  const ctx = active.get(chatId);
  if (!ctx) return false;
  ctx.stopped = true;
  ctx.wake?.();
  return true;
}

/** Helpers handed to a scenario script. All step methods respect Stop. */
export class Run {
  readonly ctx: RunCtx;
  readonly chat: Chat;
  readonly project: Project;
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
}

export async function startRun(chatId: string, userText: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat || active.has(chatId)) return;
  const project = getProject(chat.projectId);
  if (!project) return;

  const ctx: RunCtx = { chatId, runId: randomUUID(), stopped: false };
  active.set(chatId, ctx);
  setChatRunning(chatId, true);
  addEvent(chatId, 'run', { phase: 'started' }, { runId: ctx.runId });

  const run = new Run(ctx, chat, project);
  try {
    await buildScenario(run, userText);
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
