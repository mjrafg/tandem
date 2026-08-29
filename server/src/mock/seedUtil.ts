import { randomUUID } from 'node:crypto';
import type { EventKind, EventPayloadMap } from '../../../shared/types';
import { db } from '../db';
import { addEvent } from '../events';
import { BASE_PROMPTS } from '../settings';

export const CLAUDE_CLI = 'claude -p --output-format stream-json --model claude-opus-5';
export const CODEX_CLI = 'codex exec --json --sandbox read-only -m gpt-5-codex';

export function insertChatRow(projectId: string, title: string, createdAt: number): string {
  const id = randomUUID();
  db.prepare('INSERT INTO chats (id, project_id, title, created_at, updated_at, running) VALUES (?, ?, ?, ?, ?, 0)')
    .run(id, projectId, title, createdAt, createdAt);
  return id;
}

/** Emits seed events on a monotonically advancing clock. */
export class Timeline {
  t: number;
  chatId: string;
  runId?: string;

  constructor(chatId: string, start: number) {
    this.chatId = chatId;
    this.t = start;
  }

  ev<K extends EventKind>(kind: K, payload: EventPayloadMap[K], advanceMs = 1200): void {
    this.evId(kind, payload, advanceMs);
  }

  evId<K extends EventKind>(kind: K, payload: EventPayloadMap[K], advanceMs = 1200): string {
    this.t += advanceMs;
    return addEvent(this.chatId, kind, payload, { ts: this.t, runId: this.runId, silent: true }).id;
  }

  finish(): void {
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(this.t, this.chatId);
  }
}

export function seedPrompt(role: 'builder' | 'reviewer' | 'final_repair', project: string, dir: string, ctxK: number, request: string): string {
  return [
    role === 'reviewer' ? BASE_PROMPTS.reviewer : role === 'final_repair' ? BASE_PROMPTS.final_repair : BASE_PROMPTS.builder,
    `Project: ${project}\nWorking directory: ${dir}`,
    `[active conversation context · ~${ctxK}k tokens]`,
    request,
  ].join('\n\n');
}
