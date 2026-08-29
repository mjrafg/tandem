import type { AiCallPayload, Chat, ChatEvent, CompactionPayload, ContextUsage } from '../../shared/types';
import { db, rowToEvent } from './db';
import { getSettings } from './settings';

/** fixed cost of role instructions + tool plumbing supplied on every call */
const BASE_OVERHEAD = 2_400;

export function estimateTokens(s: string | undefined | null): number {
  return Math.ceil((s ?? '').length / 4);
}

/** Rough per-event cost of feeding this event back into future calls. */
export function estimateEventTokens(e: ChatEvent): number {
  const p = e.payload as any;
  switch (e.kind) {
    case 'user_message':
    case 'assistant_message':
    case 'status':
      return estimateTokens(p.text);
    case 'command':
      return estimateTokens(p.command) + Math.min(estimateTokens(p.stdout), 400) + Math.min(estimateTokens(p.stderr), 200);
    case 'file_read':
      return p.lines ? Math.round(p.lines * 2.2) : 550;
    case 'search':
      return 120 + (p.matches?.length ?? 0) * 30;
    case 'file_change':
      return (p.files ?? []).reduce((n: number, f: any) => n + estimateTokens(f.diff), 0);
    case 'ai_call':
      return estimateTokens((p as AiCallPayload).response?.text);
    case 'findings':
      return estimateTokens(JSON.stringify(p.items ?? []));
    case 'compaction':
      return estimateTokens(p.summary);
    case 'error':
      return estimateTokens(p.message) + estimateTokens(p.detail);
    case 'browser':
      return 40 + estimateTokens(p.detail) + estimateTokens(p.value)
        + Math.min(estimateTokens((p.console ?? []).map((c: any) => c.text).join(' ')), 300);
    case 'checkpoint':
      return 30 + Math.min((p.files?.length ?? 0) * 4, 200);
    case 'run':
      return 0;
    default:
      return 0;
  }
}

/**
 * Effective builder-context estimate for a chat.
 *
 * Anchors on the most reliable recent signal: the last AI call that reported
 * token usage, or the size after the last applied compaction — whichever came
 * later — then adds rough estimates for everything after that anchor.
 */
export function computeUsage(chat: Chat): ContextUsage {
  const settings = getSettings();
  const limit = settings.context.builderLimit;
  const rows = db.prepare('SELECT * FROM events WHERE chat_id = ? ORDER BY seq').all(chat.id);
  const events = rows.map(rowToEvent);

  let carried = 0;
  let anchorSeq = 0;

  const compactionEvent = chat.lastCompactionEventId
    ? events.find((e) => e.id === chat.lastCompactionEventId)
    : undefined;

  // Only builder-context calls anchor the meter; reviewer/compactor calls
  // have their own separate context.
  let lastUsageCall: ChatEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'ai_call') {
      const p = e.payload as AiCallPayload;
      if ((p.role === 'builder' || p.role === 'final_repair') && p.response?.usage) {
        lastUsageCall = e;
        break;
      }
    }
  }

  if (lastUsageCall && (!compactionEvent || lastUsageCall.seq > compactionEvent.seq)) {
    const usage = (lastUsageCall.payload as AiCallPayload).response!.usage!;
    // contextTokens = the session's context size after the call's final turn;
    // the cumulative in/out sum (fallback for old events) overcounts re-reads.
    carried = usage.contextTokens ?? usage.inputTokens + usage.outputTokens;
    anchorSeq = lastUsageCall.seq;
  } else if (compactionEvent) {
    carried = (compactionEvent.payload as CompactionPayload).afterTokens;
    anchorSeq = compactionEvent.seq;
  }

  let recent = 0;
  for (const e of events) {
    if (e.seq > anchorSeq) recent += estimateEventTokens(e);
  }

  const usedTokens = BASE_OVERHEAD + carried + recent;
  return {
    usedTokens,
    limit,
    pct: Math.min(999, Math.round((usedTokens / limit) * 100)),
    estimated: true,
    breakdown: { overhead: BASE_OVERHEAD, carried, recent },
  };
}
