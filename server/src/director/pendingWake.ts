/**
 * Pending Director wakes — the run-level counterpart to pending_reviews.
 *
 * When the REVIEWER hits a provider limit the review is persisted and retried
 * (see engine/reviewWait). The Builder and the Director had no such handling: a
 * Claude usage limit failed the call, the session dropped to needs_attention —
 * a state whose only exit is a Director decision — and the Director was blocked
 * by the very same limit. Nothing retried, so the project stopped dead and
 * stayed there long after the limit lifted.
 *
 * A row here means "this run has something to say to its Director, but the
 * provider refused; say it again at retry_at". It survives restarts, because
 * the outage usually outlives the process that observed it.
 *
 * Only the observation text is stored — never credentials. `detail` is the
 * provider's own error message, bounded, and already visible in the chat.
 */
import { db } from '../db';
import { transientRetryAt } from '../engine/reviewWait';

export interface PendingWake {
  runId: string;
  /** the text that could not be delivered, verbatim, ready to re-send */
  message: string;
  reason: string;   // "Claude session limit"
  detail: string;   // provider error text (bounded)
  retryAt: number;
  attempts: number;
}

db.exec(`
CREATE TABLE IF NOT EXISTS pending_wakes (
  run_id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

const MAX_MESSAGE = 12_000;

function rowTo(r: any): PendingWake {
  return {
    runId: r.run_id, message: r.message, reason: r.reason,
    detail: r.detail, retryAt: r.retry_at, attempts: r.attempts,
  };
}

export function getPendingWake(runId: string): PendingWake | null {
  const r = db.prepare('SELECT * FROM pending_wakes WHERE run_id = ?').get(runId) as any;
  return r ? rowTo(r) : null;
}

/**
 * Record (or extend) a run's wait. A second outage while one is already pending
 * keeps BOTH messages and the LATER reset — nothing may be dropped, and the run
 * cannot proceed until the last limit has lifted.
 */
export function upsertPendingWake(p: Omit<PendingWake, 'attempts'> & { transient?: boolean }): PendingWake {
  const now = Date.now();
  const existing = getPendingWake(p.runId);
  // a provider that is down names no reset time: the Nth consecutive wake backs off
  if (p.transient) p = { ...p, retryAt: Math.max(p.retryAt, transientRetryAt(existing ? existing.attempts + 1 : 1, now)) };
  const merged: PendingWake = existing
    ? {
      runId: p.runId,
      message: existing.message.includes(p.message) ? existing.message : `${existing.message}\n\n${p.message}`.slice(-MAX_MESSAGE),
      reason: p.reason,
      detail: p.detail.slice(0, 2_000),
      retryAt: Math.max(existing.retryAt, p.retryAt),
      attempts: existing.attempts + 1,
    }
    : { ...p, message: p.message.slice(-MAX_MESSAGE), detail: p.detail.slice(0, 2_000), attempts: 1 };

  db.prepare(`INSERT INTO pending_wakes (run_id, message, reason, detail, retry_at, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET message = excluded.message, reason = excluded.reason, detail = excluded.detail,
      retry_at = excluded.retry_at, attempts = excluded.attempts, updated_at = excluded.updated_at`)
    .run(merged.runId, merged.message, merged.reason, merged.detail, merged.retryAt, merged.attempts, now, now);
  return merged;
}

export function deletePendingWake(runId: string): void {
  db.prepare('DELETE FROM pending_wakes WHERE run_id = ?').run(runId);
}

/**
 * Bring a wait forward (default: now) so the next sweep delivers it. Only ever
 * moves the schedule EARLIER. This is the escape hatch the review path already
 * has: a provider that demonstrably answered, or an operator who knows the
 * limit is lifted, must not be held to a reset time that was parsed from a
 * sentence and could be wrong by a day.
 */
export function expediteWake(runId: string, at = Date.now()): boolean {
  const r = db.prepare('UPDATE pending_wakes SET retry_at = ?, updated_at = ? WHERE run_id = ? AND retry_at > ?')
    .run(at, Date.now(), runId, at);
  return r.changes > 0;
}

export function duePendingWakes(now = Date.now()): PendingWake[] {
  return (db.prepare('SELECT * FROM pending_wakes WHERE retry_at <= ?').all(now) as any[]).map(rowTo);
}

/** Is this run currently waiting out a provider limit? */
export function providerWaitActive(runId: string, now = Date.now()): PendingWake | null {
  const w = getPendingWake(runId);
  return w && w.retryAt > now ? w : null;
}
