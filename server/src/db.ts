import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config';
import type { Chat, ChatEvent, EventKind, Project } from '../../shared/types';

export const db = new Database(path.join(config.dataDir, 'tandem.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  pass TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  running INTEGER NOT NULL DEFAULT 0,
  last_compaction_event_id TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id, seq);
`);

// additive migrations
try { db.exec('ALTER TABLE chats ADD COLUMN builder_session_id TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE chats ADD COLUMN git_state TEXT'); } catch { /* exists */ }

export function getGitStateRow(chatId: string): import('../../shared/types').GitFlowState | null {
  const row = db.prepare('SELECT git_state AS s FROM chats WHERE id = ?').get(chatId) as any;
  if (!row?.s) return null;
  try { return JSON.parse(row.s); } catch { return null; }
}

export function setGitStateRow(chatId: string, state: import('../../shared/types').GitFlowState): void {
  db.prepare('UPDATE chats SET git_state = ? WHERE id = ?').run(JSON.stringify(state), chatId);
}

export function getBuilderSession(chatId: string): string | null {
  const row = db.prepare('SELECT builder_session_id AS s FROM chats WHERE id = ?').get(chatId) as any;
  return row?.s ?? null;
}

export function setBuilderSession(chatId: string, sessionId: string | null): void {
  db.prepare('UPDATE chats SET builder_session_id = ? WHERE id = ?').run(sessionId, chatId);
}

// ---------------------------------------------------------------- kv

export function kvGet<T>(key: string): T | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------------------------------------------------------------- rows

export function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, rootPath: r.root_path, source: r.source,
    createdAt: r.created_at, lastOpenedAt: r.last_opened_at,
  };
}

export function rowToChat(r: any): Chat {
  let gitState = null;
  if (r.git_state) {
    try { gitState = JSON.parse(r.git_state); } catch { /* ignore */ }
  }
  return {
    id: r.id, projectId: r.project_id, title: r.title,
    createdAt: r.created_at, updatedAt: r.updated_at,
    running: !!r.running, lastCompactionEventId: r.last_compaction_event_id ?? null,
    gitState,
  };
}

export function rowToEvent(r: any): ChatEvent {
  return {
    id: r.id, chatId: r.chat_id, seq: r.seq, ts: r.ts,
    runId: r.run_id ?? undefined, kind: r.kind as EventKind,
    payload: JSON.parse(r.payload),
  };
}

export function getProject(id: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return r ? rowToProject(r) : null;
}

export function getChat(id: string): Chat | null {
  const r = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return r ? rowToChat(r) : null;
}

export function getEvent(id: string): ChatEvent | null {
  const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  return r ? rowToEvent(r) : null;
}
