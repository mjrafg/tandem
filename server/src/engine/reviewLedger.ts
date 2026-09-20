/**
 * The durable review budget of a TASK.
 *
 * Until this existed, "which review round is this" was a parameter of one
 * startRun invocation: every run entered the loop at round 1, and the cap was
 * enforced only by that invocation's control flow. Nothing durable remembered
 * that a task had already been reviewed. So every path that continues a task
 * as a NEW invocation — the Director resuming an interrupted session, a
 * recovery decision to continue, boot recovery after a restart — handed the
 * same task a fresh two-review budget, and asked the Reviewer to judge the work
 * against "the user's original request" that was, in fact, the continuation
 * message ("Your previous run in this session was interrupted…"). One session
 * was reviewed four times; another five; the second cycle each time judged a
 * recovery instruction instead of the task.
 *
 * A task is opened by a genuine request (a user message in a chat, a Director
 * launching a session) and CONTINUED by everything else. This row is the task:
 * the request it was opened with — immutable for its life — and how much of
 * its review budget has been spent. Reviews are recorded in the same
 * transaction as the findings event, so a crash can never separate a verdict
 * from the round it consumed: either both exist or neither does, and a round
 * that never committed is simply reviewed again — which is the only outcome
 * that never loses a consumed attempt and never skips a required review.
 *
 * Writes are monotonic (a round can be recorded once; recording it again is a
 * no-op), so a replayed transition cannot double-count.
 */
import { createHash } from 'node:crypto';
import { db } from '../db';

export const MAX_REVIEW_ROUNDS = 2;

export interface ReviewLedger {
  chatId: string;
  /** events.seq of the user message that opened the task */
  taskSeq: number;
  /** the request the task was opened with — never rewritten by a continuation */
  originalRequest: string;
  reviewsConsumed: number;
  repairsConsumed: number;
  /** `resolved` = the Director closed every remaining finding as non-blocking; `waived` = the Director decided no review was needed */
  lastVerdict: 'pass' | 'findings' | 'resolved' | 'waived' | null;
  finalRepairDone: boolean;
  /** identity of the revision the last verdict was about */
  reviewedRevision: string | null;
  /**
   * Findings the Director has closed for this task (Builder upheld, or
   * deferred as non-blocking). A later review round is told these stand
   * closed and must not reopen them without new evidence — and that has to
   * survive a restart, which is why it is here and not in memory.
   */
  closedFindings: ClosedFinding[];
  updatedAt: number;
}

export interface ClosedFinding {
  id?: string;
  title: string;
  severity: 'major' | 'minor';
  decision: 'builder_upheld' | 'non_blocking' | 'deferred';
  reason: string;
  round: number;
}

db.exec(`
CREATE TABLE IF NOT EXISTS review_ledger (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id),
  task_seq INTEGER NOT NULL,
  original_request TEXT NOT NULL,
  reviews_consumed INTEGER NOT NULL DEFAULT 0,
  repairs_consumed INTEGER NOT NULL DEFAULT 0,
  last_verdict TEXT,
  final_repair_done INTEGER NOT NULL DEFAULT 0,
  reviewed_revision TEXT,
  updated_at INTEGER NOT NULL
);
`);
// additive: the Director's closed findings for the task (JSON array)
try { db.exec('ALTER TABLE review_ledger ADD COLUMN closed_findings TEXT'); } catch { /* exists */ }

function rowTo(r: any): ReviewLedger {
  return {
    chatId: r.chat_id, taskSeq: r.task_seq, originalRequest: r.original_request,
    reviewsConsumed: r.reviews_consumed, repairsConsumed: r.repairs_consumed,
    lastVerdict: r.last_verdict ?? null, finalRepairDone: !!r.final_repair_done,
    reviewedRevision: r.reviewed_revision ?? null, updatedAt: r.updated_at,
    closedFindings: parseClosed(r.closed_findings),
  };
}

function parseClosed(raw: unknown): ClosedFinding[] {
  if (typeof raw !== 'string' || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function getLedger(chatId: string): ReviewLedger | null {
  const r = db.prepare('SELECT * FROM review_ledger WHERE chat_id = ?').get(chatId) as any;
  return r ? rowTo(r) : null;
}

/**
 * A genuine new request opens a task: the budget starts at zero and the
 * request is fixed. The task is anchored at the most recent user message,
 * which every caller appends before starting the run.
 */
export function openTask(chatId: string, originalRequest: string): ReviewLedger {
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ? AND kind = 'user_message'").get(chatId) as any).s as number;
  const now = Date.now();
  db.prepare(`INSERT INTO review_ledger (chat_id, task_seq, original_request, reviews_consumed, repairs_consumed, last_verdict, final_repair_done, reviewed_revision, updated_at)
    VALUES (?, ?, ?, 0, 0, NULL, 0, NULL, ?)
    ON CONFLICT(chat_id) DO UPDATE SET task_seq = excluded.task_seq, original_request = excluded.original_request,
      reviews_consumed = 0, repairs_consumed = 0, last_verdict = NULL, final_repair_done = 0, reviewed_revision = NULL,
      closed_findings = NULL, updated_at = excluded.updated_at`)
    .run(chatId, seq, originalRequest, now);
  return getLedger(chatId)!;
}

/**
 * A verdict was reached for `round`. Monotonic: the budget only ever moves
 * forward, and re-recording the same round changes nothing but the verdict.
 * Call inside the transaction that appends the findings event.
 */
export function recordReview(chatId: string, round: number, verdict: 'pass' | 'findings', revision: string): void {
  db.prepare(`UPDATE review_ledger SET reviews_consumed = MAX(reviews_consumed, ?), last_verdict = ?, reviewed_revision = ?, updated_at = ?
    WHERE chat_id = ?`).run(round, verdict, revision, Date.now(), chatId);
}

/** A deleted chat leaves no task behind. */
export function deleteLedger(chatId: string): void {
  db.prepare('DELETE FROM review_ledger WHERE chat_id = ?').run(chatId);
}

/**
 * The Director closed findings for this task. Appends; never removes — a
 * closed finding stays closed for the task's life unless new evidence reopens
 * it through a fresh review, which is a new row in this list, not an edit.
 */
export function recordClosedFindings(chatId: string, items: ClosedFinding[]): void {
  if (items.length === 0) return;
  const cur = getLedger(chatId)?.closedFindings ?? [];
  db.prepare('UPDATE review_ledger SET closed_findings = ?, updated_at = ? WHERE chat_id = ?')
    .run(JSON.stringify([...cur, ...items]), Date.now(), chatId);
}

/**
 * Every remaining finding was closed by arbitration as non-blocking: the
 * task's standing verdict becomes `resolved`. This never spends a round — it
 * only reinterprets the last one in the light of the Director's decision.
 */
export function recordResolution(chatId: string): void {
  db.prepare("UPDATE review_ledger SET last_verdict = 'resolved', updated_at = ? WHERE chat_id = ?").run(Date.now(), chatId);
}

/**
 * The Director decided this task needs no independent review. Recorded as the
 * standing verdict so every reader (the Director's outcome, integration, the
 * snapshot) sees a deliberate decision rather than a missing review. Spends
 * no round: a later decision to review after all starts at round 1.
 */
export function recordWaiver(chatId: string): void {
  db.prepare("UPDATE review_ledger SET last_verdict = 'waived', updated_at = ? WHERE chat_id = ?").run(Date.now(), chatId);
}

export function recordRepair(chatId: string, final: boolean): void {
  db.prepare(`UPDATE review_ledger SET repairs_consumed = repairs_consumed + 1, final_repair_done = MAX(final_repair_done, ?), updated_at = ?
    WHERE chat_id = ?`).run(final ? 1 : 0, Date.now(), chatId);
}

/**
 * What a review round examined, reduced to an identity that survives restarts.
 * For file changes that is the worktree's content identity (`revisionHash`:
 * porcelain, `git diff HEAD`, and the untracked files' sizes+mtimes), never the
 * list of changed paths — a second edit to the same file is a new revision, and
 * must be reviewable, even though its path list is identical. For an answer it
 * is the answer text.
 */
export function revisionOf(treeHash: string | null, subject: { kind: 'changes'; files: string[] } | { kind: 'answer'; answer: string }): string {
  const h = createHash('sha1');
  h.update(subject.kind === 'changes' ? `changes\n${treeHash ?? [...subject.files].sort().join('\n')}` : `answer\n${subject.answer}`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Tasks that started before the ledger existed. Their history is in the event
 * log: the request that opened the task, and every verdict since. A Director
 * session's task is its launch prompt (the first user message; everything after
 * it is a continuation composed by the engine). A plain chat's task is its most
 * recent request, because there every message IS a new request. The derived
 * row is persisted so the derivation happens once.
 */
export function deriveLegacyLedger(chatId: string): ReviewLedger | null {
  const chat = db.prepare('SELECT kind FROM chats WHERE id = ?').get(chatId) as { kind?: string } | undefined;
  if (!chat) return null;
  const order = chat.kind === 'pd-session' ? 'ASC' : 'DESC';
  const anchor = db.prepare(`SELECT seq, payload FROM events WHERE chat_id = ? AND kind = 'user_message' ORDER BY seq ${order} LIMIT 1`).get(chatId) as any;
  if (!anchor) return null;
  const request = String((JSON.parse(anchor.payload) as any).text ?? '');
  const findings = (db.prepare("SELECT payload FROM events WHERE chat_id = ? AND kind = 'findings' AND seq > ? ORDER BY seq").all(chatId, anchor.seq) as any[])
    .map((r) => JSON.parse(r.payload) as { round?: number; verdict?: 'pass' | 'findings'; finalRepairNotReviewed?: boolean });
  const last = findings[findings.length - 1];
  const finalDone = !!last?.finalRepairNotReviewed
    || !!db.prepare("SELECT 1 FROM events WHERE chat_id = ? AND kind = 'ai_call' AND seq > ? AND payload LIKE '%\"role\":\"final_repair\"%' AND payload LIKE '%\"status\":\"done\"%' LIMIT 1").get(chatId, anchor.seq);
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO review_ledger (chat_id, task_seq, original_request, reviews_consumed, repairs_consumed, last_verdict, final_repair_done, reviewed_revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .run(chatId, anchor.seq, request, findings.length, findings.filter((f) => f.round === 1).length, last?.verdict ?? null, finalDone ? 1 : 0, now);
  return getLedger(chatId);
}
