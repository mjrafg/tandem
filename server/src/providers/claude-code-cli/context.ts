/**
 * Claude Code's native context operations: `/context` and `/compact`, run
 * against a resumed session in print mode. Verified on the installed CLI
 * (2.1.233): the session id stays the same, `/context` is answered locally
 * without a model call, `/compact` runs the provider's own summarization
 * inside the session.
 *
 * This is the whole reason the Claude adapter declares nativeContextInspection
 * and nativeCompaction. A backend without these operations declares neither,
 * and Tandem's context management then says so instead of pretending.
 */
import { execFile } from 'node:child_process';
import { config } from '../../config';
import { tokenForEnv } from '../../providerAuth';
import type { NativeContextReading } from '../types';
import { classifyClaudeFailure } from './errors';

interface SlashResult { ok: boolean; resultText: string; error?: string }

function claudeSlash(sessionId: string, model: string, cwd: string, command: '/context' | '/compact', timeoutMs: number): Promise<SlashResult> {
  const args = ['-p', '--output-format', 'json', '--model', model, '--resume', sessionId, command];
  return new Promise((resolve) => {
    execFile(config.claudeBin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      // the same stored token authenticates /context and /compact, which are
      // ordinary CLI invocations against the same session
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ...(tokenForEnv('claude') ? { CLAUDE_CODE_OAUTH_TOKEN: tokenForEnv('claude') as string } : {}),
      },
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

export async function readClaudeContext(sessionId: string, model: string, cwd: string): Promise<NativeContextReading> {
  const res = await claudeSlash(sessionId, model, cwd, '/context', 90_000);
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = parseClaudeContext(res.resultText);
  if (!parsed) return { ok: false, error: 'Could not parse the /context report from Claude Code.' };
  // note: /context's denominator can differ slightly from the canonical
  // modelUsage.contextWindow (autocompact buffer) — real calls record windows
  return { ok: true, ...parsed };
}

export async function compactClaudeSession(sessionId: string, model: string, cwd: string): Promise<{ ok: boolean; error?: string; resultText?: string }> {
  const res = await claudeSlash(sessionId, model, cwd, '/compact', 10 * 60_000);
  if (!res.ok) return { ok: false, error: res.error };
  // The CLI's envelope says "success" even when the summarization call inside
  // it was refused — during the 2026-09-03 overload two sessions "compacted"
  // for minutes and came back the same size. The refusal, when it is reported
  // at all, is in the result text.
  const refused = classifyClaudeFailure(res.resultText);
  const temporary = refused.kind === 'quota' || refused.kind === 'rate_limit' || refused.kind === 'overloaded' || refused.kind === 'transient';
  if (temporary || /\bAPI Error\b|error (?:while )?compacting|compaction failed/i.test(res.resultText)) {
    return { ok: false, error: `Claude Code accepted /compact but reported: ${res.resultText.slice(0, 400)}` };
  }
  return { ok: true, resultText: res.resultText };
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
