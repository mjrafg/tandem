import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config';
import type { ChatAgent, Difficulty, Chat, ChatEvent, EventKind, Project } from '../../shared/types';

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
CREATE TABLE IF NOT EXISTS proc_groups (
  chat_id TEXT NOT NULL,
  pgid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, pgid)
);
CREATE TABLE IF NOT EXISTS pending_reviews (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id),
  round INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  retry_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// additive migrations
try { db.exec('ALTER TABLE chats ADD COLUMN builder_session_id TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE chats ADD COLUMN git_state TEXT'); } catch { /* exists */ }
// which provider created the stored session (pre-existing sessions are Claude's)
try { db.exec("ALTER TABLE chats ADD COLUMN builder_session_provider TEXT DEFAULT 'claude-code'"); } catch { /* exists */ }
// which logical ROLE created it: a project chat's session is the Director's,
// every other chat's is the Builder's. A Builder Reviewer thread is never
// resumed as a Builder even on the same provider and model.
try { db.exec('ALTER TABLE chats ADD COLUMN builder_session_role TEXT'); } catch { /* exists */ }
try {
  db.exec("UPDATE chats SET builder_session_role = CASE WHEN kind = 'project' THEN 'director' ELSE 'builder' END WHERE builder_session_role IS NULL AND builder_session_id IS NOT NULL");
} catch { /* kind column may not exist yet on a brand-new db; the next boot fills it */ }
// Project Director: a chat is either a normal session or a project chat
try { db.exec("ALTER TABLE chats ADD COLUMN kind TEXT DEFAULT 'chat'"); } catch { /* exists */ }
try { db.exec('ALTER TABLE chats ADD COLUMN project_run_id TEXT'); } catch { /* exists */ }
// a standalone chat's user-chosen difficulty (Director sessions keep theirs on pd_sessions)
try { db.exec('ALTER TABLE chats ADD COLUMN difficulty TEXT'); } catch { /* exists */ }

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

/** provider that created the stored session (defaults to claude-code for pre-migration rows) */
export function getBuilderSessionProvider(chatId: string): import('../../shared/types').Provider {
  const row = db.prepare('SELECT builder_session_provider AS p FROM chats WHERE id = ?').get(chatId) as any;
  return row?.p === 'codex' ? 'codex' : 'claude-code';
}

/** the logical role that created the stored session (legacy rows: by chat kind) */
export function getBuilderSessionRole(chatId: string): import('../../shared/types').AiRole {
  const row = db.prepare('SELECT builder_session_role AS r, kind FROM chats WHERE id = ?').get(chatId) as any;
  if (row?.r) return row.r;
  return row?.kind === 'project' ? 'director' : 'builder';
}

export function setBuilderSession(
  chatId: string,
  sessionId: string | null,
  provider: import('../../shared/types').Provider = 'claude-code',
  role: import('../../shared/types').AiRole = 'builder',
): void {
  db.prepare('UPDATE chats SET builder_session_id = ?, builder_session_provider = ?, builder_session_role = ? WHERE id = ?')
    .run(sessionId, provider, role, chatId);
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

const worktreesPrefix = path.join(config.dataDir, 'worktrees') + path.sep;

export function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, rootPath: r.root_path, source: r.source,
    createdAt: r.created_at, lastOpenedAt: r.last_opened_at,
    // Director session worktrees are plumbing: hidden EVERYWHERE a project row
    // travels (listing and live broadcasts alike), so the sidebar never shows
    // them while their chats stay fully loadable
    ...(String(r.root_path ?? '').startsWith(worktreesPrefix) ? { hidden: true } : {}),
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
    ...(r.kind === 'project' ? { kind: 'project' as const, projectRunId: r.project_run_id ?? null } : {}),
    ...(r.kind === 'pd-session' ? { kind: 'pd-session' as const, session: sessionParent(r.id) } : {}),
    ...(r.kind !== 'pd-session' && r.kind !== 'project' ? { difficulty: asDifficulty(r.difficulty), agent: chatAgent(r.id) } : {}),
  };
}

/** the Agent snapshot a standalone chat carries, for display; the prompt stays server-side */
function chatAgent(chatId: string): ChatAgent | null {
  try {
    const r = db.prepare('SELECT profile_id, profile_name, profile_slug, provider, model, effort, enforce_model, profile_updated_at, captured_at FROM chat_agent_snapshots WHERE chat_id = ?').get(chatId) as any;
    if (!r) return null;
    return {
      profileId: r.profile_id, profileName: r.profile_name, profileSlug: r.profile_slug,
      provider: r.provider, model: r.model, effort: r.effort, enforceModel: !!r.enforce_model,
      profileUpdatedAt: r.profile_updated_at, capturedAt: r.captured_at,
    };
  } catch {
    return null; // the table is created by the agents store
  }
}

export function asDifficulty(v: unknown): Difficulty | null {
  return v === 'easy' || v === 'medium' || v === 'hard' || v === 'very_hard' ? v : null;
}

/**
 * The project a Director-owned session belongs to: its run, the Project Chat
 * to return to, and the session's place in the plan. Looked up per chat row so
 * every view of the chat can name its parent; null when the session row is
 * gone (the chat then reads as an orphan, which is the truth).
 */
function sessionParent(chatId: string): import('../../shared/types').SessionParent | null {
  try {
    const r = db.prepare(`SELECT s.key, s.name, r.id AS run_id, r.title AS run_title, r.chat_id AS project_chat_id, m.key AS ms_key, m.name AS ms_name
      FROM pd_sessions s JOIN project_runs r ON r.id = s.run_id LEFT JOIN pd_milestones m ON m.id = s.milestone_id
      WHERE s.chat_id = ? ORDER BY s.started_at DESC LIMIT 1`).get(chatId) as any;
    if (!r) return null;
    return { runId: r.run_id, runTitle: r.run_title || 'Project', projectChatId: r.project_chat_id, key: r.key, name: r.name, milestoneKey: r.ms_key ?? null, milestoneName: r.ms_name ?? null };
  } catch {
    return null; // the Director tables are created by the Director store; before that there are no sessions
  }
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
