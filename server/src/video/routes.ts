/**
 * HTTP surface for channels and video projects: the internal endpoint behind
 * the tandem_channel tools, and the signed-in UI's routes — browsing and
 * editing channels, serving media, creating a video, deciding approvals.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { db, getChat } from '../db';
import { addEvent } from '../events';
import { activeCtx } from '../engine/run';
import { createProjectRun, queueObservation } from '../director/engine';
import { getRun } from '../director/store';
import {
  VideoError, assetFilePath, costBreakdown, createChannel, getAsset, getChannelVersion, getVideoProject,
  insertVideoProject, listChannelVersions, listChannels, makeVideoDirectory, pendingApprovals, previewPath,
  requireChannel, searchAssets, updateChannel,
} from './store';
import { decideApproval, handleChannelTool } from './tools';

export function registerVideoRoutes(app: FastifyInstance): void {
  // ------------------------------------------------ internal (tool server)

  app.post('/api/internal/channel', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { token?: string; chatId?: string; role?: string; op?: string; args?: Record<string, unknown>; workdir?: string };
    if (b.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chatId = String(b.chatId ?? '');
    const role = String(b.role ?? 'builder');
    const op = String(b.op ?? '');
    const startedAt = Date.now();
    const r = await handleChannelTool(chatId, role, op, (b.args ?? {}) as Record<string, any>, b.workdir);
    // every channel call is on the chat's record — which is how reuse (or a
    // refused write) can be verified afterwards from the timeline alone
    if (getChat(chatId)) {
      addEvent(chatId, 'tool_call', {
        tool: op, integration: 'Channels', role, args: compactArgs(b.args ?? {}),
        status: r.ok ? 'done' : 'failed', startedAt, durationMs: Date.now() - startedAt,
        ...(r.ok ? { resultPreview: r.text.slice(0, 1_500), resultBytes: r.text.length } : { error: r.error }),
      }, { runId: activeCtx(chatId)?.runId });
    }
    if (!r.ok) return reply.code(r.status).send({ ok: false, error: r.error });
    return { ok: true, text: r.text };
  });

  // ------------------------------------------------ channels (signed in)

  const fail = (reply: any, err: unknown) => {
    if (err instanceof VideoError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/channels', async () => listChannels().map((c) => {
    const v = getChannelVersion(c.id).content;
    return { ...c, description: v.description, entityCount: v.entities.length, assetCount: v.assetIds.length };
  }));

  app.post('/api/channels', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string };
    try { return createChannel({ name: b.name, description: b.description, by: 'user' }); } catch (err) { return fail(reply, err); }
  });

  app.get('/api/channels/:id', async (req, reply) => {
    try {
      const ch = requireChannel((req.params as any).id);
      const q = req.query as any;
      const version = q.version ? Number(q.version) : ch.headVersion;
      const v = getChannelVersion(ch.id, version);
      const assets = searchAssets({ channelId: ch.id, version, runId: null }, { limit: 200 });
      const projects = (db.prepare('SELECT run_id, channel_version FROM video_projects WHERE channel_id = ? ORDER BY created_at DESC').all(ch.id) as any[])
        .map((r) => { const run = getRun(r.run_id); return run ? { runId: r.run_id, chatId: run.chatId, title: run.title, version: r.channel_version } : null; })
        .filter(Boolean);
      return { channel: ch, version: v, versions: listChannelVersions(ch.id), assets, projects };
    } catch (err) { return fail(reply, err); }
  });

  /** edits from the UI — each save is a new version, like an agent's */
  app.patch('/api/channels/:id', async (req, reply) => {
    const b = (req.body ?? {}) as { expectedVersion?: number; name?: string; description?: string; styleBible?: { summary?: string; sections?: Record<string, string | null> }; note?: string };
    try {
      const ch = requireChannel((req.params as any).id);
      return updateChannel(ch.id, { name: b.name, description: b.description, styleBible: b.styleBible }, { expectedVersion: b.expectedVersion, by: 'user', note: b.note });
    } catch (err) { return fail(reply, err); }
  });

  /** media, behind sign-in — images, audio, video only, so nothing here runs in the page */
  app.get('/api/media/:id', async (req, reply) => {
    const a = getAsset((req.params as any).id);
    if (!a) return reply.code(404).send({ error: 'No such asset.' });
    const preview = (req.query as any)?.preview === '1' && fs.existsSync(previewPath(a.id));
    const file = preview ? previewPath(a.id) : assetFilePath(a);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'The file is missing.' });
    reply.header('Content-Type', preview ? 'image/jpeg' : a.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(file));
  });

  // ------------------------------------------------ video projects

  /** New Video: a normal Director project, pinned to a channel version */
  app.post('/api/video-projects', async (req, reply) => {
    const b = (req.body ?? {}) as { channelId?: string; version?: number };
    try {
      const ch = requireChannel(b.channelId);
      const version = b.version ? Number(b.version) : ch.headVersion;
      getChannelVersion(ch.id, version);
      const dir = makeVideoDirectory(ch);
      const { run, chat } = createProjectRun(dir);
      db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(`New video · ${ch.name}`, chat.id);
      const video = insertVideoProject(run.id, ch.id, version);
      return { run: getRun(run.id), chat: { ...chat, title: `New video · ${ch.name}` }, video };
    } catch (err) { return fail(reply, err); }
  });

  app.get('/api/video-projects/:runId', async (req, reply) => {
    const video = getVideoProject((req.params as any).runId);
    if (!video) return reply.code(404).send({ error: 'Not a video project.' });
    return { video, costs: costBreakdown(video.runId), approvals: pendingApprovals(video.runId) };
  });

  app.post('/api/approvals/:id/decide', async (req, reply) => {
    const decision = (req.body as any)?.decision;
    if (decision !== 'approve' && decision !== 'decline') return reply.code(400).send({ error: 'decision must be approve or decline.' });
    const r = decideApproval((req.params as any).id, decision, (runId, text) => queueObservation(runId, `[user decision] ${text}`));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { ok: true };
  });
}

/** long texts (a Style Bible, a script) are shortened for the timeline; the call itself had them in full */
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v)));
}
