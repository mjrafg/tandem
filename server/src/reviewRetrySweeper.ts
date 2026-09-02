/**
 * Review-retry sweeper — fires persisted pending reviews once their retry_at
 * passes. Rows live in the database, so scheduling survives restarts. The
 * sweeper only decides WHEN a retry may fire; what a retry does (same round,
 * same evidence, same provider) lives in the workflow's startReviewRetry.
 *
 * Director-owned session chats route through the Director so the retry run is
 * monitored like any other session run (status, observations, unblocking).
 */
import { getChat } from './db';
import { duePendingReviews, deletePendingReview, expediteReview, getPendingReview } from './engine/reviewWait';
import { isRunning, startReviewRetry } from './engine/workflow';
import { queueObservation, retrySessionReview } from './director/engine';
import { addActivity, getRunRaw, listRuns, patchSession, sessionForChat, sessionsByStatus } from './director/store';

const TICK_MS = Number(process.env.TANDEM_REVIEW_SWEEP_MS || 60_000);

let timer: NodeJS.Timeout | null = null;
/** chats with a retry currently in flight — one at a time per chat */
const inFlight = new Set<string>();
/** awaiting sessions seen once without a pending row — acted on when seen twice */
const orphanSeen = new Set<string>();

export function startReviewRetrySweeper(): void {
  if (timer) return;
  timer = setInterval(sweep, TICK_MS);
  timer.unref?.();
}

/**
 * User-triggered "retry the blocked reviews now": bring every waiting review in
 * a run forward to now and fire the sweeper immediately, instead of waiting for
 * the provider's scheduled reset. This is the control an operator needs after
 * lifting a Codex usage limit — the Director deliberately has no such tool,
 * because whether the limit was lifted is external knowledge only the user has.
 *
 * It changes nothing about HOW a review retries: it only moves the schedule
 * earlier and reuses the exact same guarded sweep path. Reviews on a paused
 * project are still re-queued (they fire the instant it resumes).
 */
export function expediteRunReviews(runId: string): { requeued: number; runState: string } {
  const runState = getRunRaw(runId)?.state ?? '';
  let requeued = 0;
  for (const s of sessionsByStatus(runId, ['awaiting_review'])) {
    if (!s.chatId || !getPendingReview(s.chatId)) continue;
    expediteReview(s.chatId); // moves retry_at to now (no-op if already due)
    requeued += 1;
  }
  if (requeued > 0) {
    addActivity(runId, 'review', `${requeued} waiting review${requeued === 1 ? '' : 's'} re-queued to run now (manual retry)`);
    if (['RUNNING', 'RESUMING', 'PLANNING'].includes(runState)) sweep();
  }
  return { requeued, runState };
}

function sweep(): void {
  for (const pending of duePendingReviews()) {
    const chatId = pending.chatId;
    if (inFlight.has(chatId) || isRunning(chatId)) continue;
    const chat = getChat(chatId);
    if (!chat) { deletePendingReview(chatId); continue; }

    const session = sessionForChat(chatId);
    if (session) {
      if (session.status !== 'awaiting_review') {
        // only a TERMINAL session decision retires the wait; any other status
        // (a real failure, a pause) keeps the row — a later run of this chat
        // supersedes it through the normal startRun path
        if (['completed', 'abandoned'].includes(session.status)) deletePendingReview(chatId);
        continue;
      }
      // a frozen or finished project runs nothing — the wait persists and the
      // sweeper simply looks again after the project resumes
      const state = getRunRaw(session.runId)?.state;
      if (!['RUNNING', 'RESUMING', 'PLANNING'].includes(state ?? '')) continue;
      inFlight.add(chatId);
      void retrySessionReview(session.runId, session.key, chatId)
        .catch((err) => console.error('[tandem] session review retry failed:', err))
        .finally(() => inFlight.delete(chatId));
    } else {
      const run = startReviewRetry(chatId);
      if (!run) continue; // not attempted (directory busy) — next tick tries again
      inFlight.add(chatId);
      void run
        .catch((err) => console.error('[tandem] review retry failed:', err))
        .finally(() => inFlight.delete(chatId));
    }
  }
  reconcileOrphans();
}

/**
 * An awaiting_review session whose pending review no longer exists (a crash in
 * the completion window, a deleted chat) can never be retried — without this
 * pass it would block its dependency closure forever with nothing scheduled.
 * Two consecutive sightings guard against the harmless moment between a
 * successful retry deleting its row and the monitor patching the session.
 */
function reconcileOrphans(): void {
  const active = listRuns().filter((r) => ['RUNNING', 'RESUMING', 'PLANNING'].includes(r.state));
  for (const runRow of active) {
    for (const s of sessionsByStatus(runRow.id, ['awaiting_review'])) {
      if (!s.chatId || isRunning(s.chatId) || getPendingReview(s.chatId)) { orphanSeen.delete(s.id); continue; }
      if (!orphanSeen.has(s.id)) { orphanSeen.add(s.id); continue; }
      orphanSeen.delete(s.id);
      patchSession(runRow.id, s.key, { status: 'needs_attention', reviewWaitReason: null, reviewRetryAt: null });
      addActivity(runRow.id, 'session', `${s.key} lost its scheduled review retry — escalated for a Director decision`);
      queueObservation(runRow.id, `Session ${s.key} was awaiting its required review, but the scheduled retry no longer exists (interrupted mid-completion or its chat was removed). Its implementation result is still NOT reviewed. Decide with recover_session: restarting re-runs the work, abandoning drops it — nothing here has been reviewed or integrated.`);
    }
  }
}
