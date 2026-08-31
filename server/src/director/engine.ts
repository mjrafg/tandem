import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Chat, PdSession, ProjectRun, SessionsPayload } from '../../../shared/types';
import { config } from '../config';
import { db, getBuilderSession, getChat, getEvent, getProject, rowToChat, setGitStateRow } from '../db';
import { addEvent, broadcastChat, deriveTitle, setChatRunning, setChatTitle, updateEvent } from '../events';
import { directorSystemText, getPrompt, renderPrompt } from '../prompts';
import { getSettings } from '../settings';
import { findOrCreateProject } from '../projectRoutes';
import { runClaudeTurn } from '../engine/claude';
import { runCodexReview } from '../engine/codex';
import { RunHandle, type RunCtx, isRunning, registerCtx, releaseCtx, repoBusyBy, stopRun } from '../engine/run';
import { computeUsage } from '../context';
import { performNativeCompaction } from '../engine/providerContext';
import { parseVerdict, startRun } from '../engine/workflow';
import {
  addActivity, broadcastRun, canonicalSessionTitle, createRun, depsSatisfied, getRun, getRunRaw,
  getSession, listRuns, milestoneByKey, milestoneDepsOpen, openMilestones, patchMilestone, patchRun,
  patchSession, planDocument, planSessions, runForChat, sessionTitlePrefix, sessionsByStatus,
  setPlan, setRunState, stateSnapshot, type MilestoneInput, type SessionInput,
} from './store';

/**
 * The Project Director engine.
 *
 * The Director is an AI (a Claude session on the Project Chat) that operates
 * Tandem's EXISTING session system from above — it defines work, launches
 * ordinary chats through the same startRun used by a human's message, watches
 * their outcomes, and reacts. This engine enforces the deterministic
 * invariants (dependencies, cycles, branch isolation, serialized shared
 * directories, the two-review policy) and executes the Director's tool calls;
 * every judgment call stays with the AI.
 */

const DIRECTOR_TIMEOUT = 15 * 60_000;
const REVIEW_TIMEOUT = 15 * 60_000;
const DEFAULT_SESSION_TIMEOUT_MIN = 30;
const MAX_SESSION_TIMEOUT_MIN = 90;
const POLL_MS = 5_000;

// ---------------------------------------------------------------- run creation

export function createProjectRun(dirPath: string): { run: ProjectRun; chat: Chat } {
  const project = findOrCreateProject(dirPath, 'directory');
  const chatId = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO chats (id, project_id, title, created_at, updated_at, running, kind) VALUES (?, ?, 'New project', ?, ?, 0, 'project')`)
    .run(chatId, project.id, now, now);
  const run = createRun(project.id, chatId, '');
  db.prepare('UPDATE chats SET project_run_id = ? WHERE id = ?').run(run.id, chatId);
  addActivity(run.id, 'state', 'Project run created');
  const chat = rowToChat(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId));
  broadcastChat(chatId);
  return { run, chat };
}

// ---------------------------------------------------------------- director turns

interface TurnState { busy: boolean; queued: { text: string; isObservation: boolean }[] }
const turns = new Map<string, TurnState>();

function turnState(runId: string): TurnState {
  let t = turns.get(runId);
  if (!t) { t = { busy: false, queued: [] }; turns.set(runId, t); }
  return t;
}

/** A user message in the Project Chat — the same entry point as normal chats. */
export function directorUserMessage(chat: Chat, text: string): void {
  const run = runForChat(chat.id);
  if (!run) return;
  // the goal is the project's authoritative brief: reviews and post-restart
  // turns are rendered from it, so it must never be silently mutilated (a
  // 2k slice once fed a plan reviewer a brief missing the user's own mandate)
  if (!getRunRaw(run.id).goal) patchRun(run.id, { goal: text.slice(0, 24_000) });
  if (run.state === 'NEEDS_USER') setRunState(run.id, 'RUNNING', 'User replied — continuing');
  void pumpDirector(run.id, text, 'user');
}

export function queueObservation(runId: string, text: string): void {
  // a paused project gets NO automatic orchestration wake — everything the
  // Director needs is in the persisted state it reads when the user resumes
  const state = getRunRaw(runId)?.state;
  if (state === 'PAUSING' || state === 'PAUSED') return;
  void pumpDirector(runId, text, 'observation');
}

/**
 * Serialize Director turns per run: concurrent triggers queue up and are
 * delivered together in the next turn.
 */
async function pumpDirector(runId: string, message: string, kind: 'user' | 'observation'): Promise<void> {
  const t = turnState(runId);
  const wrapped = kind === 'observation' ? `- ${message}` : message;
  if (t.busy) {
    t.queued.push({ text: wrapped, isObservation: kind === 'observation' });
    return;
  }
  t.busy = true;
  try {
    let next: { text: string; isObservation: boolean } | null = {
      text: kind === 'observation' ? renderPrompt('director.observation', { observations: wrapped }) : message,
      isObservation: kind === 'observation',
    };
    while (next) {
      await runDirectorTurn(runId, next.text);
      await processAfterTurn(runId);
      // compact only when nothing is waiting — a queued observation (a failed
      // session needing a decision) must never sit behind a multi-minute compact
      if (t.queued.length === 0) await directorAutoCompact(runId);
      const queued = t.queued.splice(0);
      // the enqueue-time pause guard cannot see items parked behind a busy
      // turn — re-check at DRAIN time and drop stale auto-wakes, keeping only
      // the user's own words for the Director to answer
      const frozen = ['PAUSING', 'PAUSED'].includes(getRunRaw(runId)?.state);
      const keep = frozen ? queued.filter((q) => !q.isObservation) : queued;
      next = keep.length > 0
        ? { text: renderPrompt('director.observation', { observations: keep.map((q) => q.text).join('\n') }), isObservation: true }
        : null;
    }
  } finally {
    t.busy = false;
  }
}

/** chats whose last native compaction failed → don't hammer it every turn */
const compactFailedAt = new Map<string, number>();
const COMPACT_RETRY_COOLDOWN = 15 * 60_000;

/**
 * The Director chat follows the same threshold/auto-compact policy as every
 * other chat (settings.context), run between serialized turns — the only point
 * where nothing can race the Director's own resumed session. Runs inside the
 * pump, so it stays awaited; a failed attempt backs off instead of repeating
 * (and re-erroring) after every subsequent turn.
 */
async function directorAutoCompact(runId: string): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.context.autoCompact) return;
    const chatId = getRunRaw(runId)?.chat_id as string | undefined;
    if (!chatId) return;
    const chat = getChat(chatId);
    if (!chat || isRunning(chatId)) return;
    const usage = computeUsage(chat);
    if (usage.pct == null || usage.pct < settings.context.compactPct) return;
    if ((compactFailedAt.get(chatId) ?? 0) > Date.now() - COMPACT_RETRY_COOLDOWN) return;
    const outcome = await performNativeCompaction(chat, 'auto'); // emits its own compaction/error events
    if (outcome.ok) compactFailedAt.delete(chatId);
    else compactFailedAt.set(chatId, Date.now());
  } catch (err) {
    const chatId = getRunRaw(runId)?.chat_id as string | undefined;
    if (chatId) {
      compactFailedAt.set(chatId, Date.now());
      addEvent(chatId, 'error', { message: 'Automatic native compaction failed', detail: String(err), source: 'context' });
    }
  }
}

/** One real Claude turn for the Director on the Project Chat. */
async function runDirectorTurn(runId: string, message: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const chat = getChat(run.chatId);
  const project = getProject(chat?.projectId ?? '');
  if (!chat || !project) return;
  if (isRunning(chat.id)) return; // a turn is already live (belt and braces)

  const settings = getSettings();
  // no rootPath in the ctx: Director turns may run while sessions hold the
  // repository. That is safe because the turn is ENFORCED read-only (mutation
  // tools denied; bwrap jail where available) — it observes, it cannot write.
  const ctx: RunCtx = { chatId: chat.id, runId: randomUUID(), stopped: false };
  registerCtx(ctx);
  setChatRunning(chat.id, true);
  try {
    const state = renderPrompt('director.state', { project_state: stateSnapshot(runId) });
    const result = await runClaudeTurn(new RunHandle(ctx, chat, project, []), {
      role: 'director',
      model: settings.roles.builder.model,
      effort: settings.roles.builder.effort,
      systemAppendix: directorSystemText(settings),
      message: `${state}\n\n${message}`,
      cwd: project.rootPath,
      resumeSessionId: getBuilderSession(chat.id),
      withDirectorTools: true,
      readOnly: true,
      timeoutMs: DIRECTOR_TIMEOUT,
    });
    if (result.sessionId) {
      db.prepare('UPDATE chats SET builder_session_id = ?, builder_session_provider = ? WHERE id = ?')
        .run(result.sessionId, 'claude-code', chat.id);
    }
    if (!result.ok && !result.stopped) {
      addEvent(chat.id, 'error', { message: 'Director call failed', detail: result.error, source: 'director', retryable: true });
    }
  } finally {
    releaseCtx(ctx);
    setChatRunning(chat.id, false);
  }
}

// ---------------------------------------------------------------- review plumbing

/** Run one independent review (the SAME Codex reviewer) on an orchestration artifact. */
async function reviewArtifact(runId: string, prompt: string, round: number): Promise<{ verdict: 'pass' | 'findings'; findingsText: string } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const chat = getChat(run.chatId);
  const project = getProject(chat?.projectId ?? '');
  if (!chat || !project) return null;
  const settings = getSettings();
  const ctx: RunCtx = { chatId: chat.id, runId: randomUUID(), stopped: false, phase: 'reviewer' };
  registerCtx(ctx);
  setChatRunning(chat.id, true);
  try {
    const h = new RunHandle(ctx, chat, project, []);
    h.status('Reviewer is checking the Director\'s plan/decision…');
    const result = await runCodexReview(h, {
      model: settings.roles.reviewer.model,
      effort: settings.roles.reviewer.effort,
      prompt: `${prompt}\n\n${getPrompt('reviewer.output_format')}`,
      cwd: project.rootPath,
      timeoutMs: REVIEW_TIMEOUT,
    });
    if (!result.ok) {
      addEvent(chat.id, 'error', { message: 'Reviewer could not run', detail: result.error, source: 'reviewer', retryable: true });
      return null;
    }
    const { verdict, items } = parseVerdict(result.text);
    addEvent(chat.id, 'findings', { verdict, round, items }, { runId: ctx.runId });
    const findingsText = items.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}\n   ${f.detail}${f.recommendation ? `\n   Recommendation: ${f.recommendation}` : ''}`).join('\n');
    return { verdict, findingsText };
  } finally {
    releaseCtx(ctx);
    setChatRunning(chat.id, false);
  }
}

/**
 * Post-turn processing: the review loops for plans and recovery decisions.
 * Same policy as sessions — at most two reviews, at most two repairs, and the
 * second repair proceeds WITHOUT a third review.
 */
async function processAfterTurn(runId: string): Promise<void> {
  const raw = getRunRaw(runId);
  if (!raw) return;
  // a terminal run reviews nothing and applies nothing — mirror the tool guard
  if (['COMPLETED', 'FAILED'].includes(raw.state)) {
    if (raw.plan_review_round > 0 || raw.pending_recovery) patchRun(runId, { plan_review_round: 0, pending_recovery: null });
    return;
  }
  // a paused run DEFERS its review loops: state is kept, nothing runs — the
  // next post-turn pass after Resume picks the loop up where it stood
  if (['PAUSING', 'PAUSED'].includes(raw.state)) return;

  // ---- master plan review loop
  if (raw.plan_review_round > 0 && raw.plan_review_round <= 3) {
    const run = getRun(runId)!;
    if (run.milestones.length === 0) return; // plan withdrawn; nothing to review
    const round = raw.plan_review_round as number;
    if (round === 3) {
      // second repair: proceeds without a third review — the policy's hard cap
      patchRun(runId, { plan_review_round: 0 });
      addActivity(runId, 'review', 'Plan revised twice — proceeding without a third review (review policy cap)');
      acceptPlan(runId);
      return;
    }
    // the reviewer judges the FULL plan and the FULL goal — never the
    // display-truncated snapshot (that artifact cost a review round twice)
    const review = await reviewArtifact(runId, renderPrompt('director.plan_review_request', {
      project_goal: run.goal, plan: planDocument(runId),
    }), round);
    if (!review) {
      addActivity(runId, 'review', 'Plan review could not run — plan proceeds unreviewed (reviewer unavailable)');
      patchRun(runId, { plan_review_round: 0 });
      acceptPlan(runId);
      return;
    }
    if (review.verdict === 'pass') {
      patchRun(runId, { plan_review_round: 0 });
      addActivity(runId, 'review', `Plan accepted by the independent reviewer (round ${round})`);
      acceptPlan(runId);
      return;
    }
    addActivity(runId, 'review', `Plan review round ${round}: findings returned`);
    patchRun(runId, { plan_review_round: round + 1 });
    const key = round === 1 ? 'director.plan_findings_message' : 'director.plan_final_message';
    await runDirectorTurn(runId, renderPrompt(key, { findings: review.findingsText }));
    await processAfterTurn(runId); // the resubmission bumped state; continue the loop
    return;
  }

  // ---- recovery decision review loop
  if (raw.pending_recovery) {
    let pending: any;
    try { pending = JSON.parse(raw.pending_recovery); } catch { patchRun(runId, { pending_recovery: null }); return; }
    const round = pending.round as number;
    if (round >= 3) {
      patchRun(runId, { pending_recovery: null });
      addActivity(runId, 'review', `Recovery for ${pending.sessionKey} revised twice — applying without a third review (review policy cap)`);
      await applyRecovery(runId, pending);
      return;
    }
    const review = await reviewArtifact(runId, renderPrompt('director.recovery_review_request', {
      session_context: pending.context ?? '(context unavailable)',
      decision: `Action: ${pending.action}\nReasoning: ${pending.reasoning}${pending.newPrompt ? `\nNew/updated session instructions:\n${pending.newPrompt}` : ''}${pending.extraMinutes ? `\nAdditional time: ${pending.extraMinutes} minutes` : ''}`,
    }), round);
    if (!review || review.verdict === 'pass') {
      patchRun(runId, { pending_recovery: null });
      addActivity(runId, 'review', review
        ? `Recovery decision for ${pending.sessionKey} accepted by the reviewer (round ${round})`
        : `Recovery review could not run — decision for ${pending.sessionKey} applied unreviewed (reviewer unavailable)`);
      await applyRecovery(runId, pending);
      return;
    }
    addActivity(runId, 'review', `Recovery review round ${round} for ${pending.sessionKey}: findings returned`);
    pending.round = round + 1;
    pending.awaitingRevision = true;
    patchRun(runId, { pending_recovery: JSON.stringify(pending) });
    const key = round === 1 ? 'director.recovery_findings_message' : 'director.recovery_final_message';
    await runDirectorTurn(runId, renderPrompt(key, { findings: review.findingsText }));
    await processAfterTurn(runId);
  }
}

function acceptPlan(runId: string): void {
  const raw = getRunRaw(runId);
  if (raw.state === 'PLANNING') {
    setRunState(runId, 'RUNNING', 'Master plan accepted — project is running');
    queueObservation(runId, 'The master plan passed the independent review. Tell the user, then begin: inspect the repository, plan the first ready milestone into sessions, and start the ones you judge ready.');
  } else {
    addActivity(runId, 'plan', 'Milestone plan revised');
    queueObservation(runId, 'Your revised milestone plan is accepted. Continue orchestration.');
  }
}

// ---------------------------------------------------------------- git helpers

function git(dir: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
    });
  });
}

async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--git-dir'], 8_000)).ok;
}

/** Ensure the run's integration branch exists (created at current HEAD, no switch). */
async function ensureIntegrationBranch(runId: string, rootPath: string): Promise<string> {
  const raw = getRunRaw(runId);
  if (raw.integration_branch) return raw.integration_branch;
  if (!(await isRepo(rootPath))) {
    throw new Error('The project directory is not a Git repository yet — first run a scaffolding session whose prompt initializes the repository (git init, baseline commit).');
  }
  const head = await git(rootPath, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) throw new Error('The repository has no commits yet — the scaffolding session must create a baseline commit first.');
  const name = 'pd/integration';
  // the branch we forked from is where the final result must be DELIVERED —
  // never one of Tandem's own scratch branches (tandem/<chat>) or pd/ branches
  const base = await git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = base.ok && base.stdout && base.stdout !== 'HEAD'
    && !base.stdout.startsWith('pd/') && !base.stdout.startsWith('tandem/')
    ? base.stdout : null;
  const exists = await git(rootPath, ['rev-parse', '--verify', `refs/heads/${name}`]);
  if (exists.ok) {
    // a leftover pd/integration from an EARLIER run: safe to adopt only when it
    // carries nothing beyond the current HEAD — otherwise delivering would ship
    // a previous run's undelivered commits as this run's work
    const contained = await git(rootPath, ['merge-base', '--is-ancestor', name, 'HEAD']);
    if (!contained.ok) {
      throw new Error(`A ${name} branch from a previous run exists and holds commits not in the current HEAD. Inspect it first: deliver or discard that work through a session (merge it into the intended branch or delete the branch), then continue.`);
    }
    const reset = await git(rootPath, ['branch', '-f', name, 'HEAD']);
    if (!reset.ok) throw new Error(`Could not reset the stale integration branch: ${reset.stderr}`);
  } else {
    const made = await git(rootPath, ['branch', name]);
    if (!made.ok) throw new Error(`Could not create the integration branch: ${made.stderr}`);
  }
  patchRun(runId, { integration_branch: name, ...(baseBranch ? { base_branch: baseBranch } : {}) });
  addActivity(runId, 'integration', `Integration branch ${name} established${baseBranch ? ` (delivers to ${baseBranch})` : ''}`);
  return name;
}

/**
 * Best-effort workspace cleanup at completion: session worktrees are removed
 * (their chats and history remain), fully-merged pd/ branches are deleted
 * (`-d` only — anything unmerged is deliberately left in place), and the
 * integration branch goes once the base branch contains it. Failures never
 * block completion.
 */
async function cleanupRunWorkspaces(runId: string, rootPath: string): Promise<void> {
  try {
    const run = getRun(runId);
    if (!run) return;
    const wtBase = path.join(config.dataDir, 'worktrees', runId.slice(0, 8));
    let removed = 0;
    for (const m of run.milestones) {
      for (const s of m.sessions) {
        // only COMPLETED sessions' worktrees — an abandoned session's uncommitted
        // work was promised recoverable, so its worktree is never force-removed —
        // and even a completed one keeps its worktree if anything is uncommitted
        if (s.status === 'completed' && s.cwd && s.cwd.startsWith(wtBase) && fs.existsSync(s.cwd)) {
          const dirty = await git(s.cwd, ['status', '--porcelain']);
          if (!dirty.ok || dirty.stdout) continue; // unknown or dirty → keep it
          const r = await git(rootPath, ['worktree', 'remove', s.cwd], 30_000);
          if (r.ok) removed += 1;
        }
      }
    }
    await git(rootPath, ['worktree', 'prune']);
    try { if (fs.existsSync(wtBase) && fs.readdirSync(wtBase).length === 0) fs.rmdirSync(wtBase); } catch { /* leave it */ }
    let deleted = 0;
    for (const m of run.milestones) {
      for (const s of m.sessions) {
        if (s.branch && (await git(rootPath, ['branch', '-d', s.branch])).ok) deleted += 1;
      }
    }
    const raw = getRunRaw(runId);
    if (raw.integration_branch && (await git(rootPath, ['branch', '-d', raw.integration_branch])).ok) deleted += 1;
    if (removed || deleted) {
      addActivity(runId, 'state', `Workspace cleaned: ${removed} worktree${removed === 1 ? '' : 's'} removed, ${deleted} merged branch${deleted === 1 ? '' : 'es'} deleted`);
    }
  } catch { /* cleanup is best-effort by design */ }
}

// ---------------------------------------------------------------- session launching

function worktreeDir(runId: string, key: string): string {
  const dir = path.join(config.dataDir, 'worktrees', runId.slice(0, 8), key.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return dir;
}

/** Another launched session (or integration) already occupying this directory? */
function dirBusyWithin(runId: string, cwd: string, exceptKey?: string): PdSession | null {
  const running = sessionsByStatus(runId, ['running']);
  return running.find((s) => s.cwd === cwd && s.key !== exceptKey) ?? null;
}

export async function launchSession(runId: string, key: string, timeoutMin?: number): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Unknown project run.');
  if (!['RUNNING', 'RESUMING', 'PLANNING'].includes(run.state)) {
    throw new Error(`Sessions cannot start while the project is ${run.state}.`);
  }
  const session = getSession(runId, key);
  if (!session) throw new Error(`Unknown session: ${key}`);
  if (session.status === 'running') throw new Error(`Session ${key} is already running.`);
  if (session.status === 'completed') throw new Error(`Session ${key} is already completed.`);
  const deps = depsSatisfied(runId, key);
  if (!deps.ok) throw new Error(`Session ${key} cannot start: unfinished dependencies ${deps.missing.join(', ')}.`);
  // milestone-level dependencies are an engine invariant, not a suggestion
  const ownerMs = run.milestones.find((m) => m.sessions.some((s) => s.key === key));
  if (ownerMs) {
    const openDeps = milestoneDepsOpen(runId, ownerMs.key);
    if (openDeps.length > 0) {
      throw new Error(`Session ${key} belongs to milestone ${ownerMs.key}, whose predecessor${openDeps.length === 1 ? '' : 's'} ${openDeps.join(', ')} ${openDeps.length === 1 ? 'is' : 'are'} not completed — complete ${openDeps.join(', ')} first (complete_milestone) or revise the plan.`);
    }
  }

  const rootProject = getProject(run.projectId)!;
  let cwd = rootProject.rootPath;
  let chatProjectId = run.projectId;

  if (session.branch) {
    // isolated: its own worktree on its own pd/ branch, off the integration branch
    const integration = await ensureIntegrationBranch(runId, rootProject.rootPath);
    const dir = session.cwd ?? worktreeDir(runId, key);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      const branchExists = (await git(rootProject.rootPath, ['rev-parse', '--verify', `refs/heads/${session.branch}`])).ok;
      const wt = branchExists
        ? await git(rootProject.rootPath, ['worktree', 'add', dir, session.branch], 30_000)
        : await git(rootProject.rootPath, ['worktree', 'add', dir, '-b', session.branch, integration], 30_000);
      if (!wt.ok) throw new Error(`Could not create the session worktree: ${wt.stderr}`);
    }
    const wtProject = findOrCreateProject(dir, 'directory');
    cwd = wtProject.rootPath;
    chatProjectId = wtProject.id;
  } else if (await isRepo(rootProject.rootPath)) {
    // shared directory: work lands directly on the integration branch;
    // hard invariant — one session at a time in a shared directory
    const busy = dirBusyWithin(runId, rootProject.rootPath, key);
    if (busy) throw new Error(`Session ${busy.key} is already working in the shared project directory — mark ${key} isolated to run it in parallel, or start it after ${busy.key} finishes.`);
    await ensureIntegrationBranch(runId, rootProject.rootPath);
  } else {
    const busy = dirBusyWithin(runId, rootProject.rootPath, key);
    if (busy) throw new Error(`Session ${busy.key} is already working in the project directory.`);
  }

  // the run state can change during the git awaits above (a pause — manual or
  // automatic — may have landed): nothing may be created for a frozen project
  const stateNow = getRunRaw(runId)?.state;
  if (!['RUNNING', 'RESUMING', 'PLANNING'].includes(stateNow)) {
    throw new Error(`Sessions cannot start while the project is ${stateNow}.`);
  }

  // the session is a NORMAL Tandem chat — the same primitive a human's New chat
  // uses. kind 'pd-session' is a durable ownership marker (it survives restarts
  // and relaunches, unlike the pd_sessions.chat_id pointer): the message route
  // refuses direct human input into any chat that ever belonged to a Director.
  const chatId = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO chats (id, project_id, title, created_at, updated_at, running, kind) VALUES (?, ?, ?, ?, ?, 0, 'pd-session')`)
    .run(chatId, chatProjectId, `${key} · ${session.name}`.slice(0, 80), now, now);
  broadcastChat(chatId);

  // pre-seed the chat's persistent Git policy so its checkpoints land on the
  // right branch (repoPath must string-equal the chat's project rootPath)
  if (session.branch) {
    setGitStateRow(chatId, { mode: 'direct', workBranch: session.branch, targetBranch: session.branch, push: 'never', repoPath: cwd });
  } else if (getRunRaw(runId).integration_branch) {
    const ib = getRunRaw(runId).integration_branch as string;
    setGitStateRow(chatId, { mode: 'direct', workBranch: ib, targetBranch: ib, push: 'never', repoPath: cwd });
  }

  patchSession(runId, key, { chatId, cwd, status: 'running', startedAt: Date.now(), stopReason: null });
  addActivity(runId, 'session', `${key} ${session.name} started`, `chat ${chatId}`);
  refreshLiveBlock(runId);
  ensurePoller(runId);

  const timeoutMs = Math.min(timeoutMin ?? DEFAULT_SESSION_TIMEOUT_MIN, MAX_SESSION_TIMEOUT_MIN) * 60_000;
  const baseline = chatMaxSeq(chatId);
  patchSession(runId, key, { lastBaselineSeq: baseline });
  addEvent(chatId, 'user_message', { text: session.prompt });
  setChatTitle(chatId, deriveTitle(session.prompt));
  void monitorSession(runId, key, chatId, baseline, startRun(chatId, session.prompt, [], { review: true, timeoutMs }));
  return chatId;
}

/** Resume a paused session: a continuation message on the SAME chat — the existing resume primitive. */
export async function resumeSession(runId: string, key: string, note?: string): Promise<void> {
  const session = getSession(runId, key);
  if (!session) throw new Error(`Unknown session: ${key}`);
  if (!session.chatId) { await launchSession(runId, key); return; }
  if (session.status === 'running') throw new Error(`Session ${key} is already running.`);
  if (!['paused', 'timeout', 'failed', 'needs_attention'].includes(session.status)) {
    throw new Error(`Session ${key} is ${session.status} and has nothing to resume.`);
  }
  const deps = depsSatisfied(runId, key);
  if (!deps.ok) throw new Error(`Session ${key} cannot resume: unfinished dependencies ${deps.missing.join(', ')}.`);
  const busy = session.cwd ? dirBusyWithin(runId, session.cwd, key) : null;
  if (busy) throw new Error(`Session ${busy.key} is already working in that directory.`);
  const text = renderPrompt('director.session_continuation', { note: note ?? '' }).trim();
  patchSession(runId, key, { status: 'running', startedAt: Date.now(), stopReason: null });
  addActivity(runId, 'session', `${key} resumed`);
  refreshLiveBlock(runId);
  ensurePoller(runId);
  const baseline = chatMaxSeq(session.chatId);
  patchSession(runId, key, { lastBaselineSeq: baseline });
  addEvent(session.chatId, 'user_message', { text });
  void monitorSession(runId, key, session.chatId, baseline, startRun(session.chatId, text, [], { review: true }));
}

// ---------------------------------------------------------------- monitoring

/** Max event seq currently in a chat — the baseline for reading a run's outcome. */
function chatMaxSeq(chatId: string): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ?').get(chatId) as any;
  return r.s as number;
}

/**
 * Fallback for sessions launched before last_baseline_seq existed: reconstruct
 * the baseline of the chat's most recent run as the seq just before its last
 * user_message. Imprecise if a human posted into the session chat afterwards —
 * new launches persist the exact baseline instead. readOutcome takes a SEQ.
 */
function lastRunBaseline(chatId: string): number {
  if (!chatId) return 0;
  const r = db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ? AND kind = 'user_message'").get(chatId) as any;
  return Math.max(0, (r.s as number) - 1);
}


/** Await the ordinary run and translate its outcome into orchestration state. */
async function monitorSession(runId: string, key: string, chatId: string, baselineSeq: number, running: Promise<void>): Promise<void> {
  try { await running; } catch { /* startRun handles its own errors */ }

  const outcome = readOutcome(chatId, baselineSeq);
  const run = getRunRaw(runId);
  const pausing = run && (run.state === 'PAUSING' || run.state === 'PAUSED');
  // completion is a fact regardless of pause; a pause only reinterprets
  // interruptions (stop/timeout/failure during the pause) as preservation
  let status: PdSession['status'];
  if (outcome.phase === 'finished' && !outcome.failed && !outcome.timedOut) status = 'completed';
  else if (outcome.phase === 'stopped') status = 'paused';
  else if (pausing) status = 'paused';
  else if (outcome.timedOut) status = 'timeout';
  else if (outcome.failed || outcome.phase === 'failed') status = 'failed';
  else status = 'failed';
  // the persisted stop INTENT keeps these cases distinct forever after
  const stopReason: PdSession['stopReason'] = status !== 'paused' ? null : pausing ? 'project_pause' : 'user_stop';

  patchSession(runId, key, {
    status,
    stopReason,
    endedAt: Date.now(),
    resultSummary: outcome.summary.slice(0, 1_000),
    ...(outcome.reviewVerdict ? { reviewVerdict: outcome.reviewVerdict } : {}),
  });
  addActivity(runId, 'session',
    status === 'completed' ? `${key} completed${outcome.reviewVerdict ? ` · reviewer: ${outcome.reviewVerdict}` : ''}`
      : status === 'paused' ? (stopReason === 'user_stop' ? `${key} stopped by the user and preserved` : `${key} preserved (project pause)`)
        : status === 'timeout' ? `${key} timed out`
          : `${key} failed`);
  refreshLiveBlock(runId);
  // canonical title fallback, exactly once (only the chat's FIRST run has
  // baseline 0): if the Builder never registered a name, compose one from the
  // Director's own session name — the sidebar never keeps a prompt excerpt
  if (baselineSeq === 0) {
    const s = getSession(runId, key);
    const chat = getChat(chatId);
    if (s && chat && !chat.title.startsWith(sessionTitlePrefix(s))) {
      setChatTitle(chatId, canonicalSessionTitle(s, s.name));
    }
  }

  if (pausing) {
    // no observations while pausing/paused — nothing may wake orchestration
    finishPauseIfDone(runId);
    return;
  }

  if (status === 'completed') {
    // close the unprotected window after a scaffolding session: as soon as the
    // root is a repo with a commit, freeze the base branch behind pd/integration
    if (!getRunRaw(runId).integration_branch) {
      const root = getProject(getRun(runId)!.projectId)?.rootPath;
      if (root && await isRepo(root)) {
        try { await ensureIntegrationBranch(runId, root); } catch { /* no baseline commit yet — next launch tries again */ }
      }
    }
    const ready = readySessions(runId);
    queueObservation(runId, `Session ${key} COMPLETED.${outcome.reviewVerdict ? ` Reviewer verdict: ${outcome.reviewVerdict}.` : ''} Result summary: ${outcome.summary.slice(0, 600) || '(no summary)'}${ready.length ? ` Sessions whose dependencies are now satisfied: ${ready.join(', ')}.` : ''}`);
  } else if (status === 'paused') {
    // a deliberate user stop is NOT a failure: no needs_attention, no forced
    // recovery review. Whether the PROJECT continues depends on the canonical
    // dependencies: work that nothing else waits on lets the project run;
    // work with pending dependents can never complete, so the project pauses.
    if (stopBlocksRequiredPath(runId, key)) {
      addActivity(runId, 'state', `${key} was stopped by the user and required downstream work depends on it — pausing the project`);
      const runRow = getRun(runId);
      if (runRow) addEvent(runRow.chatId, 'status', { text: '⏸ Project paused — a user-stopped session blocks required downstream work.' });
      pauseProject(runId); // the EXISTING pause path preserves everything else
    } else {
      queueObservation(runId, `Session ${key} was STOPPED by the user; its chat and all work on disk are preserved. Nothing pending depends on it, so the project continues. Decide whether to resume it later (resume_sessions), replan around it, or leave it — this was a deliberate stop, not a failure.`);
    }
  } else {
    patchSession(runId, key, { status: 'needs_attention' });
    const context = await failureContext(runId, key, chatId, outcome);
    queueObservation(runId, `Session ${key} ${status === 'timeout' ? 'TIMED OUT' : 'FAILED'} and needs your decision. Do NOT mechanically retry — analyze and decide with recover_session (the decision will be independently reviewed).\n${context}`);
  }
}

interface Outcome { phase: string; failed: boolean; timedOut: boolean; summary: string; reviewVerdict: 'pass' | 'findings' | null; errorText: string }

function readOutcome(chatId: string, sinceSeq: number): Outcome {
  const rows = db.prepare('SELECT kind, payload FROM events WHERE chat_id = ? AND seq > ? ORDER BY seq').all(chatId, sinceSeq) as any[];
  let phase = 'failed';
  let failed = false;
  let timedOut = false;
  let summary = '';
  let reviewVerdict: Outcome['reviewVerdict'] = null;
  let errorText = '';
  const FAIL_MESSAGES = new Set(['Builder call failed', 'Builder repair call failed', 'Final repair call failed', 'The run failed unexpectedly']);
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    // NOTE: the run phase is 'finished' even when the builder errored (only an
    // unexpected throw yields 'failed', and a Stop yields 'stopped'), so the
    // error events below — not the phase — are the authoritative failure signal.
    if (r.kind === 'run' && ['finished', 'stopped', 'failed'].includes(p.phase)) phase = p.phase;
    if (r.kind === 'assistant_message' && (p.text ?? '').trim()) summary = p.text.trim();
    if (r.kind === 'findings') reviewVerdict = p.verdict;
    if (r.kind === 'error') {
      const text = `${p.message}${p.detail ? ` — ${p.detail}` : ''}`.slice(0, 400);
      if (FAIL_MESSAGES.has(p.message)) { failed = true; errorText = text; }
      if (/timed out/i.test(text)) { timedOut = true; if (!errorText) errorText = text; }
    }
  }
  return { phase, failed, timedOut, summary: summary || errorText, reviewVerdict, errorText };
}

/** Enough real context for an intelligent recovery decision — never a bare "it failed". */
async function failureContext(runId: string, key: string, chatId: string, outcome: Outcome): Promise<string> {
  const session = getSession(runId, key)!;
  const lines = [
    `Original session contract:\n${session.prompt.slice(0, 1_200)}`,
    `Elapsed: ${session.startedAt ? Math.round((Date.now() - session.startedAt) / 60_000) : '?'} minutes.`,
    outcome.errorText ? `Error: ${outcome.errorText}` : '',
    outcome.summary ? `Last Builder message: ${outcome.summary.slice(0, 600)}` : '',
  ];
  const recent = (db.prepare("SELECT kind, payload FROM events WHERE chat_id = ? ORDER BY seq DESC LIMIT 14").all(chatId) as any[])
    .reverse()
    .map((r) => {
      const p = JSON.parse(r.payload);
      if (r.kind === 'command') return `ran: ${String(p.command).slice(0, 90)} (exit ${p.exitCode})`;
      if (r.kind === 'file_change') return `changed: ${(p.files ?? []).map((f: any) => f.path).join(', ').slice(0, 120)}`;
      if (r.kind === 'status') return `status: ${String(p.text).slice(0, 100)}`;
      if (r.kind === 'checkpoint') return `checkpoint: ${p.action} on ${p.branch}`;
      return null;
    })
    .filter(Boolean);
  if (recent.length) lines.push(`Recent session activity:\n${recent.map((l) => `  ${l}`).join('\n')}`);
  if (session.cwd && await isRepo(session.cwd)) {
    const dirty = await git(session.cwd, ['status', '--porcelain']);
    const log = await git(session.cwd, ['log', '--oneline', '-5']);
    const diff = await git(session.cwd, ['diff', '--stat', 'HEAD']);
    lines.push(`Worktree: ${dirty.stdout ? `${dirty.stdout.split('\n').length} uncommitted files` : 'clean'}${session.branch ? ` on ${session.branch}` : ''}.`);
    if (log.ok && log.stdout) lines.push(`Recent commits:\n${log.stdout.split('\n').slice(0, 5).map((l) => `  ${l}`).join('\n')}`);
    if (diff.ok && diff.stdout) lines.push(`Uncommitted diff stat:\n${diff.stdout.split('\n').slice(-3).join('\n')}`);
  }
  lines.push(`Preserved: the session's chat, its Claude session, and all work on disk. Options include: continue with more time, resume with guidance, restart with a better contract, split the remaining work, reduce scope, wait for a dependency, or abandon (work stays recoverable).`);
  return lines.filter(Boolean).join('\n');
}

/**
 * Does pending work depend — directly or transitively, via session deps or
 * milestone deps — on this now-paused session? Computed purely from the
 * canonical plan/state; no new "critical session" concept. If yes, the
 * required completion path is blocked and the project cannot legitimately
 * reach COMPLETED, so it pauses instead of grinding on.
 */
function stopBlocksRequiredPath(runId: string, key: string): boolean {
  const run = getRun(runId);
  if (!run) return false;
  const all = run.milestones.flatMap((m) => m.sessions);
  // transitive session-level dependents of the stopped session
  const dependents = new Set<string>([key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of all) {
      if (!dependents.has(s.key) && s.dependsOn.some((d) => dependents.has(d))) { dependents.add(s.key); grew = true; }
    }
  }
  dependents.delete(key);
  if (all.some((s) => dependents.has(s.key) && s.status === 'planned')) return true;
  // transitive milestone-level dependents of the stopped session's milestone
  const owner = run.milestones.find((m) => m.sessions.some((s) => s.key === key));
  if (!owner || owner.status === 'completed') return false;
  const msDeps = new Set<string>([owner.key]);
  grew = true;
  while (grew) {
    grew = false;
    for (const m of run.milestones) {
      if (!msDeps.has(m.key) && m.dependsOn.some((d) => msDeps.has(d))) { msDeps.add(m.key); grew = true; }
    }
  }
  msDeps.delete(owner.key);
  if (run.milestones.some((m) => msDeps.has(m.key) && m.status !== 'completed')) return true;
  // terminal case: nothing may DEPEND on the stopped session, yet it can still
  // be the last remaining work (a final required milestone). The invariant is
  // "no valid path to COMPLETED" — so the project stays RUNNING only while some
  // OTHER forward progress exists: another active (or recovery-pending)
  // session, a startable planned session outside the stopped chain, or an open
  // milestone outside the stopped milestone's dependent closure.
  const progressable =
    all.some((s) => s.key !== key && ['running', 'timeout', 'needs_attention'].includes(s.status))
    || all.some((s) => s.status === 'planned' && !dependents.has(s.key))
    || run.milestones.some((m) => m.key !== owner.key && !msDeps.has(m.key) && m.status !== 'completed');
  return !progressable;
}

function readySessions(runId: string): string[] {
  return sessionsByStatus(runId, ['planned'])
    .filter((s) => depsSatisfied(runId, s.key).ok)
    .map((s) => s.key);
}

// ---------------------------------------------------------------- live block

const pollers = new Map<string, NodeJS.Timeout>();

function ensurePoller(runId: string): void {
  if (pollers.has(runId)) return;
  const timer = setInterval(() => {
    const running = sessionsByStatus(runId, ['running']);
    refreshLiveBlock(runId);
    if (running.length === 0) {
      clearInterval(timer);
      pollers.delete(runId);
    }
  }, POLL_MS);
  timer.unref?.();
  pollers.set(runId, timer);
}

function deriveLive(chatId: string): { builder: string | null; reviewer: string | null; note: string | null } {
  const rows = db.prepare("SELECT kind, payload FROM events WHERE chat_id = ? ORDER BY seq DESC LIMIT 20").all(chatId) as any[];
  let builder: string | null = null;
  let reviewer: string | null = null;
  let note: string | null = null;
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (!note && r.kind === 'status') note = String(p.text).slice(0, 80);
    if (!note && r.kind === 'command') note = `$ ${String(p.command).slice(0, 70)}`;
    if (r.kind === 'ai_call') {
      if ((p.role === 'builder' || p.role === 'final_repair') && builder == null) {
        builder = p.status === 'running' ? 'working' : p.status === 'done' ? 'finished' : p.status;
      }
      if (p.role === 'reviewer' && reviewer == null) reviewer = p.status === 'running' ? 'reviewing' : p.status;
    }
    if (r.kind === 'findings' && reviewer == null) reviewer = p.verdict === 'pass' ? 'accepted' : 'findings';
  }
  return { builder, reviewer, note };
}

/**
 * The "N sessions running" block — ONE event in the Project Chat per wave,
 * updated in place exactly like the existing command-group rows.
 */
export function refreshLiveBlock(runId: string): void {
  const run = getRun(runId);
  if (!run) return;
  const byKey = new Map(run.milestones.flatMap((m) => m.sessions.map((s) => [s.key, { s, m }] as const)));
  const raw0 = getRunRaw(runId);
  // the block describes ONE WAVE: the sessions already in the live event, plus
  // whatever is running now, plus planned dependents in the running milestones —
  // never every session the run has ever launched
  const prior = raw0.live_event_id ? getEvent(raw0.live_event_id) : null;
  const priorKeys = new Set<string>(((prior?.payload as any)?.sessions ?? []).map((x: any) => String(x.key)));
  const running = [...byKey.values()].filter(({ s }) => s.status === 'running');
  const runningMsIds = new Set(running.map(({ m }) => m.id));
  const waiting = [...byKey.values()].filter(({ s, m }) => runningMsIds.has(m.id) && s.status === 'planned' && !s.chatId);
  const tracked = [...byKey.values()].filter(({ s }) =>
    priorKeys.has(s.key)
    || s.status === 'running'
    || waiting.some((w) => w.s.key === s.key));
  if (tracked.length === 0) return;
  const active = tracked.filter(({ s }) => s.status === 'running');

  // label the wave by the milestones it actually spans (concurrent milestones
  // are legitimate — "M4 + M5", never a stale first-milestone fallback)
  const waveMs: typeof run.milestones = [];
  for (const { m } of tracked) if (!waveMs.some((x) => x.id === m.id)) waveMs.push(m);
  waveMs.sort((a, b) => a.orderIdx - b.orderIdx);

  const payload: SessionsPayload = {
    runId,
    milestoneKey: waveMs.map((m) => m.key).join(' + '),
    milestoneName: waveMs.map((m) => m.name).join(' · '),
    sessions: tracked.map(({ s }) => s).slice(-12).map((s) => {
      const live = s.status === 'running' && s.chatId ? deriveLive(s.chatId) : { builder: null, reviewer: null, note: null };
      return {
        key: s.key, name: s.name, chatId: s.chatId, status: s.status,
        builderState: live.builder, reviewerState: live.reviewer,
        note: live.note ?? (s.status === 'planned' ? `Waiting for ${s.dependsOn.join(', ')}` : s.resultSummary?.slice(0, 80) ?? null),
        startedAt: s.startedAt, endedAt: s.endedAt,
      };
    }),
    done: active.length === 0,
  };

  const raw = getRunRaw(runId);
  if (raw.live_event_id) {
    const updated = updateEvent(raw.live_event_id, payload as unknown as Record<string, unknown>);
    if (updated) {
      if (payload.done) patchRun(runId, { live_event_id: null });
      return;
    }
  }
  if (!payload.done) {
    const ev = addEvent(run.chatId, 'sessions', payload);
    patchRun(runId, { live_event_id: ev.id });
  }
}

// ---------------------------------------------------------------- recovery

export async function applyRecovery(runId: string, pending: any): Promise<void> {
  const key = pending.sessionKey as string;
  const session = getSession(runId, key);
  if (!session) return;
  const state = getRunRaw(runId)?.state;
  if (!['RUNNING', 'RESUMING', 'PLANNING'].includes(state)) {
    addActivity(runId, 'recovery', `Recovery for ${key} not applied — the project is ${state}`);
    return;
  }
  addActivity(runId, 'recovery', `Recovery applied for ${key}: ${pending.action}`, pending.reasoning?.slice(0, 1_500));
  try {
    if (pending.action === 'continue') {
      const note = pending.newPrompt ? `\nUpdated guidance from the Project Director:\n${pending.newPrompt}` : '';
      await resumeSessionWithTimeout(runId, key, note, pending.extraMinutes);
    } else if (pending.action === 'restart') {
      if (pending.newPrompt) patchSession(runId, key, { prompt: pending.newPrompt });
      patchSession(runId, key, { status: 'planned' });
      await launchSession(runId, key, pending.extraMinutes);
    } else if (pending.action === 'abandon') {
      patchSession(runId, key, { status: 'abandoned' });
      refreshLiveBlock(runId);
      // dependencies are only satisfied by COMPLETED sessions, so dependents of
      // an abandoned one are dead until replanned — say so instead of letting
      // the Director discover it via launch rejections
      const blocked = sessionsByStatus(runId, ['planned']).filter((s) => s.dependsOn.includes(key)).map((s) => s.key);
      queueObservation(runId, `Session ${key} is abandoned per your reviewed decision; its work remains on disk${session.branch ? ` (branch ${session.branch})` : ''}.${blocked.length ? ` BLOCKED dependents: ${blocked.join(', ')} can never start while they depend on ${key} — redefine them with plan_milestone_sessions (new depends_on) or restart ${key}.` : ''} Replan the remaining milestone work if needed.`);
    } else if (pending.action === 'wait') {
      patchSession(runId, key, { status: 'paused' });
      refreshLiveBlock(runId);
      queueObservation(runId, `Session ${key} is set to wait per your reviewed decision. Resume it when its blockers clear.`);
    }
  } catch (err) {
    queueObservation(runId, `Applying the recovery for ${key} failed: ${err instanceof Error ? err.message : err}. Decide again.`);
  }
}

async function resumeSessionWithTimeout(runId: string, key: string, note: string, extraMinutes?: number): Promise<void> {
  const session = getSession(runId, key);
  if (!session?.chatId) throw new Error(`Session ${key} has no chat to continue.`);
  const busy = session.cwd ? dirBusyWithin(runId, session.cwd, key) : null;
  if (busy) throw new Error(`Session ${busy.key} is working in that directory.`);
  const text = renderPrompt('director.session_continuation', { note }).trim();
  patchSession(runId, key, { status: 'running', startedAt: Date.now(), stopReason: null });
  addActivity(runId, 'session', `${key} resumed`);
  refreshLiveBlock(runId);
  ensurePoller(runId);
  const baseline = chatMaxSeq(session.chatId);
  patchSession(runId, key, { lastBaselineSeq: baseline });
  addEvent(session.chatId, 'user_message', { text });
  const timeoutMs = Math.min(extraMinutes ?? DEFAULT_SESSION_TIMEOUT_MIN, MAX_SESSION_TIMEOUT_MIN) * 60_000;
  void monitorSession(runId, key, session.chatId, baseline, startRun(session.chatId, text, [], { review: true, timeoutMs }));
}

// ---------------------------------------------------------------- pause / resume

export function pauseProject(runId: string): void {
  const run = getRun(runId);
  if (!run) throw new Error('Unknown project run.');
  // idempotent: an in-flight or finished pause is never restacked
  if (['PAUSING', 'PAUSED', 'COMPLETED', 'FAILED'].includes(run.state)) return;
  setRunState(runId, 'PAUSING', 'Pause requested — stopping active sessions');
  const active = sessionsByStatus(runId, ['running']);
  if (active.length === 0) {
    setRunState(runId, 'PAUSED', 'Project paused');
    addEvent(run.chatId, 'status', { text: '⏸ Project paused' });
    return;
  }
  for (const s of active) {
    if (s.chatId) stopRun(s.chatId); // the EXISTING stop primitive; monitors mark them paused
  }
  addActivity(runId, 'state', `Stopping ${active.length} active session${active.length === 1 ? '' : 's'}`);
}

function finishPauseIfDone(runId: string): void {
  const raw = getRunRaw(runId);
  if (raw?.state !== 'PAUSING') return;
  if (sessionsByStatus(runId, ['running']).length === 0) {
    const preserved = sessionsByStatus(runId, ['paused']).length;
    setRunState(runId, 'PAUSED', `Project paused — ${preserved} session${preserved === 1 ? '' : 's'} preserved`);
    addEvent(raw.chat_id, 'status', { text: `⏸ Project paused · ${preserved} session${preserved === 1 ? '' : 's'} preserved` });
    refreshLiveBlock(runId);
  }
}

export function resumeProject(runId: string): void {
  const run = getRun(runId);
  if (!run) throw new Error('Unknown project run.');
  if (run.state !== 'PAUSED' && run.state !== 'NEEDS_USER') throw new Error(`The project is ${run.state}, not paused.`);
  // the Director wakes FIRST (state flips before the observation so the wake
  // is not dropped by the paused-project guard) and decides what resumes
  setRunState(runId, 'RESUMING', 'Resume requested');
  const paused = sessionsByStatus(runId, ['paused', 'timeout', 'needs_attention'])
    .map((s) => `${s.key}${s.stopReason === 'user_stop' ? ' (stopped by the user)' : s.stopReason === 'project_pause' ? ' (project pause)' : ''}`);
  queueObservation(runId, `The user resumed the project. Paused/interrupted sessions: ${paused.join(', ') || '(none)'}. Inspect the current state and decide what should resume NOW (resume_sessions / start_sessions) — do not mechanically restart everything; dependencies may have changed, and a session the user stopped deliberately may be one they do not want rerun. Completed sessions must not be rerun.`);
}

// ---------------------------------------------------------------- boot recovery

/** Server restart: interrupted sessions become paused, running projects pause honestly. */
export function recoverDirectorRuns(): void {
  for (const run of listRuns()) {
    const interrupted = sessionsByStatus(run.id, ['running']);
    for (const s of interrupted) patchSession(run.id, s.key, { status: 'paused', endedAt: Date.now(), stopReason: 'project_pause' });
    if (['RUNNING', 'PAUSING', 'RESUMING'].includes(run.state)) {
      setRunState(run.id, 'PAUSED', `Tandem restarted — ${interrupted.length ? `${interrupted.length} active session${interrupted.length === 1 ? '' : 's'} preserved and paused` : 'project paused'}; resume to continue`);
      refreshLiveBlock(run.id);
    }
  }
}

// ---------------------------------------------------------------- director tools

export interface ToolReply { ok: boolean; text?: string; error?: string }

export async function handleDirectorTool(chatId: string, op: string, args: Record<string, any>): Promise<ToolReply> {
  const run = runForChat(chatId);
  if (!run) return { ok: false, error: 'This chat is not a Project Director chat.' };
  const runId = run.id;
  // a terminal run is immutable: answer questions from state, change nothing
  if (['COMPLETED', 'FAILED'].includes(run.state) && op !== 'get_state') {
    return { ok: false, error: `This project run is ${run.state} and can no longer be changed. Answer the user from the existing state; for new work, ask them to start a new project run in the same directory.` };
  }
  // a paused project is frozen: nothing starts, integrates, delivers, or
  // completes until the user presses Resume (which wakes you in RESUMING)
  if (['PAUSING', 'PAUSED'].includes(run.state) && op !== 'get_state') {
    return { ok: false, error: `The project is ${run.state}. Nothing can start, change, or complete while it is paused — answer the user in the chat from the existing state, and ask them to press Resume when they are ready.` };
  }
  try {
    switch (op) {
      case 'get_state':
        return { ok: true, text: stateSnapshot(runId) };

      case 'set_plan': {
        const milestones: MilestoneInput[] = (args.milestones ?? []).map((m: any) => ({
          key: String(m.key ?? '').trim(), name: String(m.name ?? '').trim(),
          goal: String(m.goal ?? ''), acceptance: String(m.acceptance ?? ''),
          dependsOn: Array.isArray(m.depends_on) ? m.depends_on.map(String) : [],
        }));
        if (milestones.length === 0) return { ok: false, error: 'A plan needs at least one milestone.' };
        if (milestones.length > 20) return { ok: false, error: 'Keep the master plan to at most 20 milestones.' };
        setPlan(runId, milestones, String(args.summary ?? ''));
        if (args.title) patchRun(runId, { title: String(args.title).slice(0, 80) });
        const raw = getRunRaw(runId);
        const round = raw.plan_review_round > 0 ? raw.plan_review_round : 1;
        patchRun(runId, { plan_review_round: round });
        addActivity(runId, 'plan', `Master plan ${round > 1 ? 'revised' : 'proposed'}: ${milestones.length} milestones`);
        return { ok: true, text: `Plan recorded (${milestones.length} milestones). The independent review runs next — you will receive its verdict.` };
      }

      case 'plan_sessions': {
        const sessions: SessionInput[] = (args.sessions ?? []).map((s: any) => ({
          key: String(s.key ?? '').trim(), name: String(s.name ?? '').trim(),
          purpose: String(s.purpose ?? ''), prompt: String(s.prompt ?? ''),
          dependsOn: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
          isolated: !!s.isolated,
        }));
        if (sessions.length === 0) return { ok: false, error: 'Provide at least one session.' };
        if (sessions.some((s) => !s.prompt.trim())) return { ok: false, error: 'Every session needs a full self-contained prompt.' };
        const msKeyArg = String(args.milestone ?? '');
        if (!milestoneByKey(runId, msKeyArg)) return { ok: false, error: `Unknown milestone: ${msKeyArg}` };
        const openDeps = milestoneDepsOpen(runId, msKeyArg);
        if (openDeps.length > 0) {
          return { ok: false, error: `Milestone ${msKeyArg} cannot be decomposed yet: its predecessor${openDeps.length === 1 ? '' : 's'} ${openDeps.join(', ')} ${openDeps.length === 1 ? 'is' : 'are'} not completed. Complete ${openDeps.join(', ')} first (complete_milestone), or revise the plan if the dependency is wrong.` };
        }
        const ms = planSessions(runId, msKeyArg, sessions);
        patchMilestone(runId, ms.key, { status: 'running' });
        addActivity(runId, 'decision', `${ms.key} planned into ${ms.sessions.length} sessions`, String(args.reasoning ?? '').slice(0, 1_500));
        return { ok: true, text: `Milestone ${ms.key} now has ${ms.sessions.length} sessions. Start the ready ones with start_sessions.` };
      }

      case 'start_sessions': {
        const keys: string[] = (args.keys ?? []).map(String);
        if (keys.length === 0) return { ok: false, error: 'Provide session keys to start.' };
        const started: string[] = [];
        const errors: string[] = [];
        for (const key of keys) {
          try {
            await launchSession(runId, key, args.timeout_minutes ? Number(args.timeout_minutes) : undefined);
            started.push(key);
          } catch (err) {
            errors.push(`${key}: ${err instanceof Error ? err.message : err}`);
          }
        }
        if (started.length > 0 && getRunRaw(runId).state === 'RESUMING') setRunState(runId, 'RUNNING', 'Project resumed');
        return {
          ok: errors.length === 0 || started.length > 0,
          text: `${started.length ? `Started: ${started.join(', ')}. Each is a normal Tandem session with its own Builder and independent Reviewer; you will be woken when they finish.` : ''}${errors.length ? `\nNot started — ${errors.join('; ')}` : ''}`.trim(),
          ...(started.length === 0 ? { error: errors.join('; ') } : {}),
        };
      }

      case 'resume_sessions': {
        const keys: string[] = (args.keys ?? []).map(String);
        const resumed: string[] = [];
        const errors: string[] = [];
        for (const key of keys) {
          try { await resumeSession(runId, key, args.note ? String(args.note) : undefined); resumed.push(key); }
          catch (err) { errors.push(`${key}: ${err instanceof Error ? err.message : err}`); }
        }
        if (resumed.length > 0 && ['RESUMING', 'PAUSED'].includes(getRunRaw(runId).state)) setRunState(runId, 'RUNNING', 'Project resumed');
        return { ok: errors.length === 0 || resumed.length > 0, text: `${resumed.length ? `Resumed: ${resumed.join(', ')}.` : ''}${errors.length ? ` Not resumed — ${errors.join('; ')}` : ''}`.trim() };
      }

      case 'recover_session': {
        const key = String(args.key ?? '');
        const session = getSession(runId, key);
        if (!session) return { ok: false, error: `Unknown session: ${key}` };
        const action = String(args.action ?? '');
        if (!['continue', 'restart', 'abandon', 'wait'].includes(action)) {
          return { ok: false, error: 'action must be one of: continue, restart, abandon, wait.' };
        }
        const raw = getRunRaw(runId);
        let round = 1;
        if (raw.pending_recovery) {
          try {
            const prev = JSON.parse(raw.pending_recovery);
            if (prev.sessionKey === key && prev.awaitingRevision) round = prev.round;
          } catch { /* fresh decision */ }
        }
        const context = await failureContext(runId, key, session.chatId ?? '',
          readOutcome(session.chatId ?? '', session.lastBaselineSeq ?? lastRunBaseline(session.chatId ?? '')));
        patchRun(runId, {
          pending_recovery: JSON.stringify({
            sessionKey: key, action,
            reasoning: String(args.reasoning ?? ''),
            newPrompt: args.new_prompt ? String(args.new_prompt) : undefined,
            extraMinutes: args.extra_minutes ? Number(args.extra_minutes) : undefined,
            round, context,
          }),
        });
        addActivity(runId, 'recovery', `Recovery ${round > 1 ? 'revised' : 'proposed'} for ${key}: ${action}`);
        return { ok: true, text: round >= 3
          ? 'Final revision recorded — it will be applied without further review (review policy cap).'
          : 'Recovery decision recorded. It is significant, so the independent reviewer evaluates it next; you will receive the verdict.' };
      }

      case 'integrate_milestone': {
        const msKey = String(args.milestone ?? '');
        const ms = milestoneByKey(runId, msKey);
        if (!ms) return { ok: false, error: `Unknown milestone: ${msKey}` };
        // ALL preconditions before any side effect (session row / status change),
        // so a rejection leaves nothing behind that blocks a retry
        const msDeps = milestoneDepsOpen(runId, msKey);
        if (msDeps.length > 0) return { ok: false, error: `Milestone ${msKey}'s predecessor${msDeps.length === 1 ? '' : 's'} ${msDeps.join(', ')} ${msDeps.length === 1 ? 'is' : 'are'} not completed — integrate after ${msDeps.join(', ')}.` };
        const intKey = `${msKey}.INT`;
        // a leftover planned INT session from an earlier rejected attempt is ours to replace
        const unfinished = ms.sessions.filter((s) => !['completed', 'abandoned'].includes(s.status) && !(s.key === intKey && s.status === 'planned'));
        if (unfinished.length > 0) return { ok: false, error: `Sessions still open: ${unfinished.map((s) => s.key).join(', ')} — integration needs every session completed or abandoned.` };
        const rootProject = getProject(run.projectId)!;
        const busy = dirBusyWithin(runId, rootProject.rootPath);
        if (busy) return { ok: false, error: `Session ${busy.key} is working in the project directory — integrate after it finishes.` };
        const integration = await ensureIntegrationBranch(runId, rootProject.rootPath);
        const branches = ms.sessions.filter((s) => s.branch && s.status === 'completed').map((s) => s.branch as string);
        const sKey = intKey;
        planSessions(runId, msKey, [{
          key: sKey, name: `${ms.name} integration`, purpose: `Integrate and validate milestone ${msKey}`,
          prompt: renderPrompt('director.integration_wrapper', {
            instructions: String(args.instructions ?? ''),
            integration_branch: integration,
            session_branches: branches.length ? branches.join(', ') : '(work is already on the integration branch)',
          }),
          dependsOn: [], isolated: false,
        }]);
        patchMilestone(runId, msKey, { status: 'integrating' });
        await launchSession(runId, sKey, args.timeout_minutes ? Number(args.timeout_minutes) : undefined);
        addActivity(runId, 'integration', `${msKey} integration session started`);
        return { ok: true, text: `Integration session ${sKey} started on ${integration}. You will be woken with its outcome.` };
      }

      case 'complete_milestone': {
        const msKey = String(args.milestone ?? '');
        const ms = milestoneByKey(runId, msKey);
        if (!ms) return { ok: false, error: `Unknown milestone: ${msKey}` };
        if (ms.sessions.length === 0) {
          // "complete" must mean work happened — a milestone that became
          // unnecessary is removed from the plan, not vacuously completed
          return { ok: false, error: `Milestone ${msKey} has no sessions — decompose it (plan_milestone_sessions) and do the work, or remove it from the plan (project_set_plan) if it is no longer needed.` };
        }
        const open = ms.sessions.filter((s) => !['completed', 'abandoned'].includes(s.status));
        if (open.length > 0) return { ok: false, error: `Cannot complete ${msKey}: sessions still open (${open.map((s) => s.key).join(', ')}).` };
        // a milestone is not complete while its work is stranded on session branches
        const integration = getRunRaw(runId).integration_branch as string | null;
        if (integration) {
          const rootPath = getProject(run.projectId)!.rootPath;
          const unmerged: string[] = [];
          for (const s of ms.sessions) {
            if (s.branch && s.status === 'completed') {
              const merged = await git(rootPath, ['merge-base', '--is-ancestor', s.branch, integration]);
              if (!merged.ok) unmerged.push(`${s.key} (${s.branch})`);
            }
          }
          if (unmerged.length > 0) {
            return { ok: false, error: `Cannot complete ${msKey}: session work is not merged into ${integration} yet — ${unmerged.join(', ')}. Run integrate_milestone (or a session that performs the merge) first.` };
          }
        }
        patchMilestone(runId, msKey, { status: 'completed' });
        addActivity(runId, 'session', `${msKey} completed: ${String(args.summary ?? '').slice(0, 300)}`);
        return { ok: true, text: `Milestone ${msKey} is complete. Revise later milestones if what you learned changes them, then plan the next ready milestone.` };
      }

      case 'deliver': {
        const raw = getRunRaw(runId);
        const integration = raw.integration_branch as string | null;
        const base = raw.base_branch as string | null;
        if (!integration) return { ok: true, text: 'No integration branch exists — the work already lives on the base branch; nothing to deliver.' };
        if (!base) return { ok: false, error: 'No base branch was recorded for this run — deliver via a session that merges the integration branch into the intended branch (and deletes it), then complete the project.' };
        const rootPath = getProject(run.projectId)!.rootPath;
        const busy = dirBusyWithin(runId, rootPath);
        if (busy) return { ok: false, error: `Session ${busy.key} is working in the project directory — deliver after it finishes.` };
        // ...and nothing OUTSIDE this run either: an ordinary chat running in
        // the same repository must never have the branch switched under it
        const otherChat = repoBusyBy(rootPath, run.chatId);
        if (otherChat) return { ok: false, error: 'Another chat is actively working in this repository right now — deliver once it finishes.' };
        const delivered = await git(rootPath, ['merge-base', '--is-ancestor', integration, base]);
        if (delivered.ok) {
          const co0 = await git(rootPath, ['checkout', base]);
          if (!co0.ok) return { ok: false, error: `${base} already contains ${integration}, but the working tree could not switch to ${base}: ${co0.stderr || 'checkout failed'} — likely uncommitted local changes; resolve them via a session, then deliver again.` };
          return { ok: true, text: `${base} already contains ${integration} — nothing to merge. The repository is on ${base}.` };
        }
        // strict fast-forward only: the engine performs no content decisions.
        // A diverged base means outside interference — that is session work.
        const ffable = await git(rootPath, ['merge-base', '--is-ancestor', base, integration]);
        if (!ffable.ok) {
          return { ok: false, error: `${base} has commits that are not on ${integration} — a fast-forward is impossible. Launch a reconciliation session to merge ${integration} into ${base}, then deliver again.` };
        }
        const co = await git(rootPath, ['checkout', base]);
        if (!co.ok) return { ok: false, error: `Could not switch to ${base}: ${co.stderr || 'checkout failed'} — likely uncommitted local changes; resolve them via a session, then deliver again.` };
        const ff = await git(rootPath, ['merge', '--ff-only', integration]);
        if (!ff.ok) {
          const back = await git(rootPath, ['checkout', integration]); // leave things as found
          return { ok: false, error: `Fast-forward failed: ${ff.stderr}${back.ok ? '' : ` (and switching back to ${integration} also failed: ${back.stderr})`}` };
        }
        const behind = await git(rootPath, ['rev-list', '--count', `${base}..${integration}`]);
        addActivity(runId, 'delivery', `Delivered: ${base} fast-forwarded to ${integration}${behind.ok && behind.stdout === '0' ? '' : ' (verify!)'}`);
        return { ok: true, text: `Delivered — ${base} now equals ${integration}, and the repository is checked out on ${base}.` };
      }

      case 'complete_project': {
        const open = sessionsByStatus(runId, ['running', 'planned', 'timeout', 'needs_attention']);
        if (open.length > 0) return { ok: false, error: `Sessions still open: ${open.map((s) => s.key).join(', ')}.` };
        // COMPLETED must mean complete: every milestone closed, work delivered
        const msOpen = openMilestones(runId);
        if (msOpen.length > 0) {
          return { ok: false, error: `Milestone${msOpen.length === 1 ? '' : 's'} ${msOpen.join(', ')} ${msOpen.length === 1 ? 'is' : 'are'} not completed — complete ${msOpen.length === 1 ? 'it' : 'them'} (complete_milestone) or revise the plan first.` };
        }
        const raw = getRunRaw(runId);
        const rootPath = getProject(run.projectId)!.rootPath;
        if (raw.integration_branch) {
          // an integration branch that no longer exists was dealt with by a
          // session (merged + deleted) — only a LIVE one gates completion
          const integrationExists = (await git(rootPath, ['rev-parse', '--verify', `refs/heads/${raw.integration_branch}`])).ok;
          if (integrationExists && raw.base_branch) {
            const delivered = await git(rootPath, ['merge-base', '--is-ancestor', raw.integration_branch, raw.base_branch]);
            if (!delivered.ok) {
              const behind = await git(rootPath, ['rev-list', '--count', `${raw.base_branch}..${raw.integration_branch}`]);
              return { ok: false, error: `The result is not delivered: ${raw.base_branch} is ${behind.ok ? behind.stdout : 'several'} commits behind ${raw.integration_branch}. Call project_deliver first (or launch a reconciliation session if it reports a diverged base).` };
            }
          } else if (integrationExists && !raw.base_branch) {
            return { ok: false, error: `Delivery cannot be verified: no base branch is recorded for this run (the repository was not on a deliverable branch when ${raw.integration_branch} was created). Launch a session that merges ${raw.integration_branch} into the intended branch and deletes ${raw.integration_branch}, then complete the project.` };
          }
        }
        await cleanupRunWorkspaces(runId, rootPath);
        setRunState(runId, 'COMPLETED', `Project completed: ${String(args.summary ?? '').slice(0, 300)}`);
        return { ok: true, text: 'Project marked complete. Summarize the delivered result for the user.' };
      }

      case 'need_user': {
        setRunState(runId, 'NEEDS_USER', `Waiting for the user: ${String(args.question ?? '').slice(0, 300)}`);
        return { ok: true, text: 'State set to NEEDS_USER. Ask the user the question in your reply.' };
      }

      default:
        return { ok: false, error: `Unknown director operation: ${op}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
