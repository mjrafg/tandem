/**
 * Pending reviews — the persistent record behind AWAITING_REVIEW.
 *
 * When the Reviewer fails because of a TEMPORARY provider condition (usage
 * limit / quota / rate limit), the run must not complete unreviewed and must
 * not consume a review round: the Builder's result stays intact, the exact
 * review that failed is persisted here, and a sweeper retries the SAME review
 * (same round, same evidence) against the same provider once the reset time
 * passes. Rows survive restarts, so retry scheduling does too.
 *
 * Only the review's inputs are stored (round, user text, evidence subject) —
 * never tokens or credentials. `detail` is the provider's own error message,
 * bounded; it is already shown in the chat's error events today.
 */
import { db } from '../db';

export interface PendingReview {
  chatId: string;
  round: 1 | 2;
  userText: string;
  /** the ReviewSubject the failed round was examining, verbatim */
  subject: { kind: 'changes'; files: string[]; note: string } | { kind: 'answer'; answer: string };
  reason: string;      // short human label, e.g. "Codex usage limit"
  detail: string;      // provider error text (bounded)
  retryAt: number;
  attempts: number;
}

export function getPendingReview(chatId: string): PendingReview | null {
  const r = db.prepare('SELECT * FROM pending_reviews WHERE chat_id = ?').get(chatId) as any;
  if (!r) return null;
  return {
    chatId: r.chat_id, round: r.round, userText: r.user_text,
    subject: JSON.parse(r.subject), reason: r.reason, detail: r.detail,
    retryAt: r.retry_at, attempts: r.attempts,
  };
}

export function upsertPendingReview(p: Omit<PendingReview, 'attempts'> & { attempts?: number }): PendingReview {
  const now = Date.now();
  const existing = getPendingReview(p.chatId);
  const attempts = p.attempts ?? (existing ? existing.attempts + 1 : 1);
  db.prepare(`INSERT INTO pending_reviews (chat_id, round, user_text, subject, reason, detail, retry_at, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET round = excluded.round, user_text = excluded.user_text, subject = excluded.subject,
      reason = excluded.reason, detail = excluded.detail, retry_at = excluded.retry_at, attempts = excluded.attempts, updated_at = excluded.updated_at`)
    .run(p.chatId, p.round, p.userText, JSON.stringify(p.subject), p.reason, p.detail.slice(0, 2_000), p.retryAt, attempts, now, now);
  return { ...p, attempts };
}

export function deletePendingReview(chatId: string): void {
  db.prepare('DELETE FROM pending_reviews WHERE chat_id = ?').run(chatId);
}

/**
 * Bring a pending review's scheduled retry earlier (default: now), so the
 * sweeper fires it on its next pass instead of waiting for the provider's
 * reset time. Only ever moves the schedule EARLIER — a manual "retry now" after
 * an operator lifts a usage limit, never a way to delay a retry. Returns true
 * if a still-future row was moved.
 */
export function expediteReview(chatId: string, at = Date.now()): boolean {
  const r = db.prepare('UPDATE pending_reviews SET retry_at = ?, updated_at = ? WHERE chat_id = ? AND retry_at > ?')
    .run(at, Date.now(), chatId, at);
  return r.changes > 0;
}

export function duePendingReviews(now = Date.now()): PendingReview[] {
  const rows = db.prepare('SELECT chat_id FROM pending_reviews WHERE retry_at <= ?').all(now) as any[];
  return rows.map((r) => getPendingReview(r.chat_id)!).filter(Boolean);
}

// ------------------------------------------------------------- classification

export interface ProviderOutage {
  reason: string;   // short label for humans and the Director
  retryAt: number;  // when to retry (provider-supplied, or a default backoff)
}

/** default backoff when the provider names no reset time */
const DEFAULT_RETRY_MS = 15 * 60_000;
/** a stated reset already this far behind us is a rounding race, not yesterday */
const JUST_MISSED_MS = 20 * 60_000;
/** how soon to look again after such a near miss */
const NEAR_RETRY_MS = 3 * 60_000;
/** retry just AFTER a stated reset, never exactly on it */
const RESET_GRACE_MS = 60_000;

/**
 * Is this Reviewer failure a TEMPORARY provider condition (usage limit, quota,
 * rate limit)? This parses the provider's error contract — like parseVerdict,
 * it is protocol handling, not intent detection. Anything not clearly in the
 * quota family (model errors, auth errors, crashes, timeouts) returns null and
 * keeps its existing handling.
 */
export function classifyProviderOutage(errorText: string | undefined, now = Date.now(), provider = 'Codex'): ProviderOutage | null {
  const text = (errorText ?? '').slice(0, 4_000);
  if (!text) return null;
  // 429 counts only as a standalone HTTP-status token — never `file.js:429:7`
  // or another number that happens to contain it. "session limit" is Claude
  // Code's wording for the same condition ("You've hit your session limit").
  const quota = /usage[ _-]?limit|rate[ _-]?limit|session[ _-]?limit|\bquota\b|too many requests|(?<![:\d.])429(?![:\d])|usage_limit_reached|rate_limit_exceeded/i;
  if (!quota.test(text)) return null;

  const kind = /session[ _-]?limit/i.test(text) ? 'session limit'
    : /rate[ _-]?limit/i.test(text) && !/usage/i.test(text) ? 'rate limit'
      : 'usage limit';
  // a grace period on the provider's own figure: retrying on the exact second
  // it names loses the race often enough to matter
  const reset = parseResetTime(text, now);
  return { reason: `${provider} ${kind}`, retryAt: reset ? reset + RESET_GRACE_MS : now + DEFAULT_RETRY_MS };
}

/** Best-effort reset-time extraction from provider error text. */
export function parseResetTime(text: string, now: number): number | null {
  // "resets_at": 1735689600 / "retry_at": ... (epoch seconds or millis)
  const epoch = text.match(/"(?:resets?_at|retry_at|reset)"\s*:\s*(\d{9,13})/i);
  if (epoch) {
    const n = Number(epoch[1]);
    const t = n > 1e12 ? n : n * 1000;
    if (t > now && t < now + 14 * 24 * 3600_000) return t;
  }
  // "try again in 3 hours 25 minutes" / "in 45 minutes" / "in 30 seconds" / "in 2h 5m"
  // (every component demands digits+unit, so a bare "in" — e.g. inside "again" —
  // can never satisfy the match with empty groups)
  const rel = text.match(/in\s+((?:\d+\s*(?:hours?|h|min(?:utes?)?|m|sec(?:onds?)?|s)\b\s*)+)/i);
  if (rel) {
    let ms = 0;
    for (const part of rel[1].matchAll(/(\d+)\s*(hours?|h|min(?:utes?)?|m|sec(?:onds?)?|s)\b/gi)) {
      const unit = part[2][0].toLowerCase();
      ms += Number(part[1]) * (unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : 1000);
    }
    if (ms > 0 && ms < 14 * 24 * 3600_000) return now + Math.max(ms, 60_000);
  }
  // "try again at 14:45" / "resets at 2:45 PM" / "resets 11:30am (UTC)" — the
  // next occurrence of that wall-clock time.
  //
  // Two forms, deliberately separate. Only text reading literally "resets
  // <time>" may omit "at"; everything else still demands it. The keywords are
  // whole words (unanchored, "try" matches inside registry/telemetry and
  // "again" inside against), and the time may not be part of a longer
  // timestamp, or the 13:55 inside an ISO date would become the schedule.
  const TIME = String.raw`(?<![\d:])(\d{1,2}):(\d{2})(?![:\d])\s*(am|pm)?`;
  const at = text.match(new RegExp(String.raw`\bresets?\s+${TIME}`, 'i'))
    ?? text.match(new RegExp(String.raw`\b(?:again|try|retry|resets?|available|until)\b[^.\n]{0,20}?\bat\s+${TIME}`, 'i'));
  if (at) {
    let h = Number(at[1]);
    const m = Number(at[2]);
    const ap = at[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h < 24 && m < 60) {
      // when the provider names the zone, honour it rather than the host's —
      // Claude Code reports "resets 11:30am (UTC)" and a host on another zone
      // would otherwise schedule the retry hours off
      const utc = new RegExp(`${at[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(?\\s*UTC`, 'i').test(text);
      const d = new Date(now);
      if (utc) d.setUTCHours(h, m, 0, 0);
      else d.setHours(h, m, 0, 0);
      if (d.getTime() > now) return d.getTime();
      // The stated time has already passed. Providers report the reset to the
      // minute, so a retry made at the boundary can be refused by seconds and
      // come back naming a time that is now barely behind us — rolling that to
      // tomorrow would turn a few seconds of skew into a day of lost work.
      // Only a time well in the past really means the next occurrence.
      if (now - d.getTime() <= JUST_MISSED_MS) return now + NEAR_RETRY_MS;
      if (utc) d.setUTCDate(d.getUTCDate() + 1);
      else d.setDate(d.getDate() + 1);
      return d.getTime();
    }
  }
  return null;
}

/** "14:45 UTC (in ~37 min)" — unambiguous for logs, observations and activity lines. */
export function fmtRetryAt(retryAt: number, now = Date.now()): string {
  const clock = `${new Date(retryAt).toISOString().slice(11, 16)} UTC`;
  const mins = Math.max(1, Math.round((retryAt - now) / 60_000));
  return `${clock} (in ~${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`})`;
}
