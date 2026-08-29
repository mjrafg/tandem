import type { AiCallPayload, Chat, ChatEvent, CompactionPayload, ContextUsage, Provider } from '../../shared/types';
import { db, getBuilderSession, kvGet, kvSet, rowToEvent } from './db';
import { getSettings } from './settings';

// ------------------------------------------------- provider context windows
//
// The context window is a property of (provider, model) that providers report
// with real calls (e.g. Claude Code's modelUsage.contextWindow). Remember every
// observation so chats whose own events predate window capture still show the
// provider's actual known capacity instead of "unknown". Nothing is invented:
// only values a provider actually reported are ever stored or shown.

type WindowMap = Record<string, number>;
let windowCache: WindowMap | null = null;

function windowMap(): WindowMap {
  if (!windowCache) windowCache = kvGet<WindowMap>('model_windows') ?? {};
  return windowCache;
}

export function recordModelWindow(provider: Provider, model: string | undefined, window: number): void {
  if (!model || !(window > 0)) return;
  const map = windowMap();
  if (map[`${provider}:${model}`] === window) return;
  map[`${provider}:${model}`] = window;
  kvSet('model_windows', map);
}

export function knownModelWindow(provider: Provider, model: string | null): number | null {
  return model ? windowMap()[`${provider}:${model}`] ?? null : null;
}

/** One-time seed from history so legacy chats get real windows right away. */
export function backfillModelWindows(): void {
  if (Object.keys(windowMap()).length > 0) return;
  for (const row of db.prepare("SELECT payload FROM events WHERE kind = 'ai_call' ORDER BY ts").all() as any[]) {
    try {
      const p = JSON.parse(row.payload) as AiCallPayload;
      const w = p.response?.usage?.contextWindow;
      if (w) recordModelWindow(p.provider, p.model, w);
    } catch { /* ignore malformed rows */ }
  }
}

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
    case 'error':
      return estimateTokens(p.message) + estimateTokens(p.detail);
    case 'browser':
      return 40 + estimateTokens(p.detail) + estimateTokens(p.value)
        + Math.min(estimateTokens((p.console ?? []).map((c: any) => c.text).join(' ')), 300);
    case 'checkpoint':
      return 30 + Math.min((p.files?.length ?? 0) * 4, 200);
    case 'tool_call':
      return 60 + estimateTokens(JSON.stringify(p.args ?? {})) + estimateTokens(p.resultPreview);
    default:
      return 0;
  }
}

function chatEvents(chatId: string): ChatEvent[] {
  return db.prepare('SELECT * FROM events WHERE chat_id = ? ORDER BY seq').all(chatId).map(rowToEvent);
}

/**
 * Best available representation of the chat's ACTIVE provider context.
 *
 * Anchor: the most recent provider signal — the context size reported at the
 * end of the last conversation call (final-turn tokens), or the post-compaction
 * reading, whichever is newer. Activity recorded after the anchor is a Tandem
 * estimate and stays separate (`pendingTokens`). Cumulative usage is never
 * shown as active context, and no fixed Tandem limit stands in for the
 * provider's real window — unknown stays unknown.
 */
export function computeUsage(chat: Chat): ContextUsage {
  const settings = getSettings();
  const provider = settings.roles.builder.provider;
  const events = chatEvents(chat.id);

  // last conversation-session call with a provider-reported context size
  let lastCall: ChatEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== 'ai_call') continue;
    const p = e.payload as AiCallPayload;
    if ((p.role === 'builder' || p.role === 'final_repair') && p.response?.usage?.contextTokens != null) {
      lastCall = e;
      break;
    }
  }
  // last compaction with a known resulting size
  let lastCompaction: ChatEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'compaction' && (e.payload as CompactionPayload).afterTokens != null) {
      lastCompaction = e;
      break;
    }
  }

  // the provider window is a property of the session's model — take the most
  // recent report of it regardless of which anchor wins
  let windowTokens: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'ai_call') {
      const w = (e.payload as AiCallPayload).response?.usage?.contextWindow;
      if (w) { windowTokens = w; break; }
    } else if (e.kind === 'compaction') {
      const w = (e.payload as CompactionPayload).windowTokens;
      if (w) { windowTokens = w; break; }
    }
  }

  let usedTokens: number | null = null;
  let model: string | null = null;
  let source: ContextUsage['source'] = 'none';
  let anchorSeq = 0;

  const callSeq = lastCall?.seq ?? -1;
  const compSeq = lastCompaction?.seq ?? -1;
  if (compSeq > callSeq && lastCompaction) {
    const p = lastCompaction.payload as CompactionPayload;
    usedTokens = p.afterTokens!;
    model = p.model ?? null;
    source = p.source ?? 'estimated';
    anchorSeq = lastCompaction.seq;
  } else if (lastCall) {
    const p = lastCall.payload as AiCallPayload;
    usedTokens = p.response!.usage!.contextTokens!;
    model = p.model;
    source = 'provider';
    anchorSeq = lastCall.seq;
  }

  let pendingTokens = 0;
  for (const e of events) {
    if (e.seq > anchorSeq && e.kind !== 'compaction') pendingTokens += estimateEventTokens(e);
  }

  // chats from before window capture: use the provider's known reported window
  // for the same model (observed on real calls) rather than showing unknown
  if (windowTokens == null) {
    windowTokens = knownModelWindow(provider, model)
      ?? knownModelWindow(provider, settings.roles.builder.model);
  }

  const total = usedTokens != null ? usedTokens + pendingTokens : null;
  return {
    provider,
    model,
    sessionId: getBuilderSession(chat.id),
    usedTokens,
    windowTokens,
    pendingTokens,
    pct: total != null && windowTokens ? Math.round((total / windowTokens) * 100) : null,
    source,
  };
}

/**
 * Recent user/assistant exchange, seeded verbatim when a brand-new provider
 * session starts for a chat that already has history.
 */
export function recentConversation(chatId: string, capChars: number, excludeLastUserMessage: boolean): string {
  const events = chatEvents(chatId);
  let lastUserId: string | null = null;
  if (excludeLastUserMessage) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'user_message') { lastUserId = events[i].id; break; }
    }
  }
  const lines: string[] = [];
  for (const e of events) {
    if (e.id === lastUserId) continue;
    const p = e.payload as any;
    if (e.kind === 'user_message') lines.push(`User: ${p.text ?? ''}${p.attachments?.length ? ` [attached: ${p.attachments.map((a: any) => a.name).join(', ')}]` : ''}`);
    else if (e.kind === 'assistant_message' && p.text?.trim()) lines.push(`Assistant: ${p.text}`);
  }
  let text = lines.join('\n\n');
  if (text.length > capChars) text = `…\n${text.slice(-capChars)}`;
  return text;
}
