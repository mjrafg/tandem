import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiUsage, Chat, CompactionPayload } from '../../../shared/types';
import { config } from '../config';
import { estimateTokens, computeUsage } from '../context';
import { getProject, setBuilderSession } from '../db';
import { addEvent, getEvents, setChatCompaction } from '../events';
import { getSettings } from '../settings';
import { compactorSystemText, renderPrompt } from '../prompts';
import { runClaudeTurn } from './claude';
import { RunHandle, type RunCtx } from './run';

const COMPACT_TIMEOUT = 6 * 60_000;

/** Faithful plain-text digest of the chat's real events, fed to the Compactor. */
export function serializeConversation(chatId: string, capChars = 90_000): string {
  const events = getEvents(chatId);
  const lines: string[] = [];
  for (const e of events) {
    const p = e.payload as any;
    switch (e.kind) {
      case 'user_message': {
        const att = p.attachments?.length ? ` [attached: ${p.attachments.map((a: any) => a.name).join(', ')}]` : '';
        lines.push(`USER:${att} ${p.text ?? ''}`);
        break;
      }
      case 'assistant_message':
        if (p.text?.trim()) lines.push(`ASSISTANT: ${p.text}`);
        break;
      case 'findings':
        lines.push(p.verdict === 'pass'
          ? `REVIEWER (round ${p.round}): PASS`
          : `REVIEWER (round ${p.round}): ${p.items.map((i: any) => `[${i.severity}] ${i.title}${i.file ? ` (${i.file})` : ''}`).join('; ')}`);
        break;
      case 'file_change':
        lines.push(`CHANGED: ${p.files.map((f: any) => `${f.path} (+${f.additions} −${f.deletions})`).join(', ')}`);
        break;
      case 'command':
        if ((p.exitCode ?? 0) !== 0 && p.status !== 'running') {
          lines.push(`COMMAND FAILED (exit ${p.exitCode}): ${p.command}\n${String(p.stdout ?? '').slice(-400)}`);
        }
        break;
      case 'compaction':
        lines.push(`EARLIER COMPACTED CONTEXT:\n${p.summary}`);
        break;
      case 'status':
        if (/^Working directory is now /.test(p.text ?? '')) lines.push(p.text);
        break;
      case 'error':
        lines.push(`ERROR (${p.source ?? 'app'}): ${p.message}`);
        break;
      default:
        break;
    }
  }
  let text = lines.join('\n\n');
  if (text.length > capChars) {
    text = `${text.slice(0, capChars * 0.35)}\n\n… [older middle portion omitted for length] …\n\n${text.slice(-capChars * 0.6)}`;
  }
  return text;
}

/** Recent user/assistant exchange kept verbatim when a fresh session starts. */
export function recentConversation(chatId: string, capChars: number, excludeLastUserMessage: boolean): string {
  const events = getEvents(chatId);
  let lastUserId: string | null = null;
  if (excludeLastUserMessage) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'user_message') { lastUserId = events[i].id; break; }
    }
  }
  const lines: string[] = [];
  for (const e of events) {
    if (e.id === lastUserId) continue;
    const p = e.payload as any;
    if (e.kind === 'user_message') lines.push(`User: ${p.text ?? ''}${p.attachments?.length ? ` [attached: ${p.attachments.map((a: any) => a.name).join(', ')}]` : ''}`);
    else if (e.kind === 'assistant_message' && p.text?.trim()) lines.push(`Assistant: ${p.text}`);
  }
  let text = lines.join('\n\n');
  if (text.length > capChars) text = `…\n${text.slice(-capChars)}`;
  return text;
}

export interface CompactionCall {
  ok: boolean;
  summary: string;
  usage?: AiUsage;
  durationMs: number;
  provider: 'claude-code' | 'codex';
  model: string;
  beforeTokens: number;
  afterTokens: number;
  preserved: string[];
  error?: string;
}

/**
 * Run the REAL Compactor (one stateless CLI call, no project access: it runs
 * in an empty scratch directory). Emits its ai_call event into the timeline.
 */
export async function runCompaction(chat: Chat): Promise<CompactionCall> {
  const settings = getSettings();
  const cfg = settings.roles.compactor;
  const before = computeUsage(chat);
  const digest = serializeConversation(chat.id);

  const scratch = path.join(config.dataDir, 'tmp', `compact-${randomUUID()}`);
  fs.mkdirSync(scratch, { recursive: true });

  const ctx: RunCtx = { chatId: chat.id, runId: `compact-${randomUUID()}`, stopped: false };
  const project = getProject(chat.projectId)!;
  const h = new RunHandle(ctx, chat, project, []);

  const systemAppendix = compactorSystemText(settings);

  const result = cfg.provider === 'claude-code'
    ? await runClaudeTurn(h, {
      role: 'compactor',
      model: cfg.model,
      effort: cfg.effort,
      systemAppendix,
      message: renderPrompt('compactor.message', { conversation_digest: digest }),
      cwd: scratch,
      emitActivity: false,
      timeoutMs: COMPACT_TIMEOUT,
    })
    : { ok: false, stopped: false, resultText: '', durationMs: 0, error: 'Codex as Compactor is not wired yet — set the Compactor provider to Claude Code CLI in Admin.' } as const;

  fs.rmSync(scratch, { recursive: true, force: true });

  const summary = 'resultText' in result ? result.resultText.trim() : '';
  const preserveRecent = settings.context.preserveRecentTokens;
  const afterTokens = 2_400 + estimateTokens(summary) + Math.min(preserveRecent, estimateTokens(recentConversation(chat.id, preserveRecent * 4, false)));

  return {
    ok: result.ok && summary.length > 0,
    summary,
    usage: 'usage' in result ? result.usage : undefined,
    durationMs: result.durationMs,
    provider: cfg.provider,
    model: cfg.model,
    beforeTokens: before.usedTokens,
    afterTokens,
    preserved: [
      'The compacted context above (goals, decisions, state, open work)',
      `Up to ~${Math.round(preserveRecent / 1000)}k tokens of the most recent conversation, passed verbatim to the next call`,
      'The full original history — it stays stored and exportable, untouched',
    ],
    error: result.ok && summary.length === 0 ? 'The Compactor returned an empty summary.' : result.error,
  };
}

/** Persist an approved compaction: timeline event + fresh builder session. */
export function applyCompaction(chat: Chat, call: CompactionCall): string {
  const payload: CompactionPayload = {
    beforeTokens: call.beforeTokens,
    afterTokens: call.afterTokens,
    provider: call.provider,
    model: call.model,
    summary: call.summary,
    preserved: call.preserved,
    durationMs: call.durationMs,
  };
  const ev = addEvent(chat.id, 'compaction', payload);
  setChatCompaction(chat.id, ev.id);
  setBuilderSession(chat.id, null);
  return ev.id;
}
