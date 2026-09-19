import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from '../config';
import type { AiCallPayload, ArbitrationItem, AttachmentMeta, Finding, FindingResponse, FindingsPayload, ReviewFindingRecord } from '../../../shared/types';
import { computeUsage, recentConversation, shouldAutoCompact } from '../context';
import { db, getChat, getEvent, getProject } from '../db';
import { addEvent, updateEvent } from '../events';
import { getSettings } from '../settings';
import { builderSystemText, getPrompt, renderPrompt, reviewerSystemText } from '../prompts';
import { executeRole, providerLabel, providerShortLabel } from '../providers/executor';
import { resolveBuilderRole, resolveBuilderReviewerRole } from '../providers/resolve';
import { rememberSession, resumableSession, storedSessionRef } from '../providers/sessions';
import { performNativeCompaction } from './providerContext';
import { arbitrate, dispositionsAsText, mandatedAsText, parseDispositions, type Disputed } from './arbitration';
import { applyArbitration, applyDispositions, closedFindings as closedFindingRecords, listFindings, markRepairClaimed, markRepairFailed, markRestated, markVerified, raiseFindings, unsettledFindings } from './findings';
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
import { MAX_REVIEW_ROUNDS, deriveLegacyLedger, getLedger, openTask, recordClosedFindings, recordRepair, recordResolution, recordReview, revisionOf, type ReviewLedger } from './reviewLedger';

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
  const resume = resumableSession(stored, builderCfg.provider, 'builder').session?.id ?? null;

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
  if (h.settings.roles.builder_reviewer.enabled === false) return true;

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
  if ((ledger.lastVerdict === 'pass' || ledger.lastVerdict === 'resolved') && ledger.reviewedRevision === revisionOf(revisionHash(h.project.rootPath, captureWorktree(h.project.rootPath)), subject)) {
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
 * The bounded review loop. Entered at round 1 by every normal run, and
 * re-entered at the PERSISTED round by a review retry after a Reviewer
 * provider outage — so a failed provider attempt never consumes a round, and a
 * successful retry continues the exact same policy.
 *
 *   review 1  →  Builder response (fixes what it accepts, answers the rest)
 *             →  Director arbitration of what the Builder rejected/escalated;
 *                a repair only for what the Director requires
 *   review 2  →  verifies the repaired findings by id, looks for NEW problems;
 *                a repair that did not hold reopens the SAME finding as
 *                repair_failed — it is never raised again as a new one
 *             →  ONE final Builder pass over new findings, failed repairs and
 *                Director-required changes
 *             →  the Director's FINAL decision: what blocks, may it proceed
 *
 * There is no third review. The final pass is not re-reviewed: a repair it
 * claims is recorded as unverified and the Director decides whether that
 * uncertainty is acceptable — recorded, never assumed.
 *
 * Every finding keeps one identity (F-001…) from the round that raised it to
 * its final state, in the review_findings registry; the events are the
 * timeline of how it got there.
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
  /** verification scope rebuilt from the registry when a retry re-enters at round 2 */
  replayScope?: VerifyScope;
  /** the continuation/recovery instruction this run was started with, if any */
  steering?: string;
}): Promise<PhaseOutcome> {
  // repairs run on the SAME snapshot the first turn used — an admin editing the
  // Agent template mid-session never changes what this session executes
  const builderCfg = resolveBuilderRole(h.settings, h.chat.id);
  const taskSeq = getLedger(h.chat.id)?.taskSeq ?? 0;
  let subject2 = opts.subject;
  let repairContext: RepairContext | undefined = opts.replayRepair;
  let scope: VerifyScope | undefined = opts.replayScope;

  const builderTurn = (message: string) => executeRole({
    handle: h,
    role: 'builder',
    provider: builderCfg.provider,
    model: builderCfg.model,
    effort: builderCfg.effort,
    systemPrompt: builderSystemText(h.settings, 'builder', h.gitFlow ? summaryText(h.gitFlow) : undefined, builderCfg.agentPrompt),
    userPrompt: message,
    cwd: h.project.rootPath,
    session: storedSessionRef(h.chat.id),
    timeoutMs: opts.builderTimeout,
  });
  const closedList = () => closedFindingRecords(h.chat.id, taskSeq).map((c) => ({ id: c.id, title: c.title, severity: c.severity, decision: c.state as 'builder_upheld' | 'non_blocking' | 'deferred', reason: c.arbitrationReason ?? '', round: c.round }));
  const describe = (f: ReviewFindingRecord) => `${f.id} [${f.severity}] ${f.title}`;
  const findingOf = (f: ReviewFindingRecord): Finding => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.category ? { category: f.category } : {}), ...(f.recommendation ? { recommendation: f.recommendation } : {}) });

  if (opts.round === 1) {
    const round1 = await review(h, userText, opts.subject, 1, opts.steering);
    if (h.stopped || 'stopped' in round1) return 'stopped';
    if ('outage' in round1) return recordReviewWait(h, userText, 1, opts.subject, round1.outage);
    if ('failure' in round1) return reviewerFailed(h, userText, 1, opts.subject, round1.failure, opts.retry);
    if (round1.verdict === 'pass') return 'done';

    // The state the Reviewer just judged: content signatures, the commit it saw,
    // and private copies of whatever git cannot baseline. Compared after the
    // Builder's response this yields the paths it actually touched — which git
    // porcelain cannot tell apart from the edit before it — and a diff that
    // survives the Builder committing its own repair.
    const reviewedBaseline = captureReviewBaseline(h.project.rootPath, path.join(config.dataDir, 'tmp'));
    const changedSoFar = () => {
      const paths = changedSince(reviewedBaseline.signatures, signatureMap(h.project.rootPath));
      const rd = repairDiff(h.project.rootPath, reviewedBaseline, paths, 12_000);
      return { paths, diff: rd.text, note: rd.note };
    };

    // A due compaction belongs HERE, at a boundary where no CLI is live and the
    // session is resumable, rather than only after the whole run: the response
    // and the last review would otherwise each carry the full pre-compaction
    // context. Inside a run the chat is legitimately "running", so this boundary
    // call says so explicitly.
    await maybeAutoCompact(h.chat.id, { atRunBoundary: true });
    h.refresh();

    // ---- the Builder answers the findings: fixes what it accepts, its own way
    const response = await builderTurn([
      renderPrompt(opts.subject.kind === 'answer' ? 'repair.answer_findings_message' : 'repair.findings_message', { findings: findingsAsText(round1.items) }),
      getPrompt('repair.disposition_format'),
    ].join('\n\n'));
    rememberSession(h.chat.id, response.session);
    recordRepair(h.chat.id, false);
    if (h.stopped) { releaseReviewBaseline(reviewedBaseline); return 'stopped'; }
    if (response.status !== 'completed') {
      releaseReviewBaseline(reviewedBaseline);
      h.error({ message: 'Builder repair call failed', detail: response.failure?.message, source: 'builder', retryable: true });
      return 'failed';
    }
    const dispositions = parseDispositions(response.answer, round1.items);
    applyDispositions(h.chat.id, dispositions);
    addEvent(h.chat.id, 'finding_dispositions', { round: 1, items: dispositions }, { runId: h.ctx.runId });
    const count = (d: FindingResponse['disposition']) => dispositions.filter((x) => x.disposition === d).length;
    h.status(`The Builder answered the ${dispositions.length} finding${dispositions.length === 1 ? '' : 's'}: `
      + `${count('accepted')} accepted, ${count('partially_accepted')} partially accepted, ${count('rejected')} rejected, ${count('cannot_address')} escalated`
      + (dispositions.some((d) => d.source === 'assumed') ? ' (findings it did not answer are recorded as accepted)' : '') + '.');

    // ---- the Director decides what the Builder did not accept
    let handoff = response.answer;
    let mandated: ArbitrationItem[] = [];
    let undecided: ArbitrationItem[] = [];
    const disputed: Disputed[] = dispositions
      .filter((d) => d.disposition === 'rejected' || d.disposition === 'cannot_address')
      .map((d) => ({ finding: round1.items[d.index - 1], response: d, index: d.index }));
    if (disputed.length > 0) {
      h.status(`${disputed.length} finding${disputed.length === 1 ? '' : 's'} the Builder rejected or escalated go${disputed.length === 1 ? 'es' : ''} to the Project Director for a decision.`);
      const sofar = changedSoFar();
      const arb = await arbitrate(h, {
        round: 1, disputed, originalRequest: userText, steering: opts.steering,
        builderHandoff: response.answer, changedPaths: sofar.paths, diff: sofar.diff, diffNote: sofar.note,
        closed: closedList(), final: false,
      });
      applyArbitration(h.chat.id, arb.items, { final: false });
      addEvent(h.chat.id, 'arbitration', arb, { runId: h.ctx.runId });
      if (h.stopped) { releaseReviewBaseline(reviewedBaseline); return 'stopped'; }
      const closed = arb.items.filter((a) => a.decision === 'builder_upheld' || a.decision === 'non_blocking' || a.decision === 'deferred');
      recordClosedFindings(h.chat.id, closed.map((a) => ({ id: a.id, title: a.title, severity: a.severity, decision: a.decision as 'builder_upheld' | 'non_blocking' | 'deferred', reason: a.reason, round: 1 })));
      mandated = arb.items.filter((a) => a.decision === 'reviewer_upheld' || a.decision === 'different_resolution_required');
      undecided = arb.items.filter((a) => a.decision === 'unresolved');
      h.status(arb.failed
        ? `The Director could not decide (${arb.failed}); the ${disputed.length} disputed finding${disputed.length === 1 ? ' stands' : 's stand'} open.`
        : `The Director decided: ${arb.items.map((a) => `${a.id ?? a.title} — ${a.decision.replace(/_/g, ' ')}`).join('; ')}.`);

      // ---- only what the Director requires is repaired
      if (mandated.length > 0) {
        const repair = await builderTurn(renderPrompt('repair.mandated_message', { findings: mandatedAsText(mandated) }));
        rememberSession(h.chat.id, repair.session);
        recordRepair(h.chat.id, false);
        if (h.stopped) { releaseReviewBaseline(reviewedBaseline); return 'stopped'; }
        if (repair.status !== 'completed') {
          releaseReviewBaseline(reviewedBaseline);
          h.error({ message: 'Builder repair call failed', detail: repair.failure?.message, source: 'builder', retryable: true });
          return 'failed';
        }
        markRepairClaimed(h.chat.id, mandated.map((a) => a.id!).filter(Boolean), 'claimed');
        handoff = `${response.answer}\n\n--- after the Director's decision ---\n${repair.answer}`;
      }
    }

    // ---- what round 2 verifies, and what stands closed
    const changed = changedSoFar();
    releaseReviewBaseline(reviewedBaseline);
    const toVerify = listFindings(h.chat.id, taskSeq).filter((f) => f.round === 1 && f.repairStatus === 'claimed');
    const verify = toVerify.map((f) => `${describe(f)} — ${f.state === 'reviewer_upheld' || f.state === 'different_resolution_required' ? `required by the Director: ${f.arbitrationRequired ?? f.arbitrationReason ?? ''}` : `${(f.disposition ?? '').replace(/_/g, ' ')}: ${f.dispositionReason ?? ''}`}`);
    repairContext = {
      previousFindings: round1.items,
      previousReview: round1.text,
      handoff,
      changedPaths: changed.paths,
      diff: changed.diff,
      diffNote: changed.note,
      dispositions,
    };
    scope = { verify, closed: closedList().map((c) => `${c.id ?? ''} [${c.severity}] ${c.title} — ${c.decision.replace(/_/g, ' ')}: ${c.reason}`) };

    if (verify.length === 0) {
      // nothing was changed in response to the findings: there is nothing for a
      // verification round to verify, and spending one would only invite the
      // same findings again
      if (undecided.length > 0) {
        h.status(`Nothing to verify: no finding was accepted, and ${undecided.length} could not be decided — ${undecided.length === 1 ? 'it stands' : 'they stand'} OPEN and blocking. The work is preserved as the Reviewer saw it.`);
        return 'done';
      }
      recordResolution(h.chat.id);
      h.status('Review complete: the Director closed every finding (Builder upheld, non-blocking or deferred) and nothing was changed, so no verification round is needed. This result carries the Director\'s approval.');
      return 'done';
    }

    // the response may have produced files — re-check the disk before deciding
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
        : subjectFor(null, handoff) ?? opts.subject;
  }

  // ---- round 2: verify the repairs by id, find what is genuinely new
  const round2 = await review(h, userText, subject2, 2, opts.steering, repairContext, scope);
  if (h.stopped || 'stopped' in round2) return 'stopped';
  if ('outage' in round2) return recordReviewWait(h, userText, 2, subject2, round2.outage);
  if ('failure' in round2) return reviewerFailed(h, userText, 2, subject2, round2.failure, opts.retry);
  if (round2.verdict === 'pass') return 'done';

  // ---- ONE final Builder pass: new findings, failed repairs, Director-required changes
  const finalBaseline = captureReviewBaseline(h.project.rootPath, path.join(config.dataDir, 'tmp'));
  const registry = listFindings(h.chat.id, taskSeq);
  const failed = registry.filter((f) => f.state === 'repair_failed');
  const fresh = round2.items; // the genuinely new ones (restated known findings were folded by review())
  const stillRequired = registry.filter((f) => (f.state === 'reviewer_upheld' || f.state === 'different_resolution_required') && f.repairStatus === 'pending');
  const finalItems: Finding[] = [
    ...failed.map(findingOf).map((f) => ({ ...f, detail: `${f.detail}\n   (repair_failed: the Reviewer found the earlier repair did not hold — ${f.evidence ?? 'see evidence'})` })),
    ...stillRequired.map(findingOf),
    ...fresh,
  ];
  h.status(`Round 2 left ${fresh.length} new finding${fresh.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed repair${failed.length === 1 ? '' : 's'}` : ''}. `
    + 'The Builder gets one final pass; nothing after it is re-reviewed, and the Director decides on the final state.');
  const finalPass = await builderTurn([renderPrompt('repair.final_message', { findings: findingsAsText(finalItems) }), getPrompt('repair.disposition_format')].join('\n\n'));
  rememberSession(h.chat.id, finalPass.session);
  recordRepair(h.chat.id, true);
  if (h.stopped) { releaseReviewBaseline(finalBaseline); return 'stopped'; }
  let finalHandoff = '';
  let finalDispositions: FindingResponse[] = [];
  if (finalPass.status !== 'completed') {
    // a failed final pass changes nothing about the findings; the Director
    // still decides on the state as it stands
    h.error({ message: 'Builder repair call failed', detail: finalPass.failure?.message, source: 'builder', retryable: true });
    finalHandoff = `(the final Builder pass failed: ${finalPass.failure?.message ?? 'unknown error'})`;
  } else {
    finalHandoff = finalPass.answer;
    finalDispositions = parseDispositions(finalPass.answer, finalItems);
    applyDispositions(h.chat.id, finalDispositions);
    // whatever it accepted it claims to have repaired — and nothing verifies that
    markRepairClaimed(h.chat.id, finalDispositions.filter((d) => d.id && (d.disposition === 'accepted' || d.disposition === 'partially_accepted')).map((d) => d.id!), 'unverified');
    addEvent(h.chat.id, 'finding_dispositions', { round: 2, items: finalDispositions, final: true }, { runId: h.ctx.runId });
  }
  const finalChangedPaths = changedSince(finalBaseline.signatures, signatureMap(h.project.rootPath));
  const finalDiff = repairDiff(h.project.rootPath, finalBaseline, finalChangedPaths, 12_000);
  releaseReviewBaseline(finalBaseline);

  // ---- the Director's final decision: what blocks, may it proceed
  const unsettled = unsettledFindings(h.chat.id, taskSeq);
  const disputedFinal: Disputed[] = unsettled.map((f, i) => ({
    finding: findingOf(f),
    response: finalDispositions.find((d) => d.id === f.id) ?? repairContext?.dispositions?.find((d) => d.id === f.id),
    record: f,
    index: i + 1,
  }));
  h.status(`The Project Director makes the final decision on ${unsettled.length} finding${unsettled.length === 1 ? '' : 's'} (${unsettled.filter((f) => f.repairStatus === 'unverified').length} repaired in the final pass and unverified).`);
  const arb2 = await arbitrate(h, {
    round: 2, disputed: disputedFinal, originalRequest: userText, steering: opts.steering,
    builderHandoff: finalHandoff, changedPaths: finalChangedPaths, diff: finalDiff.text, diffNote: finalDiff.note,
    closed: closedList(), final: true,
  });
  applyArbitration(h.chat.id, arb2.items, { final: true });
  addEvent(h.chat.id, 'arbitration', arb2, { runId: h.ctx.runId });
  if (h.stopped) return 'stopped';
  const closed2 = arb2.items.filter((a) => a.decision === 'builder_upheld' || a.decision === 'non_blocking' || a.decision === 'deferred');
  recordClosedFindings(h.chat.id, closed2.map((a) => ({ id: a.id, title: a.title, severity: a.severity, decision: a.decision as 'builder_upheld' | 'non_blocking' | 'deferred', reason: a.reason, round: 2 })));
  const blocking = arb2.items.filter((a) => a.blocking);
  updateEvent(round2.eventId, { repairSkippedAtCap: true });
  if (blocking.length === 0) {
    recordResolution(h.chat.id);
    h.status(`Review complete: ${MAX_REVIEW_ROUNDS} of ${MAX_REVIEW_ROUNDS} rounds spent and the final Builder pass made. The Director's final decision: nothing blocks `
      + `(${arb2.items.map((a) => `${a.id ?? a.title} — ${a.decision.replace(/_/g, ' ')}`).join('; ') || 'no findings remained'})${arb2.summary ? ` — ${arb2.summary}` : ''}. This result carries the Director's approval.`);
    return 'done';
  }
  const open = blocking.map((a) => `${a.id ?? ''} ${a.severity}: ${a.title} (${a.decision.replace(/_/g, ' ')})`).join(' · ').slice(0, 600);
  h.status(`Review complete: ${MAX_REVIEW_ROUNDS} of ${MAX_REVIEW_ROUNDS} rounds spent and the final Builder pass made. The Director's final decision: ${blocking.length} finding${blocking.length === 1 ? '' : 's'} block${blocking.length === 1 ? 's' : ''} this result`
    + (closed2.length > 0 ? `, ${closed2.length} closed as non-blocking` : '') + `${arb2.summary ? ` — ${arb2.summary}` : ''}. No further review runs; the work is preserved as it stands. Blocking: ${open}`);
  return 'done';
}

/** two findings are the same finding when their titles match, ignoring case and punctuation */
function sameFinding(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** what a verification round is asked to verify, and what stands closed */
interface VerifyScope { verify: string[]; closed: string[] }

/**
 * Rebuild the verification scope after a restart, from the registry: what was
 * claimed repaired (and by whose decision), and what the Director closed.
 */
function replayScope(chatId: string): VerifyScope | undefined {
  const taskSeq = getLedger(chatId)?.taskSeq ?? 0;
  const all = listFindings(chatId, taskSeq);
  if (all.length === 0) return undefined;
  const closed = all.filter((f) => ['builder_upheld', 'non_blocking', 'deferred'].includes(f.state));
  return {
    verify: all.filter((f) => f.round === 1 && f.repairStatus === 'claimed').map((f) => `${f.id} [${f.severity}] ${f.title} — ${(f.disposition ?? f.state).replace(/_/g, ' ')}: ${f.dispositionReason ?? f.arbitrationRequired ?? ''}`),
    closed: closed.map((c) => `${c.id} [${c.severity}] ${c.title} — ${c.state.replace(/_/g, ' ')}: ${c.arbitrationReason ?? ''}`),
  };
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
  const disp = db.prepare("SELECT payload FROM events WHERE chat_id = ? AND kind = 'finding_dispositions' ORDER BY seq DESC LIMIT 1").get(chatId) as { payload: string } | undefined;
  return {
    previousFindings: prev.items,
    previousReview: lastOf('builder_reviewer') || lastOf('reviewer'),
    handoff: lastOf('builder'),
    dispositions: disp ? ((JSON.parse(disp.payload) as { items: FindingResponse[] }).items ?? []) : [],
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
  h.error({ message: 'Reviewer could not run', detail: error, source: 'builder_reviewer', retryable: true });
  h.status('The review loop stopped because the Builder Reviewer failed — the result above has NOT been reviewed.');
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
      if (h.settings.roles.builder_reviewer.enabled === false) {
        deletePendingReview(chatId);
        h.gitFlow = (await adoptRepo(h)) ?? undefined;
        h.status('The Builder Reviewer was disabled in Settings while this review was waiting — the pending review was dropped and the result remains unreviewed.');
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
        replayScope: round > 1 ? replayScope(chatId) : undefined,
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
  /** the Builder's answer to each finding of the previous round */
  dispositions?: FindingResponse[];
}

type ReviewResult =
  | { verdict: 'pass' | 'findings'; items: Finding[]; eventId: string; text: string }
  | { outage: { reason: string; retryAt: number; detail: string } } // temporary provider condition — retryable
  | { failure: string }                                             // any other Reviewer failure
  | { stopped: true };

async function review(h: RunHandle, originalRequest: string, subject: ReviewSubject, round: number, steering?: string, repair?: RepairContext, scope?: VerifyScope): Promise<ReviewResult> {
  h.status(round === 1 ? 'Reviewer is checking the result…' : 'Reviewer is verifying the repaired findings…');
  const cfg = resolveBuilderReviewerRole(h.settings);
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
    ...(repair?.dispositions?.length ? [`# How the Builder answered each finding\n${dispositionsAsText(repair.dispositions)}`] : []),
    ...(scope ? [renderPrompt('reviewer.verification_section', {
      verify_findings: scope.verify.join('\n') || '(nothing was accepted or required — this round verifies the result as it stands)',
      closed_findings: scope.closed.join('\n') || '(none)',
    })] : []),
    renderPrompt('reviewer.round_section', { review_round: round, max_review_rounds: MAX_REVIEW_ROUNDS }),
    getPrompt('reviewer.output_format'),
    ...(round >= 2 ? [getPrompt('reviewer.round2_format')] : []),
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
      role: 'builder_reviewer',
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

  const taskSeq = getLedger(h.chat.id)?.taskSeq ?? 0;
  const known = listFindings(h.chat.id, taskSeq);
  const parsed = parseVerdict(result.answer, round >= 2 ? known : undefined);
  // round 2 speaks about earlier findings by id, and may restate one instead of
  // raising something new — that restatement folds back onto the original
  const verifiedIds = parsed.verified.filter((id) => known.some((k) => k.id === id));
  const failedRepairs = parsed.repairFailed.filter((r) => known.some((k) => k.id === r.id));
  const folded: { id: string; restated: string }[] = [];
  const fresh: Finding[] = [];
  for (const it of parsed.items) {
    const dup = known.find((k) => sameFinding(k.title, it.title));
    if (dup && round >= 2) folded.push({ id: dup.id, restated: it.title });
    else fresh.push(it);
  }
  // a folded restatement of a repaired finding is evidence the repair did not hold
  for (const f of folded) {
    const k = known.find((x) => x.id === f.id)!;
    if (k.repairStatus === 'claimed' && !failedRepairs.some((r) => r.id === f.id)) failedRepairs.push({ id: f.id, evidence: `restated by the Reviewer in round ${round}: ${f.restated}` });
  }
  const items = round >= 2 ? raiseFindings(h.chat.id, taskSeq, round, fresh) : raiseFindings(h.chat.id, taskSeq, round, parsed.items);
  // a round-2 verdict is PASS only when nothing is new AND no repair failed
  const verdict: 'pass' | 'findings' = parsed.verdict === 'pass' && failedRepairs.length === 0 ? 'pass' : (items.length === 0 && failedRepairs.length === 0 ? 'pass' : 'findings');
  if (verifiedIds.length) markVerified(h.chat.id, verifiedIds);
  if (failedRepairs.length) markRepairFailed(h.chat.id, failedRepairs);
  if (folded.length) markRestated(h.chat.id, folded.map((f) => f.id));
  // on round 2, every claimed repair the Reviewer neither confirmed nor failed stays claimed — unverified in truth
  const payload: FindingsPayload = {
    verdict, round, items, ...(scope ? { scope } : {}),
    ...(verifiedIds.length ? { verified: verifiedIds } : {}),
    ...(failedRepairs.length ? { repairFailed: failedRepairs } : {}),
    ...(folded.length ? { folded } : {}),
  };
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
export function parseVerdict(text: string, known?: ReviewFindingRecord[]): { verdict: 'pass' | 'findings'; items: Finding[]; verified: string[]; repairFailed: { id: string; evidence: string }[] } {
  const verified: string[] = [];
  const repairFailed: { id: string; evidence: string }[] = [];
  // round-2 lines about earlier findings, by id — parsed wherever they appear
  for (const raw of text.split('\n')) {
    const m = raw.trim().replace(/^[*_`>\-\s]+/, '').match(/^(RESOLVED|REPAIR_FAILED)\s+`?(F-\d+)`?\s*(?:[—–\-:]\s*(.*))?$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === 'RESOLVED') verified.push(m[2].toUpperCase());
    else repairFailed.push({ id: m[2].toUpperCase(), evidence: (m[3] ?? '').trim() });
  }
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !/^(RESOLVED|REPAIR_FAILED)\b/i.test(l)) ?? '';
  const explicitFindingsHeader = /^`?FINDINGS`?\b/i.test(firstLine);
  if (/^`?PASS`?\b/i.test(firstLine)) return { verdict: 'pass', items: [], verified, repairFailed };

  const items: Finding[] = [];
  const lines = text.split('\n');
  let current: Finding | null = null;
  for (const raw of lines) {
    if (/^\s*[*_`>\-\s]*(RESOLVED|REPAIR_FAILED)\s+F-\d+/i.test(raw)) { if (current) { items.push(current); current = null; } continue; }
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
      const t = raw.trim();
      const rec = t.match(/^Recommendation:\s*(.+)$/i);
      const evi = t.match(/^Evidence:\s*(.+)$/i);
      const cat = t.match(/^Category:\s*`?([a-z_ ]+)`?/i);
      if (rec) current.recommendation = rec[1];
      else if (evi) current.evidence = evi[1];
      else if (cat) {
        const c = cat[1].trim().toLowerCase().replace(/\s+/g, '_');
        if (['defect', 'regression', 'security', 'missing_requirement', 'risk', 'preference', 'metadata', 'policy_conflict'].includes(c)) current.category = c as Finding['category'];
      } else current.detail = current.detail ? `${current.detail} ${t}` : t;
    }
  }
  if (current) items.push(current);
  if (items.length === 0) {
    // round 2 may legitimately consist only of RESOLVED / REPAIR_FAILED lines
    // (under either header): that is a structured reply about known findings,
    // not an unstructured one — and a failed repair is a FINDINGS verdict
    if (known && (verified.length > 0 || repairFailed.length > 0)) {
      return { verdict: repairFailed.length > 0 || explicitFindingsHeader ? 'findings' : 'pass', items: [], verified, repairFailed };
    }
    items.push({ severity: 'major', title: 'Reviewer reported issues (unstructured output)', detail: text.trim().slice(0, 4_000) });
  }
  return { verdict: 'findings', items, verified, repairFailed };
}

function findingsAsText(items: Finding[]): string {
  return items.map((f, i) =>
    `${i + 1}. ${f.id ? `${f.id} ` : ''}[${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n   ${f.detail}`
    + (f.evidence ? `\n   Evidence: ${f.evidence}` : '') + (f.category ? `\n   Category: ${f.category}` : '')
    + (f.recommendation ? `\n   Recommendation: ${f.recommendation}` : '')).join('\n');
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
