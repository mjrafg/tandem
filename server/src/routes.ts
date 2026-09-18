import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, AttachmentMeta, BrowserActionPayload, RoleName } from '../../shared/types';
import {
  createSession, destroySession, getUser, loginAllowed, recordLoginAttempt,
  setPassword, setSessionCookie, verifyPassword,
} from './auth';
import { computeUsage } from './context';
import { config, shotsDir } from './config';
import { db, getChat, getProject, rowToChat } from './db';
import {
  addEvent, broadcastChat, deriveTitle, getEvents, listChats, setChatTitle,
} from './events';
import { toHtml, toMarkdown, type ExportBundle } from './exporter';
import { performNativeCompaction } from './engine/providerContext';
import {
  createProjectRun, directorUserMessage, handleDirectorTool, pauseProject, resumeProject,
} from './director/engine';
import { canonicalSessionTitle, getRun, listActivity, runForChat, sessionForChat, sessionTitlePrefix } from './director/store';
import {
  allMemories, createMemory, getMemory, listMemories, searchMemories, toToolShape,
  toJson as toMemoryJson, toMarkdown as toMemoryMarkdown, toPlainText as toMemoryText,
} from './projectMemory';
import { activeCtx } from './engine/run';
import { handleBrowserTool, releaseBrowsers } from './engine/browserHost';
import { deletePendingReview } from './engine/reviewWait';
import { deleteLedger } from './engine/reviewLedger';
import { terminateProcGroup } from './engine/procGroups';
import { deleteAgentSnapshot } from './agents/store';
import { applyWorkdirChange, isRunning, setGitWorkflow, startRun, stopRun } from './engine/workflow';
import { expediteRunReviews } from './reviewRetrySweeper';
import { broadcast, sseHandler } from './sse';
import { getSettings, putSettings, validateRoleConfigs } from './settings';
import { allProviderHealth } from './providers/executor';
import { providerRegistry } from './providers/registry';
import { resolveBuilderRole, resolveDirectorRoleConfig, resolveReviewerRole } from './providers/resolve';
import { allStatus, cancelLogin, forgetToken, getLogin, startLogin, storePastedToken, submitCode, tokenMeta, type AuthProvider } from './providerAuth';
import { buildRolePreview, exportPrompts, importPrompts, listPrompts, resetPrompt, setPromptOverride } from './prompts';
import { listTools, resetToolText, setToolText } from './toolText';

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
    // a deleted chat leaves no browser state behind — live instances closed,
    // durable cookies/storage erased
    void releaseBrowsers(chat.id, { deleteDurable: true });
    void terminateProcGroup(chat.id); // background processes die with their chat
    deletePendingReview(chat.id); // and no orphaned review retry either
    deleteAgentSnapshot(chat.id);
    deleteLedger(chat.id); // the task's review budget goes with it
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
    // Director-owned session chats are operated exclusively through the run's
    // orchestration — a stray message here would start an unmonitored run in
    // the session's workspace behind the Director's back. The kind marker also
    // covers chats a relaunch has orphaned from the pd_sessions pointer.
    const pdSession = sessionForChat(chat.id);
    if (pdSession || chat.kind === 'pd-session') {
      return reply.code(409).send({ error: `This chat ${pdSession ? `is session ${pdSession.key} of` : 'belongs to'} a Project Director run — it is driven from the Project Chat. Ask the Director there instead.` });
    }
    const { text, attachmentIds, review } = (req.body ?? {}) as { text?: string; attachmentIds?: string[]; review?: boolean };
    const clean = (text ?? '').trim();
    const attachments = resolveAttachments(attachmentIds ?? []);
    if (!clean && attachments.length === 0) return reply.code(400).send({ error: 'Empty message.' });

    const isFirst = !db.prepare("SELECT id FROM events WHERE chat_id = ? AND kind = 'user_message' LIMIT 1").get(chat.id);
    addEvent(chat.id, 'user_message', attachments.length > 0 ? { text: clean, attachments } : { text: clean });
    if (isFirst || chat.title === 'New chat' || chat.title === 'New project') {
      setChatTitle(chat.id, deriveTitle(clean || attachments[0]?.name || 'New chat'));
    }
    // a Project Chat message goes to the Project Director; everything else is
    // the unchanged normal-session path
    if (chat.kind === 'project') directorUserMessage(chat, clean);
    else void startRun(chat.id, clean, attachments, { review: review !== false });
    return { ok: true };
  });

  // ------------------------------------------------- project director

  app.post('/api/project-runs', async (req, reply) => {
    const { dirPath } = (req.body ?? {}) as { dirPath?: string };
    if (!dirPath?.trim()) return reply.code(400).send({ error: 'A target directory is required.' });
    if (!path.isAbsolute(dirPath) || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return reply.code(400).send({ error: 'The target must be an existing absolute directory.' });
    }
    try {
      return createProjectRun(dirPath);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Could not create the project run.' });
    }
  });

  app.get('/api/project-runs/:id', async (req, reply) => {
    const run = getRun((req.params as any).id);
    if (!run) return reply.code(404).send({ error: 'Project run not found.' });
    return { run, activity: listActivity(run.id) };
  });

  app.post('/api/project-runs/:id/pause', async (req, reply) => {
    try {
      pauseProject((req.params as any).id);
      return { ok: true, run: getRun((req.params as any).id) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Pause failed.' });
    }
  });

  app.post('/api/project-runs/:id/resume', async (req, reply) => {
    try {
      resumeProject((req.params as any).id);
      return { ok: true, run: getRun((req.params as any).id) };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Resume failed.' });
    }
  });

  // Retry the run's reviews that are waiting on a provider outage NOW, instead
  // of waiting for the provider's scheduled reset — the control an operator
  // uses after lifting a Codex usage limit. Reuses the sweeper's guarded path.
  app.post('/api/project-runs/:id/retry-reviews', async (req, reply) => {
    const run = getRun((req.params as any).id);
    if (!run) return reply.code(404).send({ error: 'Project run not found.' });
    const { requeued, runState } = expediteRunReviews(run.id);
    return { ok: true, requeued, runState, run: getRun(run.id) };
  });

  app.post('/api/internal/director', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chat = getChat(String(b.chatId ?? ''));
    if (!chat || chat.kind !== 'project') return reply.code(403).send({ ok: false, error: 'Not a Project Director chat.' });
    const out = await handleDirectorTool(chat.id, String(b.op ?? ''), b.args ?? {});
    // record the orchestration call in the project chat like any other tool
    const run = runForChat(chat.id);
    addEvent(chat.id, 'tool_call', {
      tool: `director_${String(b.op ?? '')}`,
      integration: 'Project Director',
      role: 'director',
      args: summarizeToolArgs(b.args ?? {}),
      status: out.ok ? 'done' : 'failed',
      resultPreview: (out.text ?? out.error ?? '').slice(0, 1_000),
      ...(out.error ? { error: out.error } : {}),
      startedAt: Date.now(),
      durationMs: 0,
    });
    if (run) { /* run broadcast happens inside the store on mutation */ }
    return out.ok ? { ok: true, text: out.text } : reply.code(400).send({ ok: false, error: out.error });
  });

  /** compact, non-flooding record of a director tool call's arguments */
  function summarizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (Array.isArray(v)) out[k] = v.length <= 8 && v.every((x) => typeof x === 'string') ? v : `[${v.length} items]`;
      else if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
      else out[k] = v;
    }
    return out;
  }

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

  // Provider-native compaction: the provider that owns the chat's session
  // compacts its own context. No separate Compactor model is ever invoked.
  app.post('/api/chats/:id/compact', async (req, reply) => {
    const chat = getChat((req.params as any).id);
    if (!chat) return reply.code(404).send({ error: 'Chat not found.' });
    if (isRunning(chat.id)) return reply.code(409).send({ error: 'Wait for the current run to finish before compacting.' });
    // a Project Chat's session belongs to the Director (always claude-code)
    const outcome = chat.kind === 'project'
      ? await performNativeCompaction(chat, 'manual', resolveDirectorRoleConfig(getSettings()))
      : await performNativeCompaction(chat, 'manual');
    if (!outcome.ok) return reply.code(502).send({ error: outcome.error ?? 'Native compaction failed.', outcome });
    return outcome;
  });

  // ------------------------------------------------- internal (localhost MCP)

  app.post('/api/internal/workdir', async (req, reply) => {
    const { chatId, path: dirPath, token } = (req.body ?? {}) as { chatId?: string; path?: string; token?: string };
    if (token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const result = applyWorkdirChange(chatId ?? '', dirPath ?? '');
    return result.ok ? result : reply.code(400).send(result);
  });

  /**
   * A Director session's Builder registers its short descriptive name here on
   * its first turn. Tandem composes the canonical title from PD metadata —
   * the model never controls the milestone/session keys — and renames the
   * existing chat exactly once (a later call cannot re-title it).
   */
  app.post('/api/internal/name-session', async (req, reply) => {
    const { chatId, token, name } = (req.body ?? {}) as { chatId?: string; token?: string; name?: string };
    if (token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chat = chatId ? getChat(chatId) : null;
    const session = chatId ? sessionForChat(chatId) : null;
    if (!chat || !session) return reply.code(400).send({ ok: false, error: 'This chat is not a Project Director session.' });
    if (!String(name ?? '').trim()) return reply.code(400).send({ ok: false, error: 'Provide a non-empty name.' });
    if (chat.title.startsWith(sessionTitlePrefix(session))) {
      return { ok: true, applied: false, title: chat.title }; // already named — once only
    }
    const title = canonicalSessionTitle(session, String(name));
    setChatTitle(chatId!, title);
    return { ok: true, applied: true, title };
  });

  app.post('/api/internal/git-workflow', async (req, reply) => {
    const { chatId, token, mode, target_branch, push } = (req.body ?? {}) as Record<string, string | undefined>;
    if (token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const result = await setGitWorkflow(chatId ?? '', { mode, target_branch, push });
    return result.ok ? result : reply.code(400).send(result);
  });

  /**
   * Project Memory for the Builder. The project is resolved from the calling
   * chat — the model never supplies a project id, so a call cannot reach
   * another project's memory even with a valid id from elsewhere. Refused
   * outright while a review is running: the Reviewer must stay independent.
   */
  app.post('/api/internal/project-memory', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chat = getChat(String(b.chatId ?? ''));
    if (!chat) return reply.code(404).send({ ok: false, error: 'Unknown chat.' });
    if (activeCtx(chat.id)?.phase === 'reviewer') {
      return reply.code(403).send({ ok: false, error: 'Project Memory is not available to the Reviewer.' });
    }
    const projectId = chat.projectId;
    const started = Date.now();
    const op = String(b.op ?? '');
    const args: Record<string, unknown> = {};
    for (const k of ['query', 'limit', 'memory_id', 'title', 'tags']) if (b[k] !== undefined) args[k] = b[k];
    if (b.content !== undefined) args.content = String(b.content).slice(0, 200);

    const record = (status: 'done' | 'failed', text: string, error?: string) => {
      addEvent(chat.id, 'tool_call', {
        tool: `project_memory_${op}`,
        integration: 'Project Memory',
        role: 'builder',
        args,
        status,
        resultPreview: text.slice(0, 4_000),
        resultBytes: text.length,
        ...(error ? { error } : {}),
        startedAt: started,
        durationMs: Date.now() - started,
      });
    };

    try {
      let text: string;
      if (op === 'search') {
        const found = searchMemories(projectId, String(b.query ?? ''), b.limit);
        text = found.length === 0
          ? `No project memories match "${String(b.query ?? '')}".`
          : `${found.length} project ${found.length === 1 ? 'memory' : 'memories'} matched:\n${JSON.stringify(found.map(toToolShape), null, 2)}`;
      } else if (op === 'list') {
        const all = listMemories(projectId, b.limit);
        text = all.length === 0
          ? 'This project has no stored memories yet.'
          : `${all.length} stored:\n${JSON.stringify(all.map(toToolShape), null, 2)}`;
      } else if (op === 'get') {
        const one = getMemory(projectId, String(b.memory_id ?? ''));
        if (!one) {
          const msg = 'No memory with that id exists in this project.';
          record('failed', msg, msg);
          return { ok: true, text: msg };
        }
        text = JSON.stringify(toToolShape(one), null, 2);
      } else if (op === 'create') {
        const made = createMemory(projectId, { title: b.title, content: b.content, tags: b.tags });
        text = `Stored in this project's memory (memory_id ${made.id}). Every chat in this project can now find it.`;
      } else {
        return reply.code(400).send({ ok: false, error: `Unknown project memory operation: ${op}` });
      }
      record('done', text);
      return { ok: true, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record('failed', message, message);
      return reply.code(400).send({ ok: false, error: message });
    }
  });

  // ------------------------------------------------- project memory (UI)

  app.get('/api/projects/:id/memories', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    const memories = allMemories(project.id);
    return { projectId: project.id, count: memories.length, memories };
  });

  app.get('/api/projects/:id/memories/export', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    const format = String((req.query as any)?.format ?? 'md');
    const memories = allMemories(project.id);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="project-memory-${stamp}.json"`);
      return reply.send(toMemoryJson(project.id, memories));
    }
    if (format === 'text') {
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.send(toMemoryText(memories));
    }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="project-memory-${stamp}.md"`);
    return reply.send(toMemoryMarkdown(memories));
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

  /**
   * The Tandem browser itself. The SERVER owns one browser per chat+role
   * (engine/browserHost.ts) so live state survives across AI invocations;
   * mcp-browser.cjs is only a stdio proxy into this route. The action is
   * recorded in the timeline here — sanitized exactly like /browser-event,
   * never including cookies, storage, or credentials.
   */
  app.post('/api/internal/browser', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const chat = getChat(String(b.chatId ?? ''));
    if (!chat) return reply.code(404).send({ ok: false, error: 'Unknown chat.' });
    // the role comes from the AUTHORITATIVE active run context, never the
    // caller's body: the internal token lives inside the Reviewer's jail too,
    // so a body-supplied role would let a prompt-injected Reviewer address the
    // Builder's browser bucket and read its cookies. Whenever a run is active
    // (always true for a real browser call), its phase — the same signal that
    // gates Builder-only tools — decides, and cannot be spoofed. Only with no
    // run active at all (nothing then holds the token) is the body a fallback.
    const ctx = activeCtx(chat.id);
    const role = ctx ? (ctx.phase === 'reviewer' ? 'reviewer' : 'builder')
      : (b.role === 'reviewer' ? 'reviewer' : 'builder');
    const t0 = Date.now();
    const result = await handleBrowserTool(chat.id, role, String(b.tool ?? ''), (b.args ?? {}) as Record<string, unknown>);
    if (result.report && getChat(chat.id)) { // skip recording if the chat was deleted mid-call
      const r = result.report as Record<string, any>;
      const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
      const payload: BrowserActionPayload = {
        action: s(r.action, 40) ?? 'action',
        detail: s(r.detail, 300) ?? '',
        url: s(r.url, 600),
        title: s(r.title, 200),
        viewport: r.viewport && typeof r.viewport.width === 'number'
          ? { width: r.viewport.width, height: r.viewport.height, deviceScaleFactor: r.viewport.deviceScaleFactor }
          : undefined,
        ref: s(r.ref, 120),
        value: s(r.value, 240),
        screenshotFile: s(r.screenshotFile, 80),
        console: Array.isArray(r.console)
          ? r.console.slice(0, 12).map((c: any) => ({ level: s(c?.level, 20) ?? 'log', text: s(c?.text, 240) ?? '' }))
          : undefined,
        error: s(r.error, 400),
        durationMs: Date.now() - t0,
        status: r.status === 'failed' ? 'failed' : 'done',
        role: role.slice(0, 20),
      };
      addEvent(chat.id, 'browser', payload, { runId: activeCtx(chat.id)?.runId });
    }
    return {
      content: result.content ?? [{ type: 'text', text: result.text ?? 'ok' }],
      ...(result.isError ? { isError: true } : {}),
    };
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

  // ---------------------------------------------------------------- provider sign-in
  // The Builder/Reviewer/Director ARE the provider CLIs, so when their own
  // login expires Tandem stops entirely. These routes drive the CLIs' normal
  // interactive login from the browser. The pasted code goes straight to the
  // CLI's stdin: it is never stored, logged or evented, and the output shown
  // back is scrubbed of anything token-shaped first.
  app.get('/api/provider-auth', async () => ({
    providers: await allStatus(),
    logins: [getLogin('claude'), getLogin('codex')].filter(Boolean),
    // metadata only: whether a long-lived token exists and when it lapses.
    // The token itself is never returned by any route.
    tokens: [tokenMeta('claude'), tokenMeta('codex')].filter(Boolean),
  }));

  app.post('/api/provider-auth/:provider/start', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    return startLogin(provider);
  });

  /**
   * Save a long-lived token the operator minted themselves with
   * `claude setup-token` and pasted in. The value is checked against the API
   * before it is stored, and neither the body nor the reply is ever logged.
   */
  app.post('/api/provider-auth/:provider/token', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    const token = String((req.body as any)?.token ?? '');
    const model = getSettings().roles.builder.model;
    const res = await storePastedToken(provider, token, model);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, token: res.meta };
  });

  app.delete('/api/provider-auth/:provider/token', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    forgetToken(provider);
    return { ok: true };
  });

  app.get('/api/provider-auth/:provider/poll', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    return getLogin(provider) ?? { provider, phase: 'idle' };
  });

  app.post('/api/provider-auth/:provider/code', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    const code = String((req.body as any)?.code ?? '');
    const out = submitCode(provider, code);
    if (!out.ok) return reply.code(400).send({ error: out.error });
    return getLogin(provider);
  });

  app.post('/api/provider-auth/:provider/cancel', async (req, reply) => {
    const provider = authProvider(req, reply);
    if (!provider) return;
    cancelLogin(provider);
    return { ok: true };
  });

  app.get('/api/settings', async () => getSettings());

  app.put('/api/settings', async (req, reply) => {
    const patch = (req.body ?? {}) as Partial<AppSettings>;
    // the server is authoritative: a provider/model pair that cannot run is
    // refused here, whatever the client offered
    const problem = validateRoleConfigs(patch);
    if (problem) return reply.code(400).send({ error: problem });
    return putSettings(patch);
  });

  // ---------------------------------------------------------------- AI providers

  /** The registry as the UI sees it: providers, their models, capabilities, and
   *  what each role currently resolves to. The only model list the UI reads. */
  app.get('/api/providers', async () => {
    const s = getSettings();
    return {
      providers: providerRegistry.list(),
      resolved: {
        builder: resolveBuilderRole(s),
        reviewer: resolveReviewerRole(s),
        director: resolveDirectorRoleConfig(s),
      },
    };
  });

  /** Installed / signed in, per provider. Spends no model usage. */
  app.get('/api/providers/health', async () => ({ providers: await allProviderHealth() }));

  app.get('/api/settings/effective-prompt', async (req) => {
    const role = ((req.query as any).role ?? 'builder') as RoleName | 'final_repair';
    return { role, prompt: buildRolePreview(role, getSettings()) };
  });

  // ---------------------------------------------------------------- AI prompts

  app.get('/api/prompts', async () => listPrompts());

  app.get('/api/prompts/export', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="tandem-prompts.json"');
    return reply.type('application/json').send(JSON.stringify(exportPrompts(), null, 2));
  });

  app.post('/api/prompts/import', async (req, reply) => {
    try {
      const summary = importPrompts(req.body);
      return { summary, prompts: listPrompts() };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid prompts file.' });
    }
  });

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

  // ---------------------------------------------------------------- AI tools

  app.get('/api/tools', async () => listTools());

  app.put('/api/tools/:server/:tool', async (req, reply) => {
    const { server, tool } = req.params as { server: string; tool: string };
    const { description, params } = (req.body ?? {}) as { description?: string; params?: Record<string, string> };
    try {
      await setToolText(server, tool, { description, params });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid tool edit.' });
    }
    return (await listTools()).find((t) => t.server === server && t.name === tool);
  });

  app.delete('/api/tools/:server/:tool', async (req, reply) => {
    const { server, tool } = req.params as { server: string; tool: string };
    try {
      await resetToolText(server, tool);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'Unknown tool.' });
    }
    return (await listTools()).find((t) => t.server === server && t.name === tool);
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

/** the :provider path parameter, or a 400 — only two CLIs can be signed in */
function authProvider(req: any, reply: any): AuthProvider | null {
  const p = String(req.params?.provider ?? '');
  if (p !== 'claude' && p !== 'codex') {
    reply.code(400).send({ error: `Unknown provider: ${p}` });
    return null;
  }
  return p;
}
