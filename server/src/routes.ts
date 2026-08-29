import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, AttachmentMeta, BrowserActionPayload, CompactPreview, RoleName } from '../../shared/types';
import {
  createSession, destroySession, getUser, loginAllowed, recordLoginAttempt,
  setPassword, setSessionCookie, verifyPassword,
} from './auth';
import { computeUsage } from './context';
import { config, shotsDir } from './config';
import { db, getChat, getProject, rowToChat } from './db';
import {
  addEvent, broadcastChat, deriveTitle, getEvents, listChats, setChatCompaction, setChatTitle,
} from './events';
import { toHtml, toMarkdown, type ExportBundle } from './exporter';
import { applyCompaction, runCompaction, type CompactionCall } from './engine/compactor';
import { activeCtx } from './engine/run';
import { applyWorkdirChange, isRunning, startRun, stopRun } from './engine/workflow';
import { broadcast, sseHandler } from './sse';
import { getSettings, putSettings } from './settings';
import { buildRolePreview, listPrompts, resetPrompt, setPromptOverride } from './prompts';

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
    const { text, attachmentIds } = (req.body ?? {}) as { text?: string; attachmentIds?: string[] };
    const clean = (text ?? '').trim();
    const attachments = resolveAttachments(attachmentIds ?? []);
    if (!clean && attachments.length === 0) return reply.code(400).send({ error: 'Empty message.' });

    const isFirst = !db.prepare("SELECT id FROM events WHERE chat_id = ? AND kind = 'user_message' LIMIT 1").get(chat.id);
    addEvent(chat.id, 'user_message', attachments.length > 0 ? { text: clean, attachments } : { text: clean });
    if (isFirst || chat.title === 'New chat') {
      setChatTitle(chat.id, deriveTitle(clean || attachments[0]?.name || 'New chat'));
    }
    void startRun(chat.id, clean, attachments);
    return { ok: true };
  });

  // ---------------------------------------------------------------- attachments

  const attachmentsDir = path.join(config.dataDir, 'attachments');

  function resolveAttachments(ids: string[]): AttachmentMeta[] {
    const out: AttachmentMeta[] = [];
    for (const id of ids.slice(0, 8)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const dir = path.join(attachmentsDir, id);
      try {
        const [name] = fs.readdirSync(dir);
        if (!name) continue;
        const full = path.join(dir, name);
        out.push({ id, name, size: fs.statSync(full).size, path: full });
      } catch { /* attachment was removed */ }
    }
    return out;
  }

  app.post('/api/chats/:id/attachments', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const file = await (req as any).file({ limits: { fileSize: 200 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'No file received.' });
    const name = path.basename(file.filename || 'attachment').replace(/[\0/]/g, '_').slice(0, 120) || 'attachment';
    const id = randomUUID();
    const dir = path.join(attachmentsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const buf = await file.toBuffer();
    fs.writeFileSync(path.join(dir, name), buf);
    return { id, name, size: buf.length } satisfies AttachmentMeta;
  });

  app.delete('/api/attachments/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: 'Bad attachment id.' });
    fs.rmSync(path.join(attachmentsDir, id), { recursive: true, force: true });
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

  const previews = new Map<string, { chatId: string; call: CompactionCall }>();

  app.post('/api/chats/:id/compact/preview', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    if (isRunning(chat.id)) return reply.code(409).send({ error: 'Wait for the current run to finish before compacting.' });
    const call = await runCompaction(chat); // the real Compactor CLI call
    if (!call.ok) return reply.code(502).send({ error: call.error ?? 'Compaction failed.' });
    const previewId = randomUUID();
    previews.set(previewId, { chatId: chat.id, call });
    setTimeout(() => previews.delete(previewId), 30 * 60_000).unref?.();
    const preview: CompactPreview = {
      previewId,
      beforeTokens: call.beforeTokens,
      afterTokens: call.afterTokens,
      provider: call.provider,
      model: call.model,
      summary: call.summary,
      preserved: call.preserved,
    };
    return preview;
  });

  app.post('/api/chats/:id/compact/apply', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const { previewId } = (req.body ?? {}) as { previewId?: string };
    const stored = previewId ? previews.get(previewId) : undefined;
    if (!stored || stored.chatId !== chat.id) {
      return reply.code(400).send({ error: 'Preview expired — generate a new one.' });
    }
    previews.delete(previewId!);
    const eventId = applyCompaction(chat, stored.call);
    return { ok: true, eventId };
  });

  // ------------------------------------------------- internal (localhost MCP)

  app.post('/api/internal/workdir', async (req, reply) => {
    const { chatId, path: dirPath, token } = (req.body ?? {}) as { chatId?: string; path?: string; token?: string };
    if (token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const result = applyWorkdirChange(chatId ?? '', dirPath ?? '');
    return result.ok ? result : reply.code(400).send(result);
  });

  app.post('/api/internal/browser-event', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chat = getChat(String(b.chatId ?? ''));
    if (!chat) return reply.code(404).send({ ok: false, error: 'Unknown chat.' });
    const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    const payload: BrowserActionPayload = {
      action: s(b.action, 40) ?? 'action',
      detail: s(b.detail, 300) ?? '',
      url: s(b.url, 600),
      title: s(b.title, 200),
      viewport: b.viewport && typeof b.viewport.width === 'number'
        ? { width: b.viewport.width, height: b.viewport.height, deviceScaleFactor: b.viewport.deviceScaleFactor }
        : undefined,
      ref: s(b.ref, 120),
      value: s(b.value, 240),
      screenshotFile: s(b.screenshotFile, 80),
      console: Array.isArray(b.console)
        ? b.console.slice(0, 12).map((c: any) => ({ level: s(c?.level, 20) ?? 'log', text: s(c?.text, 240) ?? '' }))
        : undefined,
      error: s(b.error, 400),
      durationMs: typeof b.durationMs === 'number' ? b.durationMs : undefined,
      status: b.status === 'failed' ? 'failed' : 'done',
      role: s(b.role, 20),
    };
    addEvent(chat.id, 'browser', payload, { runId: activeCtx(chat.id)?.runId });
    return { ok: true };
  });

  // ------------------------------------------------- browser screenshots

  app.get('/api/chats/:id/shots/:file', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    const file = String((req.params as any).file ?? '');
    if (!/^[\w-]+\.jpg$/.test(file)) return reply.code(400).send({ error: 'Bad file name.' });
    const full = path.join(shotsDir, chat.id, file);
    if (!fs.existsSync(full)) return reply.code(404).send({ error: 'Screenshot not found.' });
    return reply
      .header('Cache-Control', 'private, max-age=604800, immutable')
      .type('image/jpeg')
      .send(fs.createReadStream(full));
  });

  // ---------------------------------------------------------------- settings

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req) => putSettings((req.body ?? {}) as Partial<AppSettings>));

  app.get('/api/settings/effective-prompt', async (req) => {
    const role = ((req.query as any).role ?? 'builder') as RoleName | 'final_repair';
    return { role, prompt: buildRolePreview(role, getSettings()) };
  });

  // ---------------------------------------------------------------- AI prompts

  app.get('/api/prompts', async () => listPrompts());

  app.put('/api/prompts/:key', async (req, reply) => {
    const key = String((req.params as any).key ?? '');
    const { value } = (req.body ?? {}) as { value?: string };
    if (typeof value !== 'string') return reply.code(400).send({ error: 'Provide "value".' });
    if (value.length > 20_000) return reply.code(400).send({ error: 'Prompt text is limited to 20,000 characters.' });
    try {
      setPromptOverride(key, value);
    } catch {
      return reply.code(404).send({ error: 'Unknown prompt key.' });
    }
    return listPrompts().find((p) => p.key === key);
  });

  app.delete('/api/prompts/:key', async (req, reply) => {
    const key = String((req.params as any).key ?? '');
    try {
      resetPrompt(key);
    } catch {
      return reply.code(404).send({ error: 'Unknown prompt key.' });
    }
    return listPrompts().find((p) => p.key === key) ?? { ok: true };
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
