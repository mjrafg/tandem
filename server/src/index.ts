import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { authHook, ensureUser, setPassword } from './auth';
import { config } from './config';
import { registerRoutes } from './routes';
import { registerProjectRoutes } from './projectRoutes';
import { registerIntegrationRoutes } from './integrationRoutes';
import { registerAgentRoutes } from './agents/routes';
import { registerObservabilityRoutes } from './observability/routes';
import { seedAgents } from './agents/store';
import { recoverInterruptedRuns } from './engine/run';
import { backfillModelWindows } from './context';
import { recoverDirectorRuns } from './director/engine';
import { shutdownBrowsers, startBrowserReaper } from './engine/browserHost';
import { startReviewRetrySweeper } from './reviewRetrySweeper';
import { reconcileProcGroups } from './engine/procGroups';
import { seedIfEmpty } from './mock/seed';

// ---------------------------------------------------------------- CLI mode

if (process.argv[2] === 'set-password') {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
  process.stdin.on('end', () => {
    const password = Buffer.concat(chunks).toString('utf8').trim();
    if (password.length < 8) {
      console.error('Password must be at least 8 characters (read from stdin).');
      process.exit(1);
    }
    setPassword(password);
    console.log(`Password updated for ${config.adminEmail}.`);
    process.exit(0);
  });
} else {
  void main();
}

async function main(): Promise<void> {
  // Sessions run unjailed, as this same user, in this same PID namespace. A
  // Builder stopping its OWN dev server with `pkill -f "dist/index.js"` was
  // therefore matching THIS process and taking production down — five times in
  // one night, each one silently restarting the service and pausing the run.
  // A distinct title keeps us out of the patterns an agent naturally reaches
  // for (`pkill -f dist/index.js`, `pkill -f node`, `killall node`): Node
  // rewrites both /proc/<pid>/cmdline and comm. Nothing here matches this
  // service by name — deploy.sh uses systemctl, procGroups reaps by pgid.
  // This is collision avoidance, NOT a security boundary. Real containment is
  // a per-session PID namespace so a session cannot signal outside its tree.
  process.title = 'tandem-server';
  ensureUser();
  seedIfEmpty();
  seedAgents(); // once per installation; admin edits/deletions are never overwritten
  // repair chat rows first: this only touches the database, and everything
  // below assumes no chat is still flagged as running
  const interruptedChats = recoverInterruptedRuns();
  void reconcileProcGroups(); // reap process groups of already-terminal sessions
  backfillModelWindows();
  startBrowserReaper();
  startReviewRetrySweeper();
  // graceful stop: checkpoint every chat browser (cookies/localStorage + last
  // page) so continuity recovers after the restart, then close Chromium
  // An unexpected SIGTERM used to be indistinguishable from a clean deploy
  // stop: this handler exited 0 without a word, so a session killing the
  // service left no trace anywhere in tandem.log. Always name the signal — the
  // timestamp is what correlates a restart with the command that caused it.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[tandem] received ${signal} — graceful shutdown, exiting 0`);
    void shutdownBrowsers().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const app = Fastify({
    logger: { level: config.production ? 'warn' : 'info' },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 400 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', authHook);

  registerRoutes(app);
  registerIntegrationRoutes(app);
  registerProjectRoutes(app);
  registerAgentRoutes(app);
  registerObservabilityRoutes(app);

  // ---------------------------------------------------------------- SPA

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      index: ['index.html'],
      maxAge: '1h',
      immutable: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    console.warn(`[tandem] web dist not found at ${config.webDist} — API only`);
  }

  await app.listen({ port: config.port, host: config.host });
  console.log(`[tandem] v${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`[tandem] data: ${config.dataDir} · projects: ${config.projectsDir}`);

  // A project that was running when the server died resumes ITSELF; only a
  // pause the user asked for survives the restart. This runs AFTER listen on
  // purpose: auto-resume wakes the Director, whose MCP tools call straight back
  // into this server's own /api/internal endpoint. Waking it before the port
  // was open would race every tool call in the first turn against startup.
  recoverDirectorRuns(interruptedChats);
  void path;
}
