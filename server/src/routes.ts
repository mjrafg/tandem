import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, CompactPreview, RoleName } from '../../shared/types';
import {
  createSession, destroySession, getUser, loginAllowed, recordLoginAttempt,
  setPassword, setSessionCookie, verifyPassword,
} from './auth';
import { computeUsage } from './context';
import { config } from './config';
import { db, getChat, getProject, rowToChat } from './db';
import {
  addEvent, broadcastChat, deriveTitle, getEvents, listChats, setChatCompaction, setChatTitle,
} from './events';
import { toHtml, toMarkdown, type ExportBundle } from './exporter';
import { generateCompactionSummary } from './mock/compact';
import { isRunning, startRun, stopRun } from './mock/engine';
import { broadcast, sseHandler } from './sse';
import { composeEffectivePrompt, getSettings, putSettings } from './settings';

export function registerRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------- health / auth

  app.get('/api/health', async () => ({ ok: true, app: 'tandem', version: config.version }));

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    if (!loginAllowed(ip)) return reply.code(429).send({ error: 'Too many attempts — try again in a few minutes.' });
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const user = getUser();
    const ok = !!user && !!email && !!password
      && email.trim().toLowerCase() === user.email.toLowerCase()
      && verifyPassword(password, user.pass);
    if (!ok) {
      recordLoginAttempt(ip);
      return reply.code(401).send({ error: 'Email or password is incorrect.' });
    }
    setSessionCookie(reply, createSession());
    return { ok: true, email: user!.email };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = (req.cookies as any)?.tandem_sid;
    if (token) destroySession(token);
    reply.clearCookie('tandem_sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async () => ({ email: getUser()?.email ?? config.adminEmail }));

  app.post('/api/account/password', async (req, reply) => {
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    const user = getUser();
    if (!user || !current || !verifyPassword(current, user.pass)) {
      return reply.code(400).send({ error: 'Current password is incorrect.' });
    }
    if (!next || next.length < 8) return reply.code(400).send({ error: 'New password must be at least 8 characters.' });
    setPassword(next);
    return { ok: true };
  });

  // ---------------------------------------------------------------- stream

  app.get('/api/stream', (req, reply) => sseHandler(req, reply));

  // ---------------------------------------------------------------- chats

  app.get('/api/chats', async () => listChats());

  app.post('/api/chats', async (req, reply) => {
    const { projectId } = (req.body ?? {}) as { projectId?: string };
    if (!projectId || !getProject(projectId)) return reply.code(400).send({ error: 'Unknown project.' });
    const now = Date.now();
    const id = randomUUID();
    db.prepare('INSERT INTO chats (id, project_id, title, created_at, updated_at, running) VALUES (?, ?, ?, ?, ?, 0)')
      .run(id, projectId, 'New chat', now, now);
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(now, projectId);
    const chat = getChat(id)!;
    broadcast({ type: 'chat', chat });
    return chat;
  });

  app.patch('/api/chats/:id', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const { title } = (req.body ?? {}) as { title?: string };
    if (title?.trim()) setChatTitle(chat.id, title.trim().slice(0, 80));
    return getChat(chat.id);
  });

  app.delete('/api/chats/:id', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    if (isRunning(chat.id)) stopRun(chat.id);
    db.prepare('DELETE FROM events WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
    broadcast({ type: 'chat_deleted', chatId: chat.id });
    return { ok: true };
  });

  app.get('/api/chats/:id/events', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    return { chat, events: getEvents(chat.id), usage: computeUsage(chat) };
  });

  app.post('/api/chats/:id/messages', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    if (isRunning(chat.id)) return reply.code(409).send({ error: 'An agent run is already in progress for this chat.' });
    const { text } = (req.body ?? {}) as { text?: string };
    const clean = (text ?? '').trim();
    if (!clean) return reply.code(400).send({ error: 'Empty message.' });

    const isFirst = !db.prepare("SELECT id FROM events WHERE chat_id = ? AND kind = 'user_message' LIMIT 1").get(chat.id);
    addEvent(chat.id, 'user_message', { text: clean });
    if (isFirst || chat.title === 'New chat') setChatTitle(chat.id, deriveTitle(clean));
    void startRun(chat.id, clean);
    return { ok: true };
  });

  app.post('/api/chats/:id/stop', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const stopped = stopRun(chat.id);
    return { ok: true, stopped };
  });

  // ---------------------------------------------------------------- context & compaction

  app.get('/api/chats/:id/context', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    return computeUsage(chat);
  });

  const previews = new Map<string, CompactPreview & { chatId: string }>();

  app.post('/api/chats/:id/compact/preview', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    if (isRunning(chat.id)) return reply.code(409).send({ error: 'Wait for the current run to finish before compacting.' });
    const settings = getSettings();
    const usage = computeUsage(chat);
    const { summary, preserved } = generateCompactionSummary(chat.id, settings);
    const afterTokens = Math.min(
      settings.context.autoTargetTokens,
      Math.max(4_000, Math.round(usage.usedTokens * 0.3)),
    );
    const preview: CompactPreview & { chatId: string } = {
      previewId: randomUUID(),
      chatId: chat.id,
      beforeTokens: usage.usedTokens,
      afterTokens,
      provider: settings.roles.compactor.provider,
      model: settings.roles.compactor.model,
      summary,
      preserved,
    };
    previews.set(preview.previewId, preview);
    setTimeout(() => previews.delete(preview.previewId), 15 * 60_000).unref?.();
    return preview;
  });

  app.post('/api/chats/:id/compact/apply', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const { previewId } = (req.body ?? {}) as { previewId?: string };
    const preview = previewId ? previews.get(previewId) : undefined;
    if (!preview || preview.chatId !== chat.id) {
      return reply.code(400).send({ error: 'Preview expired — generate a new one.' });
    }
    previews.delete(preview.previewId);
    const ev = addEvent(chat.id, 'compaction', {
      beforeTokens: preview.beforeTokens,
      afterTokens: preview.afterTokens,
      provider: preview.provider,
      model: preview.model,
      summary: preview.summary,
      preserved: preview.preserved,
      durationMs: 5_200,
      simulated: true,
    });
    setChatCompaction(chat.id, ev.id);
    return { ok: true, eventId: ev.id };
  });

  // ---------------------------------------------------------------- settings

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req) => putSettings((req.body ?? {}) as Partial<AppSettings>));

  app.get('/api/settings/effective-prompt', async (req) => {
    const role = ((req.query as any).role ?? 'builder') as RoleName | 'final_repair';
    return { role, prompt: composeEffectivePrompt(role, getSettings()) };
  });

  // ---------------------------------------------------------------- export

  app.get('/api/chats/:id/export', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const project = getProject(chat.projectId)!;
    const format = ((req.query as any).format ?? 'markdown') as string;
    const bundle: ExportBundle = {
      exportedAt: Date.now(),
      app: { name: 'Tandem', version: config.version },
      project,
      chat,
      usage: computeUsage(chat),
      events: getEvents(chat.id),
    };
    const slug = chat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'chat';
    if (format === 'json') {
      reply.header('Content-Disposition', `attachment; filename="tandem-${slug}.json"`);
      return reply.type('application/json').send(JSON.stringify(bundle, null, 2));
    }
    if (format === 'html') {
      reply.header('Content-Disposition', `attachment; filename="tandem-${slug}.html"`);
      return reply.type('text/html; charset=utf-8').send(toHtml(bundle));
    }
    reply.header('Content-Disposition', `attachment; filename="tandem-${slug}.md"`);
    return reply.type('text/markdown; charset=utf-8').send(toMarkdown(bundle));
  });
}
