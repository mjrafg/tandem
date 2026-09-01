/**
 * The read-only Observability interface (v1).
 *
 * Tandem's job here is narrow: expose the evidence it ALREADY retains, under
 * canonical identities, to an external consumer. There is no analysis, no
 * normalization, no curation and no second evidence store — every response is
 * assembled from the same tables and the same serializers the app itself uses.
 *
 * Two rules shape the whole file:
 *
 *   1. COMPLETE evidence means complete. Session evidence reuses the existing
 *      export bundle (project + chat + usage + EVERY event) and the existing
 *      Markdown/HTML serializers. Run evidence reuses the existing run tree
 *      (run + milestones + sessions + agent snapshots) plus its ENTIRE activity
 *      log. Nothing is filtered for Observability's convenience.
 *
 *   2. Run identity is project_runs.id. events.run_id is a per-INVOCATION id
 *      from RunCtx and is deliberately never used to resolve ownership — the
 *      canonical path is run → pd_sessions → chat_id → events.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExportBundle } from '../exporter';
import { toHtml, toMarkdown } from '../exporter';
import { config, shotsDir } from '../config';
import { computeUsage } from '../context';
import { db, getChat, getProject } from '../db';
import { getEvents } from '../events';
import { getRun, listAllActivity } from '../director/store';
import { getAgentSnapshot } from '../agents/store';
import { observabilityStreamHandler } from '../sse';
import { KEY_PREFIX, createKey, instanceId, keyIsActive, listKeys, revokeKey, verifyKey } from './store';

const API_VERSION = 1;
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 2_000;

/** Bearer-only. Browser sessions deliberately do not authenticate this API. */
function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
  const header = req.headers.authorization ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secret || !verifyKey(secret)) {
    reply.code(401).send({ error: 'A valid Observability API key is required.' });
    return false;
  }
  return true;
}

/**
 * Resolve a session identity to the chat that holds its evidence.
 * A Project Director session is addressed by pd_sessions.id; an ordinary chat
 * (or a Project Chat) by its chat id. Both are accepted so historical evidence
 * stays reachable, and the response always states which was matched.
 */
function resolveSession(sessionId: string): {
  chatId: string; sessionRow: any | null; runId: string | null; projectId: string | null;
} | null {
  const s = db.prepare('SELECT * FROM pd_sessions WHERE id = ?').get(sessionId) as any;
  if (s) {
    if (!s.chat_id) return null; // planned but never launched: no evidence yet
    const chat = getChat(s.chat_id);
    return { chatId: s.chat_id, sessionRow: s, runId: s.run_id, projectId: chat?.projectId ?? null };
  }
  const chat = getChat(sessionId);
  if (!chat) return null;
  const owner = db.prepare('SELECT * FROM pd_sessions WHERE chat_id = ?').get(sessionId) as any;
  return { chatId: chat.id, sessionRow: owner ?? null, runId: owner?.run_id ?? chat.projectRunId ?? null, projectId: chat.projectId };
}

/** The existing session export bundle, unchanged and unfiltered. */
function sessionBundle(chatId: string): ExportBundle | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const project = getProject(chat.projectId);
  if (!project) return null;
  return {
    exportedAt: Date.now(),
    app: { name: 'Tandem', version: config.version },
    project,
    chat,
    usage: computeUsage(chat),
    events: getEvents(chat.id), // every persisted event for this chat
  };
}

export function registerObservabilityRoutes(app: FastifyInstance): void {
  const v1 = '/api/observability/v1';

  // ------------------------------------------------- key management (Admin)
  // These live OUTSIDE /v1 on purpose: they are administered with the normal
  // browser session, and an Observability key can never manage keys.

  app.get('/api/observability/keys', async () => ({ keys: listKeys(), keyPrefix: KEY_PREFIX }));

  app.post('/api/observability/keys', async (req, reply) => {
    try {
      const { name } = (req.body ?? {}) as { name?: string };
      // `secret` is returned here and nowhere else, ever
      const { key, secret } = createKey(String(name ?? ''));
      return { key, secret };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Could not create the key.' });
    }
  });

  app.post('/api/observability/keys/:id/revoke', async (req, reply) => {
    const key = revokeKey(String((req.params as any).id));
    if (!key) return reply.code(404).send({ error: 'Key not found.' });
    return { key };
  });

  // ------------------------------------------------------------ instance

  app.get(`${v1}/info`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    return { instanceId: instanceId(), apiVersion: API_VERSION, tandemVersion: config.version };
  });

  // ------------------------------------------------------------ discovery

  app.get(`${v1}/projects`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    // identities only — deliberately not a report
    const rows = db.prepare(`SELECT p.id, p.name, p.root_path, p.source, p.created_at, p.last_opened_at,
        (SELECT COUNT(*) FROM project_runs r WHERE r.project_id = p.id) AS run_count
      FROM projects p ORDER BY p.last_opened_at DESC`).all() as any[];
    return {
      projects: rows.map((p) => ({
        id: p.id, name: p.name, rootPath: p.root_path, source: p.source,
        createdAt: p.created_at, lastOpenedAt: p.last_opened_at, runCount: p.run_count,
      })),
    };
  });

  app.get(`${v1}/projects/:projectId/runs`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const projectId = String((req.params as any).projectId);
    if (!getProject(projectId)) return reply.code(404).send({ error: 'Unknown project.' });
    // every historical Director run of this project stays individually addressable
    const rows = db.prepare('SELECT id, chat_id, title, state, created_at, updated_at FROM project_runs WHERE project_id = ? ORDER BY created_at').all(projectId) as any[];
    return {
      projectId,
      runs: rows.map((r) => ({
        runId: r.id, projectChatId: r.chat_id, title: r.title, state: r.state,
        createdAt: r.created_at, updatedAt: r.updated_at,
      })),
    };
  });

  app.get(`${v1}/runs/:runId`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const run = getRun(String((req.params as any).runId));
    if (!run) return reply.code(404).send({ error: 'Unknown run.' });
    return { run };
  });

  app.get(`${v1}/runs/:runId/sessions`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const runId = String((req.params as any).runId);
    const run = getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Unknown run.' });
    // canonical identities for fetching evidence — run → pd_sessions → chat
    const sessions = run.milestones.flatMap((m) => m.sessions.map((s) => ({
      sessionId: s.id,
      key: s.key,
      milestoneId: s.milestoneId,
      milestoneKey: m.key,
      chatId: s.chatId,
      status: s.status,
      hasEvidence: !!s.chatId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })));
    return { runId, projectId: run.projectId, projectChatId: run.chatId, sessions };
  });

  // ------------------------------------------------------------ evidence

  /**
   * COMPLETE project-run evidence: the canonical run tree exactly as Tandem
   * stores it (run row, milestones, sessions incl. immutable agent snapshots)
   * plus the run's ENTIRE activity log, plus the Project Chat's own export
   * bundle — the Director's own transcript, which is where its planning,
   * observations and orchestration calls live. Session evidence is NOT folded
   * in: it is fetched separately, per session.
   */
  app.get(`${v1}/runs/:runId/evidence`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const runId = String((req.params as any).runId);
    const run = getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Unknown run.' });
    const raw = db.prepare('SELECT * FROM project_runs WHERE id = ?').get(runId) as any;
    const directorChat = sessionBundle(run.chatId);
    return {
      instanceId: instanceId(),
      apiVersion: API_VERSION,
      exportedAt: Date.now(),
      app: { name: 'Tandem', version: config.version },
      runId,
      projectId: run.projectId,
      project: getProject(run.projectId),
      // the persisted run row verbatim, including the orchestration cursors
      run: {
        ...run,
        planReviewRound: raw?.plan_review_round ?? 0,
        pendingRecovery: raw?.pending_recovery ?? null,
        baseBranch: raw?.base_branch ?? null,
        liveEventId: raw?.live_event_id ?? null,
      },
      activity: listAllActivity(runId), // complete, ascending, uncapped
      directorChat, // the Project Chat's full export bundle (all events)
      sessions: run.milestones.flatMap((m) => m.sessions.map((s) => ({
        sessionId: s.id, key: s.key, chatId: s.chatId, status: s.status,
      }))),
    };
  });

  /**
   * COMPLETE session evidence, in the representation the app already produces.
   * `format=json` returns the export bundle itself; markdown/html run the same
   * serializers the chat export route uses. No Observability-specific filtering.
   */
  app.get(`${v1}/sessions/:sessionId/evidence`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const resolved = resolveSession(String((req.params as any).sessionId));
    if (!resolved) return reply.code(404).send({ error: 'Unknown session.' });
    const bundle = sessionBundle(resolved.chatId);
    if (!bundle) return reply.code(404).send({ error: 'Unknown session.' });

    const format = String((req.query as any).format ?? 'json');
    if (format === 'markdown') return reply.type('text/markdown; charset=utf-8').send(toMarkdown(bundle));
    if (format === 'html') return reply.type('text/html; charset=utf-8').send(toHtml(bundle));
    if (format !== 'json') return reply.code(400).send({ error: 'format must be one of: json, markdown, html.' });

    return {
      instanceId: instanceId(),
      apiVersion: API_VERSION,
      sessionId: String((req.params as any).sessionId),
      runId: resolved.runId,
      projectId: resolved.projectId,
      chatId: resolved.chatId,
      // the pd_sessions row verbatim when this chat belongs to a Director run
      session: resolved.sessionRow ? {
        id: resolved.sessionRow.id, key: resolved.sessionRow.key, name: resolved.sessionRow.name,
        purpose: resolved.sessionRow.purpose, prompt: resolved.sessionRow.prompt,
        status: resolved.sessionRow.status, dependsOn: JSON.parse(resolved.sessionRow.depends_on || '[]'),
        branch: resolved.sessionRow.branch, cwd: resolved.sessionRow.cwd,
        resultSummary: resolved.sessionRow.result_summary, reviewVerdict: resolved.sessionRow.review_verdict,
        startedAt: resolved.sessionRow.started_at, endedAt: resolved.sessionRow.ended_at,
        lastBaselineSeq: resolved.sessionRow.last_baseline_seq, stopReason: resolved.sessionRow.stop_reason,
        reviewWaitReason: resolved.sessionRow.review_wait_reason, reviewRetryAt: resolved.sessionRow.review_retry_at,
        agentProfileId: resolved.sessionRow.agent_profile_id,
      } : null,
      // the immutable Agent configuration this session actually executed with
      agentSnapshot: getAgentSnapshot(resolved.chatId),
      latestSeq: bundle.events.length ? bundle.events[bundle.events.length - 1].seq : 0,
      export: bundle, // the existing bundle: project + chat + usage + every event
    };
  });

  // ------------------------------------------------------------ incremental

  app.get(`${v1}/sessions/:sessionId/events`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const resolved = resolveSession(String((req.params as any).sessionId));
    if (!resolved) return reply.code(404).send({ error: 'Unknown session.' });

    const q = (req.query ?? {}) as { after_seq?: string; limit?: string };
    const afterRaw = q.after_seq ?? '0';
    const limitRaw = q.limit ?? String(DEFAULT_EVENT_LIMIT);
    if (!/^\d+$/.test(String(afterRaw)) || !/^\d+$/.test(String(limitRaw))) {
      return reply.code(400).send({ error: 'after_seq and limit must be non-negative integers.' });
    }
    const afterSeq = Number(afterRaw);
    const limit = Math.min(Math.max(Number(limitRaw), 1), MAX_EVENT_LIMIT);

    // events.seq is per-chat, dense and monotonic — the existing cursor, reused
    const rows = db.prepare('SELECT * FROM events WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(resolved.chatId, afterSeq, limit) as any[];
    const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE chat_id = ?').get(resolved.chatId) as any;
    const events = rows.map((r) => ({
      id: r.id, chatId: r.chat_id, seq: r.seq, ts: r.ts, runId: r.run_id ?? null,
      kind: r.kind, payload: JSON.parse(r.payload),
    }));
    // Tandem finalises an in-flight event by REWRITING its payload in place —
    // seq never changes. A consumer paging forward would keep the provisional
    // copy forever, so every page names the events that were not final when it
    // was served; re-read one with after_seq = seq - 1 & limit = 1.
    const pendingSeqs = events
      .filter((e) => (e.payload as any)?.status === 'running' || (e.payload as any)?.streaming === true)
      .map((e) => e.seq);
    return {
      sessionId: String((req.params as any).sessionId),
      chatId: resolved.chatId,
      runId: resolved.runId,
      afterSeq,
      limit,
      count: events.length,
      nextAfterSeq: events.length ? events[events.length - 1].seq : afterSeq,
      latestSeq: latest.s as number,
      hasMore: events.length > 0 && (events[events.length - 1].seq < (latest.s as number)),
      pendingSeqs,
      events,
    };
  });

  // ------------------------------------------------------------ artifacts

  /**
   * Retained screenshots referenced by browser events. Same storage, same
   * naming discipline as the app's own route: the filename is validated against
   * a strict pattern and joined under the chat's own directory, so traversal and
   * absolute paths cannot escape. Read-only: no upload, update or delete.
   */
  app.get(`${v1}/sessions/:sessionId/artifacts/:file`, async (req, reply) => {
    if (!authorize(req, reply)) return;
    const resolved = resolveSession(String((req.params as any).sessionId));
    if (!resolved) return reply.code(404).send({ error: 'Unknown session.' });
    const file = String((req.params as any).file ?? '');
    if (!/^[\w-]+\.jpg$/.test(file)) return reply.code(400).send({ error: 'Bad artifact name.' });
    const dir = path.join(shotsDir, resolved.chatId);
    const full = path.join(dir, file);
    // the resolved path must live under the chat's own directory …
    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
      return reply.code(400).send({ error: 'Bad artifact name.' });
    }
    // … and must be a REAL regular file there. A session's own Builder can
    // write into its shots directory, so a symlink planted as <name>.jpg would
    // otherwise turn this route into an arbitrary host-file read.
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { return reply.code(404).send({ error: 'Artifact not found.' }); }
    if (!st.isFile()) return reply.code(404).send({ error: 'Artifact not found.' });
    let real: string;
    try { real = fs.realpathSync(full); } catch { return reply.code(404).send({ error: 'Artifact not found.' }); }
    if (path.dirname(real) !== fs.realpathSync(dir)) {
      return reply.code(404).send({ error: 'Artifact not found.' });
    }
    return reply.type('image/jpeg').send(fs.createReadStream(real));
  });

  // ------------------------------------------------------------ wake-up stream

  app.get(`${v1}/stream`, (req, reply) => {
    const header = req.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7) : '';
    const key = secret ? verifyKey(secret) : null;
    if (!key) {
      reply.code(401).send({ error: 'A valid Observability API key is required.' });
      return;
    }
    // revocation must reach a connection that is already open: the stream
    // re-checks the key on every heartbeat and closes when it stops being valid
    observabilityStreamHandler(req, reply, () => keyIsActive(key.id));
  });
}
