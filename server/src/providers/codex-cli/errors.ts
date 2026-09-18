/**
 * Codex's failure vocabulary, turned into a typed ProviderFailure.
 *
 * The wording is Codex's own: "You've hit your usage limit … try again at
 * Sep 19th, 2026 4:34 PM", `usage_limit_exceeded`, "Too Many Requests". The
 * classification happens here so that nothing upstream matches OpenAI prose.
 */
import { parseResetTime } from '../../engine/reviewWait';
import type { ProviderFailure } from '../types';

export function classifyCodexFailure(text: string | undefined, now = Date.now()): ProviderFailure {
  const t = (text ?? '').slice(0, 4_000);
  const message = t.slice(0, 1_000) || 'The Codex CLI failed without a message.';
  const reset = parseResetTime(t, now);

  if (/usage[ _-]?limit|usage_limit_exceeded|\bquota\b|insufficient_quota|purchase more credits/i.test(t)) {
    return { kind: 'quota', message, retryable: true, ...(reset ? { retryAfter: reset } : {}) };
  }
  if (/rate[ _-]?limit|too many requests|(?<![:\d.])429(?![:\d])|rate_limit_exceeded/i.test(t)) {
    return { kind: 'rate_limit', message, retryable: true, ...(reset ? { retryAfter: reset } : {}) };
  }
  if (/\boverloaded\b|engine is currently overloaded|(?:status(?: code)?|HTTP)\D{0,5}529\b/i.test(t)) {
    return { kind: 'overloaded', message, retryable: true };
  }
  if (/internal server error|bad gateway|service unavailable|gateway time-?out|server had an error|temporarily unavailable|(?:status(?: code)?|HTTP)\D{0,5}50[0234]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|stream disconnected|error sending request/i.test(t)) {
    return { kind: 'transient', message, retryable: true };
  }
  if (/not logged in|login required|unauthori[sz]ed|invalid api key|authentication|(?:status(?: code)?|HTTP)\D{0,5}401\b/i.test(t)) {
    return { kind: 'authentication', message, retryable: false };
  }
  if (/model .* (?:does not exist|not found|not supported)|unknown model|invalid model|unsupported model/i.test(t)) {
    return { kind: 'invalid_model', message, retryable: false };
  }
  if (/timed out after/i.test(t)) return { kind: 'timeout', message, retryable: true };
  if (/Could not start the Codex CLI/i.test(t)) return { kind: 'spawn_error', message, retryable: false };
  if (/produced no .* message|exited with code/i.test(t)) return { kind: 'protocol_error', message, retryable: true };
  return { kind: 'provider_error', message, retryable: false };
}
