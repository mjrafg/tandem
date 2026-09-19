/**
 * The durable lifecycle of every finding in a task.
 *
 * A finding is raised once and keeps its identity — F-001 stays F-001 through
 * the Builder's answer, the repair, the verification round, the Director's
 * decision and the final state. The timeline's events show each step as it
 * happened; this table holds where each finding STANDS, so a restart, the
 * Reviewer's next round, the Director and Observatory all read the same
 * record instead of re-deriving it from prose.
 */
import type {
  ArbitrationDecision, ArbitrationItem, Finding, FindingDisposition, FindingResponse, FindingState,
  RepairStatus, ReviewFindingRecord,
} from '../../../shared/types';
import { db } from '../db';

db.exec(`
CREATE TABLE IF NOT EXISTS review_findings (
  chat_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_seq INTEGER NOT NULL,
  round INTEGER NOT NULL,
  severity TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  detail TEXT NOT NULL,
  evidence TEXT,
  recommendation TEXT,
  state TEXT NOT NULL,
  disposition TEXT,
  disposition_reason TEXT,
  disposition_evidence TEXT,
  repair_status TEXT,
  arbitration_decision TEXT,
  arbitration_reason TEXT,
  arbitration_required TEXT,
  blocking INTEGER,
  restated INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS idx_review_findings_task ON review_findings(chat_id, task_seq);
`);
// additive: what the Reviewer ran or saw that showed a repair holds
try { db.exec('ALTER TABLE review_findings ADD COLUMN resolution_evidence TEXT'); } catch { /* exists */ }

function rowTo(r: any): ReviewFindingRecord {
  return {
    chatId: r.chat_id, id: r.id, taskSeq: r.task_seq, round: r.round, severity: r.severity, category: r.category ?? null,
    title: r.title, file: r.file ?? null, line: r.line ?? null, detail: r.detail, evidence: r.evidence ?? null,
    recommendation: r.recommendation ?? null, state: r.state, disposition: r.disposition ?? null,
    dispositionReason: r.disposition_reason ?? null, dispositionEvidence: r.disposition_evidence ?? null,
    repairStatus: r.repair_status ?? null, arbitrationDecision: r.arbitration_decision ?? null,
    arbitrationReason: r.arbitration_reason ?? null, arbitrationRequired: r.arbitration_required ?? null,
    resolutionEvidence: r.resolution_evidence ?? null,
    blocking: r.blocking == null ? null : !!r.blocking, restated: r.restated ?? 0, updatedAt: r.updated_at,
  };
}

/** every finding of the task, in the order they were raised */
export function listFindings(chatId: string, taskSeq: number): ReviewFindingRecord[] {
  return (db.prepare('SELECT * FROM review_findings WHERE chat_id = ? AND task_seq = ? ORDER BY round, id').all(chatId, taskSeq) as any[]).map(rowTo);
}

export function getFinding(chatId: string, id: string): ReviewFindingRecord | null {
  const r = db.prepare('SELECT * FROM review_findings WHERE chat_id = ? AND id = ?').get(chatId, id) as any;
  return r ? rowTo(r) : null;
}

/** a deleted chat leaves no findings behind */
export function deleteFindings(chatId: string): void {
  db.prepare('DELETE FROM review_findings WHERE chat_id = ?').run(chatId);
}

/** F-001, F-002… continuing across rounds and across the chat's tasks */
function nextId(chatId: string): string {
  const r = db.prepare("SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS n FROM review_findings WHERE chat_id = ?").get(chatId) as { n: number | null };
  return `F-${String((r.n ?? 0) + 1).padStart(3, '0')}`;
}

/**
 * Raise findings: each one gets a stable id and starts `open`. Returns the
 * findings with their ids filled in, in the order given.
 */
export function raiseFindings(chatId: string, taskSeq: number, round: number, items: Finding[]): Finding[] {
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO review_findings (chat_id, id, task_seq, round, severity, category, title, file, line, detail, evidence, recommendation, state, repair_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`);
  return db.transaction(() => items.map((f) => {
    const id = f.id ?? nextId(chatId);
    ins.run(chatId, id, taskSeq, round, f.severity, f.category ?? null, f.title, f.file ?? null, f.line ?? null, f.detail, f.evidence ?? null, f.recommendation ?? null, now);
    return { ...f, id };
  }))();
}

/** the Builder answered: state follows the disposition; an accepted finding's repair is now a claim */
export function applyDispositions(chatId: string, items: FindingResponse[]): void {
  const up = db.prepare(`UPDATE review_findings SET state = ?, disposition = ?, disposition_reason = ?, disposition_evidence = ?, repair_status = ?, updated_at = ? WHERE chat_id = ? AND id = ?`);
  const now = Date.now();
  db.transaction(() => {
    for (const r of items) {
      if (!r.id) continue;
      const repairs = r.disposition === 'accepted' || r.disposition === 'partially_accepted';
      up.run(r.disposition, r.disposition, r.reason, r.evidence ?? null, repairs ? 'claimed' : null, now, chatId, r.id);
    }
  })();
}

/** the Director decided: state and blocking follow the decision; an upheld finding's repair becomes pending */
export function applyArbitration(chatId: string, items: ArbitrationItem[], opts: { final: boolean }): void {
  const up = db.prepare(`UPDATE review_findings SET state = ?, arbitration_decision = ?, arbitration_reason = ?, arbitration_required = ?, blocking = ?, repair_status = COALESCE(?, repair_status), updated_at = ? WHERE chat_id = ? AND id = ?`);
  const now = Date.now();
  db.transaction(() => {
    for (const a of items) {
      if (!a.id) continue;
      const state = stateForDecision(a.decision);
      const requiresChange = a.decision === 'reviewer_upheld' || a.decision === 'different_resolution_required';
      // in the final decision nothing is repaired again: an upheld finding just stands blocking
      const repair: RepairStatus | null = requiresChange && !opts.final ? 'pending' : null;
      up.run(state ?? a.decision, a.decision, a.reason, a.required ?? null, a.blocking ? 1 : 0, repair, now, chatId, a.id);
    }
  })();
}

function stateForDecision(d: ArbitrationDecision): FindingState | null {
  switch (d) {
    case 'builder_upheld': return 'builder_upheld';
    case 'reviewer_upheld': return 'reviewer_upheld';
    case 'non_blocking': return 'non_blocking';
    case 'deferred': return 'deferred';
    case 'different_resolution_required': return 'different_resolution_required';
    default: return null; // unresolved: the state it had stands
  }
}

/** the Builder made (or re-made) a repair for these findings; verified or not is decided later */
export function markRepairClaimed(chatId: string, ids: string[], status: 'claimed' | 'unverified'): void {
  const up = db.prepare('UPDATE review_findings SET repair_status = ?, updated_at = ? WHERE chat_id = ? AND id = ?');
  const now = Date.now();
  db.transaction(() => { for (const id of ids) up.run(status, now, chatId, id); })();
}

/** the Reviewer confirmed a repair: the finding is resolved, and what showed it is kept */
export function markVerified(chatId: string, items: { id: string; evidence?: string }[]): void {
  const up = db.prepare("UPDATE review_findings SET state = 'resolved', repair_status = 'verified', blocking = 0, resolution_evidence = COALESCE(NULLIF(?, ''), resolution_evidence), updated_at = ? WHERE chat_id = ? AND id = ?");
  const now = Date.now();
  db.transaction(() => { for (const it of items) up.run(it.evidence ?? '', now, chatId, it.id); })();
}

/** objective verification showed the repair did not work: the SAME finding, reopened */
export function markRepairFailed(chatId: string, items: { id: string; evidence: string }[]): void {
  const up = db.prepare("UPDATE review_findings SET state = 'repair_failed', repair_status = 'failed', evidence = CASE WHEN ? = '' THEN evidence ELSE ? END, updated_at = ? WHERE chat_id = ? AND id = ?");
  const now = Date.now();
  db.transaction(() => { for (const f of items) up.run(f.evidence, `${f.evidence}`, now, chatId, f.id); })();
}

/** a later round restated a known finding instead of raising something new — counted, not re-created */
export function markRestated(chatId: string, ids: string[]): void {
  const up = db.prepare('UPDATE review_findings SET restated = restated + 1, updated_at = ? WHERE chat_id = ? AND id = ?');
  const now = Date.now();
  db.transaction(() => { for (const id of ids) up.run(now, chatId, id); })();
}

/** findings the Director has closed for this task, for the next round's "do not reopen" list */
export function closedFindings(chatId: string, taskSeq: number): ReviewFindingRecord[] {
  return listFindings(chatId, taskSeq).filter((f) => ['builder_upheld', 'non_blocking', 'deferred'].includes(f.state));
}

/** findings that still stand open in some way after the loop — what the Director's final decision is about */
export function unsettledFindings(chatId: string, taskSeq: number): ReviewFindingRecord[] {
  return listFindings(chatId, taskSeq).filter((f) => !['resolved', 'builder_upheld', 'non_blocking', 'deferred'].includes(f.state));
}

export function dispositionOf(f: ReviewFindingRecord): FindingDisposition | null { return f.disposition; }
