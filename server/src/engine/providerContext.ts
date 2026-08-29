import { execFile } from 'node:child_process';
import type { Chat, CompactionPayload, CompactOutcome, Provider } from '../../../shared/types';
import { config } from '../config';
import { computeUsage } from '../context';
import { getBuilderSession, getBuilderSessionProvider, getProject } from '../db';
import { addEvent } from '../events';
import { getSettings } from '../settings';

/**
 * Provider-native context management. Tandem never summarizes conversations
 * itself and never sends them to another model — it asks the provider that
 * OWNS the active session to inspect or compact its own context. Everything
 * here dispatches on the configured PROVIDER, never on a role name.
 */

export interface NativeContextReading {
  ok: boolean;
  usedTokens?: number;
  windowTokens?: number;
  error?: string;
}

interface SessionRef {
  sessionId: string;
  cwd: string;
  model: string;
}

/** The provider that owns a chat's conversation session (per configuration). */
export function sessionProvider(): { provider: Provider; model: string } {
  const builder = getSettings().roles.builder;
  return { provider: builder.provider, model: builder.model };
}

// ------------------------------------------------------------- native reads

/**
 * Ask the provider for the session's real context state.
 * Claude Code answers `/context` locally (no model call, session untouched).
 * Codex has no equivalent on-demand report in the installed CLI.
 */
export async function readNativeContext(provider: Provider, ref: SessionRef): Promise<NativeContextReading> {
  if (provider === 'claude-code') {
    const res = await claudeSlash(ref, '/context', 90_000);
    if (!res.ok) return { ok: false, error: res.error };
    const parsed = parseClaudeContext(res.resultText);
    if (!parsed) return { ok: false, error: 'Could not parse the /context report from Claude Code.' };
    // note: /context's denominator can differ slightly from the canonical
    // modelUsage.contextWindow (autocompact buffer) — real calls record windows
    return { ok: true, ...parsed };
  }
  return {
    ok: false,
    error: 'The installed Codex CLI (0.147) has no on-demand context report for a session; context is tracked from per-turn usage instead.',
  };
}

/**
 * Ask the provider to compact its own session. Claude Code performs `/compact`
 * on the resumed session (its own internal summarization — same session id
 * remains valid). Codex 0.147 exposes no explicit compact operation through
 * `codex exec`; it compacts automatically inside long invocations, which is
 * its native behavior and needs no request from Tandem.
 */
async function runNativeCompact(provider: Provider, ref: SessionRef): Promise<{ ok: boolean; error?: string }> {
  if (provider === 'claude-code') {
    const res = await claudeSlash(ref, '/compact', 10 * 60_000);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  return {
    ok: false,
    error: 'The installed Codex CLI (0.147) has no explicit compact operation invokable through `codex exec` — '
      + 'slash commands like /compact are TUI-only, and sent through exec they reach the model as plain text '
      + '(verified: the model just replies "Context compacted." while the session history stays fully intact). '
      + 'Codex compacts its own context automatically during long invocations; that native behavior needs nothing from Tandem.',
  };
}

// ------------------------------------------------------------- the operation

/**
 * The full provider-native compaction flow for a chat: read real context,
 * compact natively, read again, record one honest compaction event.
 * On failure: one honest error event, session untouched, nothing simulated.
 */
export async function performNativeCompaction(chat: Chat, reason: 'manual' | 'auto'): Promise<CompactOutcome> {
  const { provider, model } = sessionProvider();
  const providerLabel = provider === 'claude-code' ? 'Claude' : 'Codex';
  const startedAt = Date.now();

  const fail = (error: string): CompactOutcome => {
    addEvent(chat.id, 'error', {
      message: `Native context compaction failed · ${providerLabel}`,
      detail: error,
      source: 'context',
      retryable: true,
    });
    return { ok: false, provider, model, durationMs: Date.now() - startedAt, error };
  };

  const sessionId = getBuilderSession(chat.id);
  if (!sessionId) {
    // nothing to compact — no error event for this; the caller shows it inline
    return {
      ok: false, provider, model, durationMs: 0,
      error: 'This chat has no active provider session yet — send a message first.',
    };
  }
  const sessionProviderOwner = getBuilderSessionProvider(chat.id);
  if (sessionProviderOwner !== provider) {
    const owner = sessionProviderOwner === 'claude-code' ? 'Claude Code' : 'Codex';
    const now = provider === 'claude-code' ? 'Claude Code' : 'Codex';
    return {
      ok: false, provider, model, durationMs: 0,
      error: `The active session was created by ${owner}, but the Builder provider is now ${now}. `
        + `A new ${now} session starts with the next message, and context management will follow it.`,
    };
  }
  const project = getProject(chat.projectId);
  if (!project) return fail('The chat\'s project no longer exists.');
  const ref: SessionRef = { sessionId, cwd: project.rootPath, model };

  // before: prefer the provider's own reading; fall back to the meter estimate
  const before = await readNativeContext(provider, ref);
  const est = computeUsage(chat);
  const beforeTokens = before.ok ? before.usedTokens : est.usedTokens != null ? est.usedTokens + est.pendingTokens : undefined;
  const windowBefore = before.ok ? before.windowTokens : est.windowTokens ?? undefined;

  const compacted = await runNativeCompact(provider, ref);
  if (!compacted.ok) return fail(compacted.error ?? 'Unknown error.');

  const after = await readNativeContext(provider, ref);
  const payload: CompactionPayload = {
    provider,
    model,
    beforeTokens,
    afterTokens: after.ok ? after.usedTokens : undefined,
    windowTokens: after.ok ? after.windowTokens : windowBefore,
    source: before.ok && after.ok ? 'provider' : 'estimated',
    reason,
    sessionId,
    durationMs: Date.now() - startedAt,
  };
  addEvent(chat.id, 'compaction', payload);
  return {
    ok: true, provider, model,
    beforeTokens: payload.beforeTokens, afterTokens: payload.afterTokens,
    windowTokens: payload.windowTokens, source: payload.source,
    durationMs: payload.durationMs!,
  };
}

// ------------------------------------------------------------- claude plumbing

interface SlashResult { ok: boolean; resultText: string; error?: string }

/**
 * Run one Claude Code slash command against a resumed session in print mode.
 * Verified on the installed CLI (2.1.233): the session id stays the same,
 * `/context` is answered locally, `/compact` runs the provider's own
 * summarization inside the session.
 */
function claudeSlash(ref: SessionRef, command: '/context' | '/compact', timeoutMs: number): Promise<SlashResult> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', ref.model,
    '--resume', ref.sessionId,
    command,
  ];
  return new Promise((resolve) => {
    execFile(config.claudeBin, args, {
      cwd: ref.cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    }, (err, stdout, stderr) => {
      if (err && !stdout) {
        const detail = (err as any).killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(stderr || err.message).slice(0, 500);
        resolve({ ok: false, resultText: '', error: `Claude Code CLI ${command} failed: ${detail}` });
        return;
      }
      try {
        const d = JSON.parse(stdout);
        if (d.is_error || (d.subtype && d.subtype !== 'success')) {
          resolve({ ok: false, resultText: '', error: `Claude Code reported ${d.subtype ?? 'an error'} for ${command}${typeof d.result === 'string' && d.result ? `: ${d.result.slice(0, 300)}` : ''}` });
          return;
        }
        resolve({ ok: true, resultText: typeof d.result === 'string' ? d.result : '' });
      } catch {
        resolve({ ok: false, resultText: '', error: `Claude Code CLI returned unparseable output for ${command}.` });
      }
    });
  });
}

/** Parse "**Tokens:** 23.2k / 1m (2%)" from the /context report. */
export function parseClaudeContext(text: string): { usedTokens: number; windowTokens: number } | null {
  const m = text.match(/\*\*Tokens:\*\*\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i);
  if (!m) return null;
  const used = parseTokenValue(m[1]);
  const window = parseTokenValue(m[2]);
  if (used == null || window == null) return null;
  return { usedTokens: used, windowTokens: window };
}

function parseTokenValue(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^([\d.]+)\s*([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1));
}
