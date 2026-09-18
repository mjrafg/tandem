import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config';
import type { AiCallPayload, AttachmentMeta, Finding, FindingsPayload } from '../../../shared/types';
import { computeUsage, recentConversation, shouldAutoCompact } from '../context';
import { db, getChat, getEvent, getProject } from '../db';
import { addEvent, updateEvent } from '../events';
import { getSettings } from '../settings';
import { builderSystemText, getPrompt, renderPrompt, reviewerSystemText } from '../prompts';
import { executeRole, providerLabel, providerShortLabel } from '../providers/executor';
import { resolveBuilderRole, resolveReviewerRole } from '../providers/resolve';
import { rememberSession, resumableSession, storedSessionRef } from '../providers/sessions';
import { performNativeCompaction } from './providerContext';
import {
  RunHandle, type RunCtx, isRunning, markDanglingStopped, registerCtx, releaseCtx, repoBusyBy, setChatRunning, stopRun,
} from './run';
import { adoptRepo, finishGitRun, summaryText } from './gitFlow';
import { captureReviewBaseline, captureWorktree, changedSince, diffWorktrees, releaseReviewBaseline, repairDiff, revisionHash, signatureMap, type DeltaNoteKind } from './snapshot';
import {
  deletePendingReview, fmtRetryAt, getPendingReview, outageFromFailure, upsertPendingReview,
} from './reviewWait';

export { isRunning, stopRun, applyWorkdirChange } from './run';
export { setGitWorkflow } from './gitFlow';

const BUILDER_TIMEOUT = 30 * 60_000;
const REVIEW_TIMEOUT = 15 * 60_000;
/** the review-loop cap — enforced by the orchestration below, not by prompts */
import { MAX_REVIEW_ROUNDS, deriveLegacyLedger, getLedger, openTask, recordRepair, recordReview, revisionOf, type ReviewLedger } from './reviewLedger';

/** wording for the changed-files note comes from the prompt registry */
interface ReviewDelta { files: string[]; note: string }

/**
 * What a review round examines. Files that actually changed are the strongest
 * evidence; when a run changed nothing on disk (an investigation, an answer,
 * tool use), the Builder's own response is reviewed instead.
 */
type ReviewSubject =
  | { kind: 'changes'; files: string[]; note: string }
  | { kind: 'answer'; answer: string };

/** how much of the Builder's reply is handed to the Reviewer */
const ANSWER_CAP = 24_000;

function subjectFor(delta: ReviewDelta | null, answer: string): ReviewSubject | null {
  if (delta) return { kind: 'changes', files: delta.files, note: delta.note };
  const text = (answer ?? '').trim();
  return text ? { kind: 'answer', answer: text } : null;
}

function capText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]`;
}

function noteFor(kind: DeltaNoteKind): string {
  return getPrompt(kind === 'git' ? 'reviewer.note_git' : kind === 'git_state' ? 'reviewer.note_git_state' : 'reviewer.note_nongit');
}

/**
 * The production run: ONE Builder invocation per user message — the Builder
 * decides what to do. The application's own logic is limited to objective
 * facts: did files actually change (worktree snapshots), the capped review
 * loop, timeouts, and honest bookkeeping. No intent detection anywhere.
 */
export async function startRun(
  chatId: string,
  userText: string,
  attachments: AttachmentMeta[] = [],
  runOpts: { review: boolean; timeoutMs?: number; task?: 'new' | 'continue' } = { review: true },
): Promise<void> {
  const chat = getChat(chatId);
  if (!chat || isRunning(chatId)) return;
  const project = getProject(chat.projectId);
  if (!project) return;

  // hard boundary: two chats switching branches in the same directory at the
  // same time would destroy each other's state
  const busy = repoBusyBy(project.rootPath, chatId);
  if (busy) {
    addEvent(chatId, 'error', {
      message: 'Another chat is actively working in this directory',
      detail: 'Concurrent runs in the same repository are blocked because each chat works on its own Git branch. Try again when the other run finishes.',
      source: 'engine', retryable: true,
    });
    return;
  }

  const ctx: RunCtx = { chatId, runId: randomUUID(), stopped: false, rootPath: project.rootPath };
  registerCtx(ctx);
  setChatRunning(chatId, true);
  // the per-request Reviewer choice is captured here, once, with the run —
  // later composer changes affect only future requests
  addEvent(chatId, 'run', { phase: 'started', review: runOpts.review }, { runId: ctx.runId });

  const h = new RunHandle(ctx, chat, project, attachments);
  try {
    // A run either OPENS a task or CONTINUES one, and the caller knows which:
    // a user message in a chat or a Director launching a session is a new
    // request; a resume or a recovery decision continues the task that stands.
    // The distinction is what keeps the review budget and the original request
    // with the TASK instead of restarting both on every invocation.
    const ledger: ReviewLedger = runOpts.task === 'continue'
      ? (getLedger(chatId) ?? deriveLegacyLedger(chatId) ?? openTask(chatId, userText))
      : openTask(chatId, userText);
    // a NEW request replaces the result an older waiting review was about —
    // that review is superseded, never silently resumed against new work
    if (runOpts.task !== 'continue' && getPendingReview(chatId)) {
      deletePendingReview(chatId);
      h.status('The pending review of the previous result was superseded by this new request.');
    }
    h.gitFlow = (await adoptRepo(h)) ?? undefined;
    const ok = await runWorkflow(h, userText, runOpts, ledger);
    // 'awaiting' = implementation done but the required review is waiting on
    // the provider: no checkpoint/merge (nothing is integrated unreviewed)
    // the checkpoint names the TASK — a continuation's commit must not read
    // "tandem: Your previous run in this session was interrupted…"
    if (ok === true && !ctx.stopped) await finishGitRun(h, ledger.originalRequest);
    addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
  } catch (err) {
    h.error({ message: 'The run failed unexpectedly', detail: String(err), source: 'engine' });
    addEvent(chatId, 'run', { phase: 'failed' }, { runId: ctx.runId });
  } finally {
    markDanglingStopped(chatId, ctx.runId);
    releaseCtx(ctx);
    setChatRunning(chatId, false);
    void maybeAutoCompact(chatId);
  }
}

async function runWorkflow(h: RunHandle, userText: string, runOpts: { review: boolean; timeoutMs?: number; task?: 'new' | 'continue' }, ledger: ReviewLedger): Promise<boolean | 'awaiting'> {
  // per-run override so an orchestrator (or a recovery decision) can grant
  // more time; the default stays the module constant
  const builderTimeout = Math.min(runOpts.timeoutMs ?? BUILDER_TIMEOUT, 90 * 60_000);
  // the chat's immutable Agent snapshot decides model/effort/specialist prompt;
  // chats without one keep the Builder role settings exactly as before
  const builderCfg = resolveBuilderRole(h.settings, h.chat.id);
  const startDir = h.project.rootPath;
  const before = captureWorktree(startDir);
  // the stored session is continued only by the provider that created it; a
  // Builder moved to another backend starts fresh and is seeded from the record
  const stored = storedSessionRef(h.chat.id);
  const resume = resumableSession(stored, builderCfg.provider).session?.id ?? null;

  // ---- Builder does the work (its own decisions, its own tools)
  const first = await executeRole({
    handle: h,
    role: 'builder',
    provider: builderCfg.provider,
    model: builderCfg.model,
    effort: builderCfg.effort,
    systemPrompt: builderSystemText(h.settings, 'builder', h.gitFlow ? summaryText(h.gitFlow) : undefined, builderCfg.agentPrompt),
    userPrompt: builderMessage(h, userText, resume),
    cwd: startDir,
    session: stored,
    timeoutMs: builderTimeout,
  });
  rememberSession(h.chat.id, first.session);
  if (h.stopped) return false;
  if (first.status !== 'completed') {
    h.error({ message: 'Builder call failed', detail: first.failure?.message, source: 'builder', retryable: true });
    return false;
  }

  // ---- what did the run actually change on disk? (objective, not predicted)
  h.refresh();
  const endDir = h.project.rootPath;
  const delta = reviewGate(before, startDir, endDir, h);

  // The user's per-request choice decides WHETHER a review happens; the disk
  // delta only decides what the Reviewer is shown. With the Reviewer on, a run
  // that changed no files still gets reviewed — on its response.
  if (!runOpts.review) {
    // an orchestration choice, recorded honestly (not a failure or unavailability)
    if (delta) h.status('Reviewer skipped by user for this request.');
    return true;
  }
  if (h.settings.roles.reviewer.enabled === false) return true;

  const subject = subjectFor(delta, first.answer);
  if (!subject) return true; // the run produced neither changes nor a response

  // The budget belongs to the task, not to this invocation. A continuation of a
  // task whose two rounds are spent gets no third opinion — exactly the cap the
  // policy already promises for the final repair — and says so.
  const consumed = ledger.reviewsConsumed;
  if (consumed >= MAX_REVIEW_ROUNDS) {
    h.status(`The review budget for this task is already spent (${consumed} of ${MAX_REVIEW_ROUNDS} rounds) — `
      + 'this continuation is NOT reviewed. It is preserved as delivered, and it carries no reviewer approval: '
      + `the last recorded verdict for this task is ${ledger.lastVerdict ?? 'none'}.`);
    return true;
  }
  // a revision the Reviewer already accepted has nothing new to judge
  if (ledger.lastVerdict === 'pass' && ledger.reviewedRevision === revisionOf(revisionHash(h.project.rootPath, captureWorktree(h.project.rootPath)), subject)) {
    h.status('This result is the revision the Reviewer already accepted — nothing new to review.');
    return true;
  }
  const phase = await runReviewPhase(h, ledger.originalRequest, {
    round: (consumed + 1) as 1 | 2, subject, before, startDir, builderTimeout, retry: false,
    steering: runOpts.task === 'continue' ? userText : undefined,
  });
  if (phase === 'done') return true;
  if (phase === 'awaiting') return 'awaiting';
  return false; // 'stopped' | 'failed'
}

// ---------------------------------------------------------------- review phase

type PhaseOutcome = 'done' | 'awaiting' | 'stopped' | 'failed';

/**
 * The capped review loop from a given round onward: review → repair → last
 * review. Entered at round 1 by every normal run, and re-entered at the
 * PERSISTED round by a review retry after a Reviewer provider outage — so a
 * failed provider attempt never consumes a round, and a successful retry
 * continues the exact same policy.
 *
 * A repair only ever runs when a review round remains to verify it. When the
 * cap is reached the findings are reported and the work is preserved as it
 * stands; the loop no longer spends a Builder invocation nobody will check.
 */
async function runReviewPhase(h: RunHandle, userText: string, opts: {
  round: 1 | 2;
  subject: ReviewSubject;
  before: ReturnType<typeof captureWorktree>;
  startDir: string;
  builderTimeout: number;
  /** true when re-entered by the retry sweeper (a provider-wait already stands) */
  retry: boolean;
  /** repair context rebuilt from events when a retry re-enters at a later round */
  replayRepair?: RepairContext;
  /** the continuation/recovery instruction this run was started with, if any */
  steering?: string;
}): Promise<PhaseOutcome> {
  // repairs run on the SAME snapshot the first turn used — an admin editing the
  // Agent template mid-session never changes what this session executes
  const builderCfg = resolveBuilderRole(h.settings, h.chat.id);
  let subject2 = opts.subject;
  let repairContext: RepairContext | undefined = opts.replayRepair;

  if (opts.round === 1) {
    const round1 = await review(h, userText, opts.subject, 1, opts.steering);
    if (h.stopped || 'stopped' in round1) return 'stopped';
    if ('outage' in round1) return recordReviewWait(h, userText, 1, opts.subject, round1.outage);
    if ('failure' in round1) return reviewerFailed(h, userText, 1, opts.subject, round1.failure, opts.retry);
    if (round1.verdict === 'pass') return 'done';

    // ---- repair
    // The state the Reviewer just judged: content signatures, the commit it saw,
    // and private copies of whatever git cannot baseline. Compared after the
    // repair this yields the paths the repair actually touched — which git
    // porcelain cannot tell apart from the edit before it — and a diff that
    // survives the Builder committing its own repair.
    const reviewedBaseline = captureReviewBaseline(h.project.rootPath, path.join(config.dataDir, 'tmp'));

    // A due compaction belongs HERE, at a boundary where no CLI is live and the
    // session is resumable, rather than only after the whole run: the repair and
    // the last review would otherwise each carry the full pre-compaction
    // context. Inside a run the chat is legitimately "running", so this boundary
    // call says so explicitly.
    await maybeAutoCompact(h.chat.id, { atRunBoundary: true });
    h.refresh();

    const repair = await executeRole({
      handle: h,
      role: 'builder',
      provider: builderCfg.provider,
      model: builderCfg.model,
      effort: builderCfg.effort,
      systemPrompt: builderSystemText(h.settings, 'builder', h.gitFlow ? summaryText(h.gitFlow) : undefined, builderCfg.agentPrompt),
      userPrompt: renderPrompt(
        opts.subject.kind === 'answer' ? 'repair.answer_findings_message' : 'repair.findings_message',
        { findings: findingsAsText(round1.items) },
      ),
      cwd: h.project.rootPath,
      session: storedSessionRef(h.chat.id),
      timeoutMs: opts.builderTimeout,
    });
    rememberSession(h.chat.id, repair.session);
    recordRepair(h.chat.id, false);
    if (h.stopped) return 'stopped';
    if (repair.status !== 'completed') {
      h.error({ message: 'Builder repair call failed', detail: repair.failure?.message, source: 'builder', retryable: true });
      return 'failed';
    }

    // what the repair actually changed, independent of what it said it changed
    const changedPaths = changedSince(reviewedBaseline.signatures, signatureMap(h.project.rootPath));
    const rd = repairDiff(h.project.rootPath, reviewedBaseline, changedPaths, 12_000);
    releaseReviewBaseline(reviewedBaseline);
    repairContext = {
      previousFindings: round1.items,
      previousReview: round1.text,
      handoff: repair.answer,
      changedPaths,
      diff: rd.text,
      diffNote: rd.note,
    };

    // the repair may have produced files — re-check the disk before deciding
    // what the last round reviews
    h.refresh();
    const delta2 = reviewGate(opts.before, opts.startDir, h.project.rootPath, h, true);
    // on a RETRY, `before` was captured after the original build, so a repair
    // that changed nothing yields no delta — the honest evidence is then still
    // the persisted changes subject, never a downgrade to the repair's reply
    subject2 = delta2
      ? ({ kind: 'changes', ...currentDelta(h) } as ReviewSubject)
      : opts.retry && opts.subject.kind === 'changes'
        ? opts.subject
        : subjectFor(null, repair.answer) ?? opts.subject;
  }

  // ---- round 2 (the last review)
  const round2 = await review(h, userText, subject2, 2, opts.steering, repairContext);
  if (h.stopped || 'stopped' in round2) return 'stopped';
  if ('outage' in round2) return recordReviewWait(h, userText, 2, subject2, round2.outage);
  if ('failure' in round2) return reviewerFailed(h, userText, 2, subject2, round2.failure, opts.retry);
  if (round2.verdict === 'pass') return 'done';

  // ---- the cap is reached: report the findings, repair nothing
  // A repair with no round left to verify it is a Builder invocation whose
  // result nobody checks. The workflow used to spend one anyway and label it
  // "not re-reviewed"; the open findings are the honest deliverable instead.
  updateEvent(round2.eventId, { repairSkippedAtCap: true });
  const open = round2.items.map((f) => `${f.severity}: ${f.title}`).join(' · ').slice(0, 600);
  h.status(`Review complete: ${MAX_REVIEW_ROUNDS} of ${MAX_REVIEW_ROUNDS} rounds spent and the verdict is FINDINGS. `
    + 'No further repair was started, because no review round remains to verify one — the work is preserved '
    + `exactly as the Reviewer last saw it. Open findings: ${open || '(see the findings above)'}`);
  return 'done';
}

/**
 * Rebuild a repair review's context after a restart, from the durable record.
 *
 * An outage retry re-enters at the persisted round in a fresh process, so the
 * in-memory context from the original run is gone. Findings, the Reviewer's own
 * previous reply and the Builder's hand-off all survive as events; the tree
 * signature taken before the repair does not, so the changed paths are reported
 * as unavailable rather than guessed. Absent evidence is labelled absent.
 */
function replayRepairContext(chatId: string, round: number): RepairContext | undefined {
  const prev = lastFindings(chatId, round - 1);
  if (!prev) return undefined;
  const rows = db.prepare("SELECT kind, payload, seq FROM events WHERE chat_id = ? AND kind = 'ai_call' ORDER BY seq").all(chatId) as { payload: string; seq: number }[];
  const calls = rows.map((r) => ({ seq: r.seq, p: JSON.parse(r.payload) as AiCallPayload }));
  const lastOf = (role: string) => [...calls].reverse().find((c) => c.p.role === role)?.p.response?.text ?? '';
  return {
    previousFindings: prev.items,
    previousReview: lastOf('reviewer'),
    handoff: lastOf('builder'),
    changedPaths: [],
    diff: null,
    diffNote: '(this review is a retry after an interruption, so the file-level comparison against the reviewed '
      + 'state could not be reproduced. Re-establish what the repair changed yourself before relying on it)',
  };
}

/** The most recent verdict of `round` in a chat. */
function lastFindings(chatId: string, round: number): { eventId: string; items: Finding[] } | null {
  const r = db.prepare("SELECT id, payload FROM events WHERE chat_id = ? AND kind = 'findings' ORDER BY seq DESC LIMIT 1").get(chatId) as { id: string; payload: string } | undefined;
  if (!r) return null;
  const p = JSON.parse(r.payload) as FindingsPayload;
  return p.round === round ? { eventId: r.id, items: p.items ?? [] } : null;
}

/**
 * A temporary provider condition (usage limit / quota / rate limit) stopped the
 * required review. The result stays intact and UNREVIEWED, the exact review is
 * persisted for the sweeper, and the failed attempt consumes no round.
 */
function recordReviewWait(
  h: RunHandle, userText: string, round: 1 | 2, subject: ReviewSubject,
  outage: { reason: string; retryAt: number; detail: string; transient?: boolean },
): PhaseOutcome {
  const wait = upsertPendingReview({
    chatId: h.chat.id, round, userText, subject,
    reason: outage.reason, detail: outage.detail, retryAt: outage.retryAt, transient: outage.transient,
  });
  outage = { ...outage, retryAt: wait.retryAt };
  h.status(`Implementation complete — the required review could not run: ${outage.reason}. `
    + `Retry at ${fmtRetryAt(outage.retryAt)}. This result has NOT been reviewed and is not complete; `
    + 'work that depends on it stays blocked until the review succeeds.');
  return 'awaiting';
}

/**
 * A Reviewer failure that is NOT a recognized provider outage. On a normal run
 * this keeps the long-standing behavior: the run completes, loudly marked
 * unreviewed. On a RETRY the session is already in the blocking awaiting state —
 * dropping out of it on an unclassified error would silently degrade the review
 * policy, so the wait stands and the sweeper tries again after a default backoff.
 */
function reviewerFailed(
  h: RunHandle, userText: string, round: 1 | 2, subject: ReviewSubject, error: string, retry: boolean,
): PhaseOutcome {
  if (retry) {
    return recordReviewWait(h, userText, round, subject, {
      reason: 'Reviewer failure (will retry)', detail: error, retryAt: Date.now() + 15 * 60_000,
    });
  }
  h.error({ message: 'Reviewer could not run', detail: error, source: 'reviewer', retryable: true });
  h.status('The review loop stopped because the Reviewer failed — the result above has NOT been reviewed.');
  return 'done';
}

/**
 * Retry a persisted pending review: the SAME review round against the SAME
 * result, on the same chat — no new session, no Builder re-run, no extra round.
 * Invoked by the retry sweeper once retry_at passes. A verdict is then handled
 * by the normal policy (PASS completes; FINDINGS get the usual repair path).
 *
 * Returns null WITHOUT any side effect when the retry cannot start right now
 * (chat busy, directory owned by another run, pending gone) — the caller must
 * treat that as "not attempted", never as a run that produced an outcome: a
 * monitored empty outcome once misclassified the session as failed and
 * destroyed the pending review.
 */
export function startReviewRetry(chatId: string): Promise<void> | null {
  const chat = getChat(chatId);
  if (!chat || isRunning(chatId)) return null;
  const pending = getPendingReview(chatId);
  if (!pending) return null;
  const project = getProject(chat.projectId);
  if (!project) return null;
  if (repoBusyBy(project.rootPath, chatId)) return null; // another chat owns the directory — the sweeper tries again

  const ctx: RunCtx = { chatId, runId: randomUUID(), stopped: false, rootPath: project.rootPath };
  registerCtx(ctx);
  setChatRunning(chatId, true);
  return (async () => {
    addEvent(chatId, 'run', { phase: 'started', review: true }, { runId: ctx.runId });
    const h = new RunHandle(ctx, chat, project, []);
    try {
      // an admin who turned the Reviewer OFF dissolved the review requirement:
      // finish the run the way a reviewer-off run finishes — loudly unreviewed
      if (h.settings.roles.reviewer.enabled === false) {
        deletePendingReview(chatId);
        h.gitFlow = (await adoptRepo(h)) ?? undefined;
        h.status('The Reviewer was disabled in Settings while this review was waiting — the pending review was dropped and the result remains unreviewed.');
        if (!ctx.stopped) await finishGitRun(h, pending.userText);
        addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
        return;
      }
      h.gitFlow = (await adoptRepo(h)) ?? undefined;
      // the ledger, not the pending row, owns the round and the request: the
      // pending row was written by whichever invocation was refused, and that
      // may have been a continuation carrying the recovery text as its request
      const ledger = getLedger(chatId) ?? deriveLegacyLedger(chatId);
      const originalRequest = ledger?.originalRequest ?? pending.userText;
      // A verdict can commit and the process die before this row is deleted.
      // Then the review this wait was for is already recorded, and retrying it
      // would be a third round: the row is stale, not the review. Nothing is
      // repaired here either — the cap that forbids an unverifiable repair
      // during the run forbids it on the replay too.
      if (ledger && ledger.reviewsConsumed >= MAX_REVIEW_ROUNDS) {
        const openFindings = ledger.lastVerdict === 'findings';
        h.status(`The review this wait was for has already been recorded (${ledger.reviewsConsumed} of ${MAX_REVIEW_ROUNDS} rounds spent, last verdict: ${ledger.lastVerdict}) — nothing to retry.`
          + (openFindings ? ' Its findings stand open: no repair is started without a review round to verify it.' : ''));
        deletePendingReview(chatId);
        if (!ctx.stopped) await finishGitRun(h, originalRequest);
        addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
        return;
      }
      const round = (ledger ? ledger.reviewsConsumed + 1 : pending.round) as 1 | 2;
      h.status(`Retrying the required review (round ${round}, attempt ${pending.attempts + 1}) against the same result.`);
      const outcome = await runReviewPhase(h, originalRequest, {
        round,
        replayRepair: round > 1 ? replayRepairContext(chatId, round) : undefined,
        steering: ledger && pending.userText.trim() !== ledger.originalRequest.trim() ? pending.userText : undefined,
        subject: pending.subject,
        before: captureWorktree(h.project.rootPath),
        startDir: h.project.rootPath,
        builderTimeout: BUILDER_TIMEOUT,
        retry: true,
      });
      if (outcome === 'done') {
        deletePendingReview(chatId);
        if (!ctx.stopped) await finishGitRun(h, originalRequest); // the checkpoint names the task
      } else if (outcome === 'failed' || outcome === 'stopped') {
        // an interrupted or failed retry must not hot-loop the sweeper: the wait
        // stands, but the next attempt backs off instead of firing immediately
        const p = getPendingReview(chatId);
        if (p) upsertPendingReview({ ...p, retryAt: Date.now() + 15 * 60_000, attempts: p.attempts });
      }
      addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
    } catch (err) {
      h.error({ message: 'The run failed unexpectedly', detail: String(err), source: 'engine' });
      addEvent(chatId, 'run', { phase: 'failed' }, { runId: ctx.runId });
    } finally {
      markDanglingStopped(chatId, ctx.runId);
      releaseCtx(ctx);
      setChatRunning(chatId, false);
      void maybeAutoCompact(chatId);
    }
  })();
}

// ---------------------------------------------------------------- review gate

/** Objective file-level evidence from the RESULTING STATE; null = nothing changed. */
function reviewGate(
  before: ReturnType<typeof captureWorktree>,
  startDir: string,
  endDir: string,
  h: RunHandle,
  quiet = false,
): ReviewDelta | null {
  if (endDir === startDir) {
    const delta = diffWorktrees(before, captureWorktree(endDir));
    return delta.changed ? { files: delta.files, note: noteFor(delta.noteKind) } : null;
  }
  // the Builder moved the chat to a different directory during the run
  const after = captureWorktree(endDir);
  if (after.kind === 'git') {
    if (after.files.size === 0) return null; // clean tree (e.g. fresh clone): nothing modified
    return {
      files: [...after.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: renderPrompt('reviewer.note_switched', { new_dir: endDir }),
    };
  }
  if (!quiet) {
    h.status('The working directory changed mid-run and the new directory has no baseline to diff against — no file-level evidence for this review.');
  }
  return null;
}

function currentDelta(h: RunHandle): ReviewDelta {
  const state = captureWorktree(h.project.rootPath);
  if (state.kind === 'git') {
    return {
      files: [...state.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: state.files.size > 0 ? getPrompt('reviewer.note_git') : getPrompt('reviewer.note_git_clean'),
    };
  }
  return { files: [], note: getPrompt('reviewer.note_nongit_inspect') };
}

// ---------------------------------------------------------------- reviewer

/** what a repair review is given beyond the original request (§ repair_section) */
interface RepairContext {
  previousFindings: Finding[];
  /** the previous Reviewer's own account of what it checked — its reply, capped */
  previousReview: string;
  /** the Builder's description of its repair; a claim, never evidence */
  handoff: string;
  /** paths whose CONTENT changed since the reviewed state */
  changedPaths: string[];
  /** the real diff for those paths, or null when one cannot be produced */
  diff: string | null;
  /** why there is no diff — shown verbatim, so absent evidence reads as absent */
  diffNote: string;
}

type ReviewResult =
  | { verdict: 'pass' | 'findings'; items: Finding[]; eventId: string; text: string }
  | { outage: { reason: string; retryAt: number; detail: string } } // temporary provider condition — retryable
  | { failure: string }                                             // any other Reviewer failure
  | { stopped: true };

async function review(h: RunHandle, originalRequest: string, subject: ReviewSubject, round: number, steering?: string, repair?: RepairContext): Promise<ReviewResult> {
  h.status(round === 1 ? 'Reviewer is checking the result…' : 'Reviewer is checking the repaired result…');
  const cfg = resolveReviewerRole(h.settings);
  const evidence = subject.kind === 'changes'
    ? renderPrompt('reviewer.changed_section', {
      changed_files_note: subject.note,
      changed_files: subject.files.map((f) => `- ${f}`).join('\n') || getPrompt('reviewer.changed_empty'),
    })
    : renderPrompt('reviewer.answer_section', { builder_answer: capText(subject.answer, ANSWER_CAP) });
  const prompt = [
    renderPrompt('reviewer.request_section', { original_request: originalRequest }),
    // a continuation is context the Reviewer should know about, never the request
    ...(steering && steering.trim() !== originalRequest.trim() ? [renderPrompt('reviewer.continuation_section', { continuation: steering })] : []),
    evidence,
    // A repair review that is handed only the original request starts the whole
    // job again: in one audited session an eight-line repair drew a 317-second
    // re-verification, longer than the first review. What it lacked was the
    // record of its own previous round.
    ...(repair ? [renderPrompt('reviewer.repair_section', {
      previous_findings: findingsAsText(repair.previousFindings) || '(none recorded)',
      previous_review: capText(repair.previousReview, 4_000) || '(the previous reply was not recorded)',
      builder_handoff: capText(repair.handoff, 3_000) || '(the Builder described no repair)',
      changed_paths: repair.changedPaths.length > 0
        ? repair.changedPaths.slice(0, 60).map((f) => `- ${f}`).join('\n')
        : '- (no file content changed since the reviewed state)',
      repair_diff: repair.diff ?? repair.diffNote,
    })] : []),
    renderPrompt('reviewer.round_section', { review_round: round, max_review_rounds: MAX_REVIEW_ROUNDS }),
    getPrompt('reviewer.output_format'),
  ].join('\n\n');

  // mark the phase so Builder-only app-state tools are refused server-side
  // while the Reviewer is the one running
  h.ctx.phase = 'reviewer';
  let result;
  try {
    // every review is a FRESH provider context: no session is offered, so the
    // Reviewer cannot inherit the Builder's conversation whatever backend
    // either of them runs on
    result = await executeRole({
      handle: h,
      role: 'reviewer',
      provider: cfg.provider,
      model: cfg.model,
      effort: cfg.effort,
      systemPrompt: reviewerSystemText(h.settings),
      userPrompt: prompt,
      cwd: h.project.rootPath,
      emitActivity: false,
      timeoutMs: REVIEW_TIMEOUT,
    });
  } finally {
    h.ctx.phase = 'builder';
  }
  if (h.stopped) return { stopped: true };
  if (result.status !== 'completed') {
    // a temporary provider condition (quota / rate limit / overload) is the
    // caller's signal to WAIT instead of degrading the review policy
    const outage = outageFromFailure(result.failure, providerShortLabel(cfg.provider));
    if (outage) return { outage: { ...outage, detail: result.failure?.message ?? '' } };
    return { failure: result.failure?.message ?? 'The Reviewer failed.' };
  }

  const { verdict, items } = parseVerdict(result.answer);
  const payload: FindingsPayload = { verdict, round, items };
  // the verdict and the round it consumed are one fact: either both are
  // durable or neither is, so no crash can leave a review spent but unrecorded
  // (or recorded but unspent)
  const ev = db.transaction(() => {
    const e = addEvent(h.chat.id, 'findings', payload, { runId: h.ctx.runId });
    recordReview(h.chat.id, round, verdict, revisionOf(revisionHash(h.project.rootPath, captureWorktree(h.project.rootPath)), subject));
    return e;
  })();
  return { verdict, items, eventId: ev.id, text: result.answer };
}

/** Parse the Reviewer's contracted output format (protocol, not intent). */
export function parseVerdict(text: string): { verdict: 'pass' | 'findings'; items: Finding[] } {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (/^`?PASS`?\b/i.test(firstLine)) return { verdict: 'pass', items: [] };

  const items: Finding[] = [];
  const lines = text.split('\n');
  let current: Finding | null = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*\d+\.\s*\[(major|minor)\]\s*(.+)$/i);
    if (m) {
      if (current) items.push(current);
      let title = m[2].trim();
      let file: string | undefined;
      let lineNo: number | undefined;
      const loc = title.match(/\s[—–-]\s*(\S+?)(?::(\d+))?\s*$/);
      if (loc && /[./]/.test(loc[1])) {
        file = loc[1].replace(/[`(),]/g, '');
        if (loc[2]) lineNo = Number(loc[2]);
        title = title.slice(0, loc.index).trim();
      }
      current = { severity: m[1].toLowerCase() as 'major' | 'minor', title: title.replace(/`/g, ''), file, line: lineNo, detail: '' };
      continue;
    }
    if (current && raw.trim()) {
      const rec = raw.trim().match(/^Recommendation:\s*(.+)$/i);
      if (rec) current.recommendation = rec[1];
      else current.detail = current.detail ? `${current.detail} ${raw.trim()}` : raw.trim();
    }
  }
  if (current) items.push(current);
  if (items.length === 0) {
    items.push({ severity: 'major', title: 'Reviewer reported issues (unstructured output)', detail: text.trim().slice(0, 4_000) });
  }
  return { verdict: 'findings', items };
}

function findingsAsText(items: Finding[]): string {
  return items.map((f, i) =>
    `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n   ${f.detail}${f.recommendation ? `\n   Recommendation: ${f.recommendation}` : ''}`).join('\n');
}

// ---------------------------------------------------------------- prompts
// All static wording comes from the prompt registry (Admin → AI Prompts).
// Do not add literal instruction strings here — add them to prompts.ts.

function builderMessage(h: RunHandle, userText: string, resumeSessionId: string | null): string {
  const parts: string[] = [];
  if (!resumeSessionId) {
    // fresh CLI session: seed continuity from the stored record
    const compaction = latestCompactionSummary(h);
    const recent = recentConversation(h.chat.id, h.settings.context.preserveRecentTokens * 4, true);
    if (compaction) parts.push(renderPrompt('builder.continuation_compacted', { compacted_context: compaction }));
    if (recent.trim()) parts.push(renderPrompt('builder.continuation_recent', { recent_conversation: recent }));
  }
  let body = userText.trim();
  if (h.attachments.length > 0) {
    const attachmentList = h.attachments.map((a) => `- ${a.path} (${Math.round(a.size / 1024)} KB)`).join('\n');
    body += `\n\n${renderPrompt('builder.attachments', { attachment_list: attachmentList })}`;
  }
  parts.push(parts.length > 0 ? renderPrompt('builder.new_request', { user_message: body }) : body);
  return parts.join('\n\n');
}

function latestCompactionSummary(h: RunHandle): string | null {
  const ev = h.chat.lastCompactionEventId ? getEvent(h.chat.lastCompactionEventId) : null;
  return ev ? (ev.payload as any).summary ?? null : null;
}

// ---------------------------------------------------------------- auto-compact

/**
 * Threshold check → provider-native compaction. No summarizer model, no
 * orchestration: the provider that owns the session compacts its own context.
 * Runs only when the meter has a real provider-reported percentage.
 */
/** a failed compaction backs off instead of re-erroring after every run */
const compactFailedAt = new Map<string, number>();
const COMPACT_RETRY_COOLDOWN = 15 * 60_000;

/**
 * @param opts.atRunBoundary called from INSIDE a live run, at a point where no
 * CLI is running and the provider session is resumable. The chat is legitimately
 * marked running then, so the busy check that protects external callers would
 * otherwise skip the compaction that boundary exists for.
 */
async function maybeAutoCompact(chatId: string, opts: { atRunBoundary?: boolean } = {}): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.context.autoCompact) return;
    const chat = getChat(chatId);
    if (!chat || (!opts.atRunBoundary && isRunning(chatId))) return;
    if (!shouldAutoCompact(computeUsage(chat), settings.context)) return;
    if ((compactFailedAt.get(chatId) ?? 0) > Date.now() - COMPACT_RETRY_COOLDOWN) return;
    const outcome = await performNativeCompaction(chat, 'auto'); // emits its own compaction/error events
    if (outcome.ok) compactFailedAt.delete(chatId);
    else compactFailedAt.set(chatId, Date.now());
  } catch (err) {
    addEvent(chatId, 'error', { message: 'Automatic native compaction failed', detail: String(err), source: 'context' });
  }
}
