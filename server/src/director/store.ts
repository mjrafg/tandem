import { randomUUID } from 'node:crypto';
import type {
  PdActivity, PdMilestone, PdSession, PdSessionStatus, ProjectRun, ProjectRunState,
} from '../../../shared/types';
import { db } from '../db';
import { broadcast } from '../sse';
import { getAgentSnapshot } from '../agents/store';
import { signalRunState } from '../observability/signals';
import { getPendingWake } from './pendingWake';

/**
 * Persistence for the Project Director. Everything here is project-level
 * ORCHESTRATION state — plans, milestones, session assignments, decisions,
 * activity. The sessions themselves are ordinary Tandem chats referenced by
 * chat_id; nothing owned by the session system is duplicated.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS project_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New project',
  goal TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'PLANNING',
  integration_branch TEXT,
  plan_summary TEXT,
  plan_review_round INTEGER NOT NULL DEFAULT 0,
  pending_recovery TEXT,
  live_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pd_milestones (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES project_runs(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  order_idx INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS pd_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES project_runs(id),
  milestone_id TEXT NOT NULL REFERENCES pd_milestones(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  depends_on TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  cwd TEXT,
  result_summary TEXT,
  review_verdict TEXT,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS pd_activity (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES project_runs(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_pd_milestones_run ON pd_milestones(run_id);
CREATE INDEX IF NOT EXISTS idx_pd_sessions_run ON pd_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_pd_activity_run ON pd_activity(run_id, ts);
`);
try { db.exec('ALTER TABLE pd_sessions ADD COLUMN last_baseline_seq INTEGER'); } catch { /* exists */ }
try { db.exec('ALTER TABLE project_runs ADD COLUMN base_branch TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE pd_sessions ADD COLUMN stop_reason TEXT'); } catch { /* exists */ }
// awaiting_review: why the required review is waiting, and when it retries
try { db.exec('ALTER TABLE pd_sessions ADD COLUMN review_wait_reason TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE pd_sessions ADD COLUMN review_retry_at INTEGER'); } catch { /* exists */ }
// the Builder Agent profile the Director selected for this session (stable id)
try { db.exec('ALTER TABLE pd_sessions ADD COLUMN agent_profile_id TEXT'); } catch { /* exists */ }
// auto-resume after a restart: how many boots in a row relaunched this run, and
// when the last one was. Only ever read to detect a restart LOOP.
try { db.exec('ALTER TABLE project_runs ADD COLUMN auto_resume_streak INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE project_runs ADD COLUMN auto_resume_at INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

// ---------------------------------------------------------------- mapping

function rowToSession(r: any): PdSession {
  return {
    id: r.id, runId: r.run_id, milestoneId: r.milestone_id,
    key: r.key, name: r.name, purpose: r.purpose, prompt: r.prompt,
    chatId: r.chat_id ?? null, status: r.status,
    agentProfileId: r.agent_profile_id ?? null,
    // the truthful execution history: what this session ACTUALLY ran with
    agent: r.chat_id ? getAgentSnapshot(r.chat_id) : null,
    dependsOn: JSON.parse(r.depends_on || '[]'),
    branch: r.branch ?? null, cwd: r.cwd ?? null,
    lastBaselineSeq: r.last_baseline_seq ?? null,
    stopReason: (r.stop_reason as PdSession['stopReason']) ?? null,
    resultSummary: r.result_summary ?? null,
    reviewVerdict: (r.review_verdict as PdSession['reviewVerdict']) ?? null,
    reviewWait: r.review_wait_reason && r.review_retry_at
      ? { reason: r.review_wait_reason, retryAt: r.review_retry_at }
      : null,
    startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null,
  };
}

function rowToMilestone(r: any): PdMilestone {
  return {
    id: r.id, runId: r.run_id, key: r.key, name: r.name,
    goal: r.goal, acceptance: r.acceptance, status: r.status,
    orderIdx: r.order_idx, dependsOn: JSON.parse(r.depends_on || '[]'),
    sessions: db.prepare('SELECT * FROM pd_sessions WHERE milestone_id = ? ORDER BY key').all(r.id).map(rowToSession),
  };
}

export function getRun(id: string): ProjectRun | null {
  const r = db.prepare('SELECT * FROM project_runs WHERE id = ?').get(id) as any;
  if (!r) return null;
  return {
    id: r.id, projectId: r.project_id, chatId: r.chat_id,
    title: r.title, goal: r.goal, state: r.state,
    integrationBranch: r.integration_branch ?? null,
    planSummary: r.plan_summary ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    milestones: db.prepare('SELECT * FROM pd_milestones WHERE run_id = ? ORDER BY order_idx').all(r.id).map(rowToMilestone),
    // surfaced so a stalled-looking project can say WHY it is waiting and until when
    providerWait: (() => { const w = getPendingWake(r.id); return w ? { reason: w.reason, retryAt: w.retryAt } : null; })(),
  };
}

export function getRunRaw(id: string): any {
  return db.prepare('SELECT * FROM project_runs WHERE id = ?').get(id);
}

export function runForChat(chatId: string): ProjectRun | null {
  const r = db.prepare('SELECT id FROM project_runs WHERE chat_id = ?').get(chatId) as any;
  return r ? getRun(r.id) : null;
}

export function broadcastRun(runId: string): void {
  const run = getRun(runId);
  if (run) broadcast({ type: 'project_run', run });
}

// ---------------------------------------------------------------- run CRUD

export function createRun(projectId: string, chatId: string, goal: string): ProjectRun {
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO project_runs (id, project_id, chat_id, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, chatId, goal, now, now);
  return getRun(id)!;
}

export function patchRun(id: string, patch: Record<string, unknown>): void {
  const allowed = ['title', 'goal', 'state', 'integration_branch', 'base_branch', 'plan_summary', 'plan_review_round', 'pending_recovery', 'live_event_id'];
  const sets = Object.keys(patch).filter((k) => allowed.includes(k));
  if (sets.length === 0) return;
  db.prepare(`UPDATE project_runs SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...sets.map((k) => patch[k]), Date.now(), id);
  broadcastRun(id);
}

export function setRunState(id: string, state: ProjectRunState, note?: string): void {
  patchRun(id, { state });
  addActivity(id, 'state', note ?? `Project state → ${state}`);
  // persist first, notify second: the state and its activity row are committed
  // above, so an Observability consumer that fetches immediately sees them
  signalRunState(id, state);
}

// ---------------------------------------------------------------- plan

/** Validate keys/deps and detect cycles; throws with a precise reason. */
function validateDag<T extends { key: string; dependsOn: string[] }>(items: T[], what: string): void {
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== items.length) throw new Error(`Duplicate ${what} keys.`);
  for (const i of items) {
    for (const d of i.dependsOn) {
      if (d === i.key) throw new Error(`${what} ${i.key} depends on itself.`);
      if (!keys.has(d)) throw new Error(`${what} ${i.key} depends on unknown key ${d}.`);
    }
  }
  // Kahn's algorithm — leftovers mean a cycle
  const indeg = new Map(items.map((i) => [i.key, i.dependsOn.length]));
  const queue = items.filter((i) => i.dependsOn.length === 0).map((i) => i.key);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift()!;
    seen += 1;
    for (const i of items) {
      if (i.dependsOn.includes(k)) {
        const left = indeg.get(i.key)! - 1;
        indeg.set(i.key, left);
        if (left === 0) queue.push(i.key);
      }
    }
  }
  if (seen !== items.length) throw new Error(`Dependency cycle detected among ${what}s.`);
}

export interface MilestoneInput { key: string; name: string; goal: string; acceptance: string; dependsOn: string[] }

/** Replace the milestone plan. Milestones that already have sessions are kept (matched by key). */
export function setPlan(runId: string, milestones: MilestoneInput[], summary: string): void {
  validateDag(milestones, 'milestone');
  const existing = db.prepare('SELECT * FROM pd_milestones WHERE run_id = ?').all(runId) as any[];
  const byKey = new Map(existing.map((m) => [m.key, m]));
  const keepKeys = new Set(milestones.map((m) => m.key));
  for (const old of existing) {
    if (!keepKeys.has(old.key)) {
      const hasSessions = db.prepare('SELECT COUNT(*) c FROM pd_sessions WHERE milestone_id = ?').get(old.id) as any;
      if (hasSessions.c > 0) throw new Error(`Milestone ${old.key} already has sessions and cannot be dropped — mark it complete or keep it in the plan.`);
      db.prepare('DELETE FROM pd_milestones WHERE id = ?').run(old.id);
    }
  }
  milestones.forEach((m, idx) => {
    const old = byKey.get(m.key);
    if (old) {
      // dependencies of a milestone already past 'planned' are frozen — rewiring
      // them retroactively would invalidate ordering the engine already enforced
      if (old.status !== 'planned' && JSON.stringify(m.dependsOn) !== old.depends_on) {
        throw new Error(`Milestone ${m.key} is ${old.status} — its dependencies can no longer change. Revise its goal/acceptance, or restructure via NEW milestones instead.`);
      }
      db.prepare('UPDATE pd_milestones SET name = ?, goal = ?, acceptance = ?, order_idx = ?, depends_on = ? WHERE id = ?')
        .run(m.name, m.goal, m.acceptance, idx, JSON.stringify(m.dependsOn), old.id);
    } else {
      db.prepare('INSERT INTO pd_milestones (id, run_id, key, name, goal, acceptance, status, order_idx, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), runId, m.key, m.name, m.goal, m.acceptance, 'planned', idx, JSON.stringify(m.dependsOn));
    }
  });
  patchRun(runId, { plan_summary: summary });
}

export interface SessionInput {
  key: string; name: string; purpose: string; prompt: string; dependsOn: string[]; isolated: boolean;
  /** stable Builder Agent profile id chosen by the Director (never a slug) */
  agentProfileId?: string | null;
}

/** Define (or extend) the session plan for one milestone. Existing sessions are kept by key. */
export function planSessions(runId: string, milestoneKey: string, sessions: SessionInput[]): PdMilestone {
  const ms = db.prepare('SELECT * FROM pd_milestones WHERE run_id = ? AND key = ?').get(runId, milestoneKey) as any;
  if (!ms) throw new Error(`Unknown milestone: ${milestoneKey}`);
  const existing = db.prepare('SELECT * FROM pd_sessions WHERE milestone_id = ?').all(ms.id) as any[];
  const byKey = new Map(existing.map((s) => [s.key, s]));
  const merged = [
    ...existing.filter((s) => !sessions.some((n) => n.key === s.key)).map((s) => ({ key: s.key, dependsOn: JSON.parse(s.depends_on || '[]') })),
    ...sessions.map((s) => ({ key: s.key, dependsOn: s.dependsOn })),
  ];
  validateDag(merged, 'session');
  for (const s of sessions) {
    const old = byKey.get(s.key);
    if (old) {
      if (old.status !== 'planned' && old.status !== 'abandoned') {
        throw new Error(`Session ${s.key} is ${old.status} and its definition can no longer be replaced — use recover_session instead.`);
      }
      db.prepare('UPDATE pd_sessions SET name = ?, purpose = ?, prompt = ?, depends_on = ?, status = ?, agent_profile_id = ? WHERE id = ?')
        .run(s.name, s.purpose, s.prompt, JSON.stringify(s.dependsOn), 'planned', s.agentProfileId ?? null, old.id);
    } else {
      db.prepare(`INSERT INTO pd_sessions (id, run_id, milestone_id, key, name, purpose, prompt, status, depends_on, branch, agent_profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`)
        .run(randomUUID(), runId, ms.id, s.key, s.name, s.purpose, s.prompt, JSON.stringify(s.dependsOn), s.isolated ? `pd/${s.key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null, s.agentProfileId ?? null);
    }
  }
  broadcastRun(runId);
  return rowToMilestone(db.prepare('SELECT * FROM pd_milestones WHERE id = ?').get(ms.id));
}

// ---------------------------------------------------------------- sessions

export function getSession(runId: string, key: string): PdSession | null {
  const r = db.prepare('SELECT * FROM pd_sessions WHERE run_id = ? AND key = ?').get(runId, key) as any;
  return r ? rowToSession(r) : null;
}

export function sessionForChat(chatId: string): PdSession | null {
  const r = db.prepare('SELECT * FROM pd_sessions WHERE chat_id = ?').get(chatId) as any;
  return r ? rowToSession(r) : null;
}

/**
 * The canonical visible title of a Director session chat: milestone and
 * session keys come from PD metadata (never from the model); the model only
 * ever contributes the short descriptive part.
 */
export function canonicalSessionTitle(session: PdSession, name: string): string {
  const ms = db.prepare('SELECT key FROM pd_milestones WHERE id = ?').get(session.milestoneId) as any;
  const clean = name.replace(/\s+/g, ' ').replace(/["'`]/g, '').trim().slice(0, 48);
  return `${ms?.key ?? '?'} - ${session.key} - ${clean || session.name.slice(0, 48)}`.slice(0, 80);
}

/** Prefix that marks a session chat as already canonically titled. */
export function sessionTitlePrefix(session: PdSession): string {
  const ms = db.prepare('SELECT key FROM pd_milestones WHERE id = ?').get(session.milestoneId) as any;
  return `${ms?.key ?? '?'} - ${session.key} - `;
}

export function patchSession(runId: string, key: string, patch: Partial<{
  chatId: string; status: PdSessionStatus; branch: string | null; cwd: string;
  resultSummary: string; reviewVerdict: string; startedAt: number; endedAt: number; prompt: string;
  lastBaselineSeq: number; stopReason: 'user_stop' | 'project_pause' | 'restart' | 'provider_outage' | null;
  reviewWaitReason: string | null; reviewRetryAt: number | null; agentProfileId: string | null;
}>): void {
  const map: Record<string, string> = {
    chatId: 'chat_id', status: 'status', branch: 'branch', cwd: 'cwd',
    resultSummary: 'result_summary', reviewVerdict: 'review_verdict',
    startedAt: 'started_at', endedAt: 'ended_at', prompt: 'prompt',
    lastBaselineSeq: 'last_baseline_seq', stopReason: 'stop_reason',
    reviewWaitReason: 'review_wait_reason', reviewRetryAt: 'review_retry_at',
    agentProfileId: 'agent_profile_id',
  };
  const sets = Object.keys(patch).filter((k) => k in map);
  if (sets.length === 0) return;
  db.prepare(`UPDATE pd_sessions SET ${sets.map((k) => `${map[k]} = ?`).join(', ')} WHERE run_id = ? AND key = ?`)
    .run(...sets.map((k) => (patch as any)[k]), runId, key);
  broadcastRun(runId);
}

/** engine invariant: every dependency of this session is completed */
export function depsSatisfied(runId: string, key: string): { ok: boolean; missing: string[] } {
  const s = getSession(runId, key);
  if (!s) return { ok: false, missing: [key] };
  const missing = s.dependsOn.filter((d) => getSession(runId, d)?.status !== 'completed');
  return { ok: missing.length === 0, missing };
}

export function sessionsByStatus(runId: string, statuses: PdSessionStatus[]): PdSession[] {
  const rows = db.prepare(`SELECT * FROM pd_sessions WHERE run_id = ? AND status IN (${statuses.map(() => '?').join(',')})`)
    .all(runId, ...statuses) as any[];
  return rows.map(rowToSession);
}

export function milestoneByKey(runId: string, key: string): PdMilestone | null {
  const r = db.prepare('SELECT * FROM pd_milestones WHERE run_id = ? AND key = ?').get(runId, key) as any;
  return r ? rowToMilestone(r) : null;
}

export function patchMilestone(runId: string, key: string, patch: { status?: string }): void {
  if (patch.status) {
    db.prepare('UPDATE pd_milestones SET status = ? WHERE run_id = ? AND key = ?').run(patch.status, runId, key);
    broadcastRun(runId);
  }
}

// ---------------------------------------------------------------- activity

export function addActivity(runId: string, kind: PdActivity['kind'], text: string, detail?: string): void {
  db.prepare('INSERT INTO pd_activity (id, run_id, ts, kind, text, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), runId, Date.now(), kind, text.slice(0, 500), detail?.slice(0, 4_000) ?? null);
  broadcastRun(runId);
}

export function listActivity(runId: string, limit = 200): PdActivity[] {
  return (db.prepare('SELECT * FROM pd_activity WHERE run_id = ? ORDER BY ts DESC LIMIT ?').all(runId, limit) as any[])
    .map((r) => ({ id: r.id, runId: r.run_id, ts: r.ts, kind: r.kind, text: r.text, detail: r.detail ?? null }));
}

/** The run's COMPLETE activity log, oldest first — no cap, for evidence export. */
export function listAllActivity(runId: string): PdActivity[] {
  return (db.prepare('SELECT * FROM pd_activity WHERE run_id = ? ORDER BY ts, id').all(runId) as any[])
    .map((r) => ({ id: r.id, runId: r.run_id, ts: r.ts, kind: r.kind, text: r.text, detail: r.detail ?? null }));
}

export function listRuns(): ProjectRun[] {
  return (db.prepare('SELECT id FROM project_runs ORDER BY updated_at DESC').all() as any[])
    .map((r) => getRun(r.id)!)
    .filter(Boolean);
}

/**
 * How soon after the previous boot a restart still looks like a crash loop.
 *
 * This is deliberately near the systemd cadence (Restart=always, RestartSec=2),
 * NOT a generous few minutes: the gap between two boots is essentially how long
 * the previous boot survived, so a small value asks "did the last boot die
 * almost immediately?" — the only question worth asking. A deploy cadence, even
 * a fast one, leaves gaps far larger than this and never counts.
 */
export const AUTO_RESUME_WINDOW_MS = 90_000;

/**
 * Count this boot's auto-resume and return the current consecutive streak.
 *
 * The comparison is against the PREVIOUS auto-resume, so this measures a chain
 * of short-lived boots rather than a fixed window — which is what a crash loop
 * actually is. A single gap wider than the window breaks the chain and the
 * streak restarts at 1. Persisted, because the whole point is to survive the
 * restart being counted.
 */
export function bumpAutoResumeStreak(runId: string, now: number): number {
  const r = db.prepare('SELECT auto_resume_streak AS n, auto_resume_at AS at FROM project_runs WHERE id = ?').get(runId) as any;
  const streak = r && r.at > 0 && now - r.at <= AUTO_RESUME_WINDOW_MS ? (r.n ?? 0) + 1 : 1;
  db.prepare('UPDATE project_runs SET auto_resume_streak = ?, auto_resume_at = ? WHERE id = ?').run(streak, now, runId);
  return streak;
}

/** A human took over (manual resume): the loop counter starts fresh. */
export function resetAutoResumeStreak(runId: string): void {
  db.prepare('UPDATE project_runs SET auto_resume_streak = 0, auto_resume_at = 0 WHERE id = ?').run(runId);
}

// ---------------------------------------------------------------- snapshots

/** Truncate for the state VIEW — always visibly marked, never silent. */
function view(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} …[truncated for this view]` : s;
}

/**
 * Milestone deps that are not completed yet — the engine invariant behind
 * "a dependent milestone cannot start before its predecessors are done".
 */
export function milestoneDepsOpen(runId: string, msKey: string): string[] {
  const ms = milestoneByKey(runId, msKey);
  if (!ms) return [msKey];
  return ms.dependsOn.filter((d) => milestoneByKey(runId, d)?.status !== 'completed');
}

/** Milestones not yet completed (for the completion gate). */
export function openMilestones(runId: string): string[] {
  return (db.prepare("SELECT key FROM pd_milestones WHERE run_id = ? AND status != 'completed' ORDER BY order_idx").all(runId) as any[])
    .map((r) => r.key);
}

/**
 * FULL-FIDELITY plan document for independent review. Reviews must judge the
 * actual plan — never the display-truncated state snapshot (both real runs
 * lost a review round to snapshot truncation artifacts before this existed).
 */
export function planDocument(runId: string): string {
  const run = getRun(runId);
  if (!run) return '(project run not found)';
  const lines: string[] = [`# Project goal (complete, as given by the user)\n${run.goal}`];
  if (run.planSummary) lines.push(`\n# Plan summary\n${run.planSummary}`);
  lines.push('\n# Milestones');
  for (const m of run.milestones) {
    lines.push(`\n${m.key} — ${m.name}${m.dependsOn.length ? ` (after ${m.dependsOn.join(', ')})` : ''}`);
    lines.push(`Goal: ${m.goal}`);
    if (m.acceptance) lines.push(`Acceptance: ${m.acceptance}`);
  }
  return lines.join('\n');
}

/** Compact, engine-generated state snapshot handed to the Director each turn. */
export function stateSnapshot(runId: string): string {
  const run = getRun(runId);
  if (!run) return '(project run not found)';
  const lines: string[] = [
    `Run state: ${run.state}${run.integrationBranch ? ` · integration branch: ${run.integrationBranch}` : ''}`,
    `Goal: ${view(run.goal, 1_200)}`,
  ];
  if (run.milestones.length === 0) {
    lines.push('No milestone plan yet — produce one with project_set_plan.');
  }
  for (const m of run.milestones) {
    lines.push(`\n${m.key} — ${m.name} [${m.status}]${m.dependsOn.length ? ` (after ${m.dependsOn.join(', ')})` : ''}`);
    lines.push(`  goal: ${view(m.goal, 200)}`);
    if (m.acceptance) lines.push(`  acceptance: ${view(m.acceptance, 200)}`);
    for (const s of m.sessions) {
      const dep = s.dependsOn.length ? ` deps:[${s.dependsOn.join(',')}]` : '';
      const extras = [
        s.branch ? `branch ${s.branch}` : 'shared dir',
        // what it ran with (snapshot), or what it will run with (selection)
        s.agent ? `agent ${s.agent.profileName} (${s.agent.model} · ${s.agent.effort})`
          : s.agentProfileId ? `agent ${s.agentProfileId}` : '',
        s.status === 'paused' && s.stopReason
          ? (s.stopReason === 'user_stop' ? 'stopped by the user'
            : s.stopReason === 'restart' ? 'interrupted by a Tandem restart (not a deliberate stop)'
              : s.stopReason === 'provider_outage' ? 'stopped by a provider usage limit, work preserved — NOT a failure, resume it rather than rebuilding'
                : 'stopped by project pause')
          : '',
        s.status === 'awaiting_review' && s.reviewWait
          ? `implementation done, required review NOT run (${s.reviewWait.reason}); retries automatically at ${new Date(s.reviewWait.retryAt).toISOString().slice(11, 16)} UTC — not complete, dependents stay blocked`
          : '',
        s.resultSummary ? `result: ${s.resultSummary.slice(0, 120)}` : '',
        s.reviewVerdict ? `review: ${s.reviewVerdict}` : '',
      ].filter(Boolean).join(' · ');
      lines.push(`  ${s.key} ${s.name} [${s.status}]${dep} — ${extras}`);
    }
  }
  const recent = listActivity(runId, 8).reverse();
  if (recent.length) {
    lines.push('\nRecent project activity:');
    for (const a of recent) lines.push(`  ${new Date(a.ts).toISOString().slice(11, 16)} ${a.text}`);
  }
  return lines.join('\n');
}
