import { randomUUID } from 'node:crypto';
import type { ProjectMemory } from '../../shared/types';
import { db } from './db';

/**
 * Project Memory (V1) — shared, persistent knowledge belonging to a PROJECT,
 * not to a chat. Every chat already carries `chats.project_id` referencing the
 * existing `projects` table, so that stable id is the memory's owner and the
 * hard isolation boundary: every read and write below is scoped by project_id
 * in SQL, and the id is always resolved server-side from the calling chat —
 * never supplied by the model.
 *
 * Deliberately boring: plain rows, plain case-insensitive text matching. No
 * embeddings, no automatic extraction, no automatic retrieval.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS project_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_memories_project ON project_memories(project_id);
`);

const MAX_LIMIT = 50;

function rowToMemory(row: any): ProjectMemory {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags); } catch { tags = []; }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampLimit(limit: unknown, fallback = 20): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.round(n), MAX_LIMIT);
}

// ---------------------------------------------------------------- reads

export function listMemories(projectId: string, limit?: unknown): ProjectMemory[] {
  return db.prepare('SELECT * FROM project_memories WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(projectId, clampLimit(limit)).map(rowToMemory);
}

/** Plain case-insensitive matching over title, content and tags. */
export function searchMemories(projectId: string, query: string, limit?: unknown): ProjectMemory[] {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`
    SELECT * FROM project_memories
    WHERE project_id = ?
      AND (lower(title) LIKE lower(?) ESCAPE '\\'
        OR lower(content) LIKE lower(?) ESCAPE '\\'
        OR lower(tags) LIKE lower(?) ESCAPE '\\')
    ORDER BY updated_at DESC LIMIT ?`)
    .all(projectId, like, like, like, clampLimit(limit)).map(rowToMemory);
}

/** Ownership is part of the query: an id from another project simply does not match. */
export function getMemory(projectId: string, memoryId: string): ProjectMemory | null {
  const row = db.prepare('SELECT * FROM project_memories WHERE id = ? AND project_id = ?').get(String(memoryId ?? ''), projectId);
  return row ? rowToMemory(row) : null;
}

export function countMemories(projectId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM project_memories WHERE project_id = ?').get(projectId) as any).c as number;
}

/** Full set for the popover, copy-all and exports (creation order reads naturally). */
export function allMemories(projectId: string): ProjectMemory[] {
  return db.prepare('SELECT * FROM project_memories WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId).map(rowToMemory);
}

// ---------------------------------------------------------------- writes

export function createMemory(projectId: string, input: { title: string; content: string; tags?: unknown }): ProjectMemory {
  const title = String(input.title ?? '').trim();
  const content = String(input.content ?? '').trim();
  if (!title) throw new Error('A memory needs a title.');
  if (!content) throw new Error('A memory needs content.');
  if (title.length > 200) throw new Error('Titles are limited to 200 characters.');
  if (content.length > 20_000) throw new Error('Memory content is limited to 20,000 characters.');
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const now = Date.now();
  const id = randomUUID();
  db.prepare('INSERT INTO project_memories (id, project_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, title, content, JSON.stringify(tags), now, now);
  return getMemory(projectId, id)!;
}

// ---------------------------------------------------------------- formats

/** Human-friendly plain text — the "Copy all" payload. */
export function toPlainText(memories: ProjectMemory[]): string {
  const parts = ['Project Memory', ''];
  for (const m of memories) {
    parts.push(m.title);
    if (m.tags.length > 0) parts.push(`Tags: ${m.tags.join(', ')}`);
    parts.push('', m.content, '');
  }
  return parts.join('\n').trimEnd() + '\n';
}

export function toMarkdown(memories: ProjectMemory[]): string {
  const parts = ['# Project Memory', ''];
  for (const m of memories) {
    parts.push(`## ${m.title}`, '');
    if (m.tags.length > 0) parts.push(`Tags: ${m.tags.join(', ')}`, '');
    parts.push(m.content, '');
  }
  return parts.join('\n').trimEnd() + '\n';
}

/** Canonical machine-readable backup — no internal database details. */
export function toJson(projectId: string, memories: ProjectMemory[]): string {
  return JSON.stringify({
    version: 1,
    project_id: projectId,
    exported_at: new Date().toISOString(),
    memories: memories.map((m) => ({
      title: m.title,
      content: m.content,
      tags: m.tags,
      created_at: new Date(m.createdAt).toISOString(),
      updated_at: new Date(m.updatedAt).toISOString(),
    })),
  }, null, 2) + '\n';
}

/** Compact shape handed to the Builder's tools (no project id echoed back). */
export function toToolShape(m: ProjectMemory): Record<string, unknown> {
  return { memory_id: m.id, title: m.title, content: m.content, tags: m.tags, updated_at: new Date(m.updatedAt).toISOString() };
}
