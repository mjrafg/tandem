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
import { recoverInterruptedRuns } from './engine/run';
import { backfillModelWindows } from './context';
import { recoverDirectorRuns } from './director/engine';
import { shutdownBrowsers, startBrowserReaper } from './engine/browserHost';
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
  ensureUser();
  seedIfEmpty();
  recoverInterruptedRuns();
  recoverDirectorRuns();
  backfillModelWindows();
  startBrowserReaper();
  // graceful stop: checkpoint every chat browser (cookies/localStorage + last
  // page) so continuity recovers after the restart, then close Chromium
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
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
  void path;
}
