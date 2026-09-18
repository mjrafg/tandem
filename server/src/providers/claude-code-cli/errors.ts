/**
 * Claude Code's failure vocabulary, turned into a typed ProviderFailure.
 *
 * The wording here is the CLI's own: "You've hit your session limit", "API
 * Error: 529 Overloaded", "OAuth session expired". Nothing upstream matches
 * these strings — workflow sees a kind and a retry time and decides policy.
 */
import { parseResetTime } from '../../engine/reviewWait';
import type { ProviderFailure } from '../types';

export function classifyClaudeFailure(text: string | undefined, now = Date.now()): ProviderFailure {
  const t = (text ?? '').slice(0, 4_000);
  const message = t.slice(0, 1_000) || 'The Claude Code CLI failed without a message.';
  const reset = parseResetTime(t, now);

  if (/session[ _-]?limit|usage[ _-]?limit|\bquota\b|usage_limit_reached/i.test(t)) {
    return { kind: 'quota', message, retryable: true, ...(reset ? { retryAfter: reset } : {}) };
  }
  if (/rate[ _-]?limit|too many requests|(?<![:\d.])429(?![:\d])|rate_limit_exceeded/i.test(t)) {
    return { kind: 'rate_limit', message, retryable: true, ...(reset ? { retryAfter: reset } : {}) };
  }
  if (/\boverloaded\b|(?:API Error|status(?: code)?|HTTP)\D{0,5}529\b/i.test(t)) {
    return { kind: 'overloaded', message, retryable: true };
  }
  if (/internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|(?:API Error|status(?: code)?|HTTP)\D{0,5}50[0234]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|stream disconnected|TypeError: fetch failed/i.test(t)) {
    return { kind: 'transient', message, retryable: true };
  }
  if (/OAuth|not logged in|authentication|unauthori[sz]ed|invalid api key|(?:API Error|status(?: code)?|HTTP)\D{0,5}401\b/i.test(t)) {
    return { kind: 'authentication', message, retryable: false };
  }
  if (/not a valid model|unknown model|model not found|(?:API Error|status(?: code)?|HTTP)\D{0,5}404\b.*model/i.test(t)) {
    return { kind: 'invalid_model', message, retryable: false };
  }
  if (/timed out after/i.test(t)) return { kind: 'timeout', message, retryable: true };
  if (/Could not start the Claude Code CLI/i.test(t)) return { kind: 'spawn_error', message, retryable: false };
  if (/exited \(code .*\) without a result/i.test(t)) return { kind: 'protocol_error', message, retryable: true };
  return { kind: 'provider_error', message, retryable: false };
}
