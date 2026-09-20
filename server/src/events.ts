import { randomUUID } from 'node:crypto';
import type { Difficulty, Chat, ChatEvent, EventKind, EventPayloadMap } from '../../shared/types';
import { db, getChat, getEvent, rowToChat, rowToEvent } from './db';
import { broadcast } from './sse';
import { computeUsage } from './context';

/** text of assistant messages still streaming (not yet persisted per-chunk) */
const pendingText = new Map<string, string>();

export function getEvents(chatId: string): ChatEvent[] {
  const rows = db.prepare('SELECT * FROM events WHERE chat_id = ? ORDER BY seq').all(chatId);
  const events = rows.map(rowToEvent);
  for (const e of events) {
    if (e.kind === 'assistant_message' && pendingText.has(e.id)) {
      (e.payload as EventPayloadMap['assistant_message']).text = pendingText.get(e.id)!;
    }
  }
  return events;
}

export function addEvent<K extends EventKind>(
  chatId: string,
  kind: K,
  payload: EventPayloadMap[K],
  opts: { runId?: string; ts?: number; silent?: boolean } = {},
): ChatEvent<K> {
  const id = randomUUID();
  const ts = opts.ts ?? Date.now();
  const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM events WHERE chat_id = ?').get(chatId) as any).s as number;
  db.prepare('INSERT INTO events (id, chat_id, seq, ts, run_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, chatId, seq, ts, opts.runId ?? null, kind, JSON.stringify(payload));
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(ts, chatId);
  const event: ChatEvent<K> = { id, chatId, seq, ts, runId: opts.runId, kind, payload };
  if (!opts.silent) {
    broadcast({ type: 'event', event: event as ChatEvent });
    broadcastContext(chatId);
  }
  return event;
}

/** highest seq currently in a chat — the honest anchor for "since this turn" */
export function maxSeq(chatId: string): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ?').get(chatId) as any).s as number;
}

export function updateEvent(id: string, patch: Record<string, unknown>, opts: { silent?: boolean } = {}): ChatEvent | null {
  const existing = getEvent(id);
  if (!existing) return null;
  const payload = { ...(existing.payload as unknown as Record<string, unknown>), ...patch };
  db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
  const event = { ...existing, payload } as unknown as ChatEvent;
  if (!opts.silent) {
    broadcast({ type: 'event', event });
    broadcastContext(event.chatId);
  }
  return event;
}

// ------------------------------------------------------- assistant streaming

export function beginAssistantMessage(chatId: string, runId?: string): ChatEvent {
  const ev = addEvent(chatId, 'assistant_message', { text: '', streaming: true }, { runId });
  pendingText.set(ev.id, '');
  return ev as ChatEvent;
}

export function appendAssistantText(ev: ChatEvent, chunk: string): void {
  const text = (pendingText.get(ev.id) ?? '') + chunk;
  pendingText.set(ev.id, text);
  broadcast({ type: 'delta', chatId: ev.chatId, eventId: ev.id, text: chunk });
}

export function finishAssistantMessage(ev: ChatEvent): void {
  const text = pendingText.get(ev.id) ?? '';
  pendingText.delete(ev.id);
  updateEvent(ev.id, { text, streaming: false });
}

// ------------------------------------------------------- chat helpers

export function setChatRunning(chatId: string, running: boolean): void {
  db.prepare('UPDATE chats SET running = ?, updated_at = ? WHERE id = ?').run(running ? 1 : 0, Date.now(), chatId);
  broadcastChat(chatId);
}

export function setChatTitle(chatId: string, title: string): void {
  db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), chatId);
  broadcastChat(chatId);
}

/** A standalone chat's difficulty; null clears it. Live: the next request resolves with it. */
export function setChatDifficulty(chatId: string, difficulty: Difficulty | null): void {
  db.prepare('UPDATE chats SET difficulty = ? WHERE id = ?').run(difficulty, chatId);
  broadcastChat(chatId);
}

export function broadcastChat(chatId: string): void {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (row) broadcast({ type: 'chat', chat: rowToChat(row) });
}

export function broadcastContext(chatId: string): void {
  const chat = getChat(chatId);
  if (!chat) return;
  broadcast({ type: 'context', chatId, usage: computeUsage(chat) });
}

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 56) return clean || 'New chat';
  const cut = clean.slice(0, 56);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 30 ? lastSpace : 56)}…`;
}

export function listChats(): Chat[] {
  return (db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all()).map(rowToChat);
}
