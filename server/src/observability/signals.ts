/**
 * Observability lifecycle wake-ups.
 *
 * These are emitted from Tandem's REAL existing transitions — no new
 * orchestration state was invented for them. Every emitter must run AFTER the
 * corresponding state is persisted, so a consumer that fetches the moment a
 * signal lands always finds the evidence already there.
 *
 * The payload is identities plus a cursor. Never transcript content.
 */
import type { ObservabilitySignal, PdSessionStatus, ProjectRunState } from '../../../shared/types';
import { db } from '../db';
import { notifyObservability } from '../sse';
import { instanceId } from './store';

/** Session states that are a meaningful problem/attention condition today. */
const ATTENTION: PdSessionStatus[] = ['failed', 'timeout', 'needs_attention', 'awaiting_review', 'paused'];

function latestSeq(chatId: string | null): number | undefined {
  if (!chatId) return undefined;
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ?').get(chatId) as any;
  return r?.s as number;
}

/**
 * Called from monitorSession AFTER patchSession has committed the outcome.
 * runId is project_runs.id — never events.run_id.
 */
export function signalSessionState(runId: string, sessionId: string, chatId: string | null, status: PdSessionStatus): void {
  const type = status === 'completed' ? 'session.completed'
    : ATTENTION.includes(status) ? 'session.attention'
      : null;
  if (!type) return;
  const run = db.prepare('SELECT project_id FROM project_runs WHERE id = ?').get(runId) as any;
  if (!run) return;
  const signal: ObservabilitySignal = {
    type,
    instanceId: instanceId(),
    projectId: run.project_id,
    runId,
    sessionId,
    ...(chatId ? { chatId } : {}),
    state: status,
    ...(latestSeq(chatId) != null ? { latestSeq: latestSeq(chatId) } : {}),
    timestamp: new Date().toISOString(),
  };
  notifyObservability(signal);
}

/** Terminal run states in Tandem's own vocabulary. */
const TERMINAL: ProjectRunState[] = ['COMPLETED', 'FAILED'];

/** Called from setRunState AFTER the new state has been written. */
export function signalRunState(runId: string, state: ProjectRunState): void {
  if (!TERMINAL.includes(state)) return;
  const run = db.prepare('SELECT project_id, chat_id FROM project_runs WHERE id = ?').get(runId) as any;
  if (!run) return;
  // the run row and its activity are committed; the Director's own closing
  // message may still be streaming, so the Project Chat's cursor rides along —
  // a consumer compares it later to see whether trailing events arrived
  notifyObservability({
    type: 'run.terminal',
    instanceId: instanceId(),
    projectId: run.project_id,
    runId,
    chatId: run.chat_id,
    state,
    ...(latestSeq(run.chat_id) != null ? { latestSeq: latestSeq(run.chat_id) } : {}),
    timestamp: new Date().toISOString(),
  });
}
