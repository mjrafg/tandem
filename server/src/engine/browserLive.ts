/**
 * The live view of an agent's browser: what the Builder's or the Reviewer's
 * Chromium is showing right now, streamed to the web app, and a way for the
 * user to act in it.
 *
 * Frames come from Chrome's own screencast on the agent's actual page, so the
 * viewer sees exactly what the agent's browser renders, not a re-creation.
 * One screencast serves every viewer of the same browser, runs only while
 * someone is watching, and follows the agent when it switches tabs or its
 * browser restarts. Frames are paced so a busy page cannot flood the stream,
 * and a viewer whose connection is backed up skips frames rather than
 * buffering them.
 *
 * Watching never launches a browser and never touches the page. Acting does:
 * user input is queued behind the agent's own calls (userBrowserAction), and
 * the agent is told about it on its next call.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BrowserLiveFrame, BrowserLiveState } from '../../../shared/types';
import { getChat } from '../db';
import { BrowserUserError, onBrowserChange, peekBrowser, userBrowserAction, type RoleBucket } from './browserHost';

/** at most ~8 frames a second per browser */
const MIN_FRAME_MS = 120;
const HEARTBEAT_MS = 20_000;

interface Viewer {
  send(event: 'state' | 'frame', data: unknown): void;
  /** its connection is backed up: frames are skipped until it drains */
  congested: boolean;
}

interface Session {
  key: string;
  chatId: string;
  bucket: RoleBucket;
  viewers: Set<Viewer>;
  page: any | null;
  cdp: any | null;
  off: (() => void)[];
  lastFrame: BrowserLiveFrame | null;
  lastAckAt: number;
  stateSig: string;
  syncing: Promise<void> | null;
  again: boolean;
}

const sessions = new Map<string, Session>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  onBrowserChange((key) => {
    const s = sessions.get(key);
    if (s) void sync(s);
  });
}

function subscribe(chatId: string, bucket: RoleBucket, viewer: Viewer): () => void {
  listen();
  const key = `${chatId}::${bucket}`;
  let s = sessions.get(key);
  if (!s) {
    s = {
      key, chatId, bucket, viewers: new Set(), page: null, cdp: null, off: [],
      lastFrame: null, lastAckAt: 0, stateSig: '', syncing: null, again: false,
    };
    sessions.set(key, s);
  }
  const session = s;
  session.viewers.add(viewer);
  if (session.lastFrame) viewer.send('frame', session.lastFrame);
  session.stateSig = ''; // the newcomer needs the state even if nothing changed
  void sync(session);
  return () => {
    session.viewers.delete(viewer);
    if (session.viewers.size === 0 && sessions.get(key) === session) {
      sessions.delete(key);
      void detach(session);
    }
  };
}

/** Bring a session in line with its browser: follow the page, report the state. Serialized per session. */
async function sync(s: Session): Promise<void> {
  if (s.syncing) { s.again = true; return; }
  s.syncing = (async () => {
    do {
      s.again = false;
      if (sessions.get(s.key) !== s) { await detach(s); return; }
      const live = peekBrowser(s.chatId, s.bucket);
      if (live.page !== s.page) {
        await detach(s);
        if (live.page && live.context && sessions.get(s.key) === s) await attach(s, live.page, live.context);
      }
      await sendState(s, live);
    } while (s.again);
  })().finally(() => { s.syncing = null; });
  return s.syncing;
}

async function attach(s: Session, page: any, context: any): Promise<void> {
  s.page = page;
  const onNav = (frame: any) => { if (frame === page.mainFrame()) void sync(s); };
  const onLoad = () => void sync(s);
  page.on('framenavigated', onNav);
  page.on('load', onLoad);
  s.off.push(() => { page.off('framenavigated', onNav); page.off('load', onLoad); });
  try {
    const cdp = await context.newCDPSession(page);
    if (sessions.get(s.key) !== s || s.page !== page) { await cdp.detach().catch(() => undefined); return; }
    s.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: any) => onFrame(s, cdp, f));
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1600, everyNthFrame: 1 });
  } catch {
    // the page closed while attaching; the next change notification re-syncs
    s.cdp = null;
  }
}

function onFrame(s: Session, cdp: any, f: any): void {
  const frame: BrowserLiveFrame = {
    data: f.data,
    width: Math.round(f.metadata?.deviceWidth ?? 0),
    height: Math.round(f.metadata?.deviceHeight ?? 0),
  };
  s.lastFrame = frame;
  for (const v of s.viewers) if (!v.congested) v.send('frame', frame);
  // pace the screencast: Chrome sends the next frame only after this ack
  const wait = Math.max(0, MIN_FRAME_MS - (Date.now() - s.lastAckAt));
  setTimeout(() => {
    s.lastAckAt = Date.now();
    if (s.cdp === cdp) cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  }, wait);
}

async function detach(s: Session): Promise<void> {
  for (const off of s.off.splice(0)) { try { off(); } catch { /* page gone */ } }
  const cdp = s.cdp;
  s.cdp = null;
  s.page = null;
  s.lastFrame = null;
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

async function sendState(s: Session, live: ReturnType<typeof peekBrowser>): Promise<void> {
  let url = '';
  let title = '';
  if (live.page) {
    try { url = live.page.url(); } catch { /* closing */ }
    title = await live.page.title().catch(() => '');
  }
  const state: BrowserLiveState = {
    running: !!live.page, busy: live.busy, url, title,
    viewport: live.viewport ?? null,
  };
  const sig = JSON.stringify(state);
  if (sig === s.stateSig) return;
  s.stateSig = sig;
  for (const v of s.viewers) v.send('state', state);
}

// ---------------------------------------------------------------- routes

function bucketOf(role: unknown): RoleBucket | null {
  return role === 'builder' || role === 'reviewer' ? role : null;
}

const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Space', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

function coord(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BrowserUserError(400, 'Invalid position.');
  return Math.min(Math.max(n, 0), 10_000);
}

/** a URL the user typed: a bare host gets https://; only http(s) is allowed */
function userUrl(raw: unknown): string {
  let url = String(raw ?? '').trim();
  if (!url) throw new BrowserUserError(400, 'Enter an address.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new BrowserUserError(400, 'That is not a valid address.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BrowserUserError(400, 'Only http and https addresses can be opened here.');
  return parsed.toString();
}

async function settle(page: any): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
}

export function registerBrowserLiveRoutes(app: FastifyInstance): void {
  app.get('/api/chats/:id/browser/live', (req: FastifyRequest, reply: FastifyReply) => {
    const chatId = (req.params as { id: string }).id;
    const bucket = bucketOf((req.query as { role?: string }).role);
    if (!bucket) { void reply.code(400).send({ error: 'role must be builder or reviewer' }); return; }
    if (!getChat(chatId)) { void reply.code(404).send({ error: 'Chat not found' }); return; }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');
    const viewer: Viewer = {
      congested: false,
      send(event, data) {
        if (res.destroyed || res.writableEnded) return;
        const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (!ok) viewer.congested = true;
      },
    };
    res.on('drain', () => {
      viewer.congested = false;
      const s = sessions.get(`${chatId}::${bucket}`);
      if (s?.lastFrame) viewer.send('frame', s.lastFrame); // catch up to now, not to what was skipped
    });
    const unsubscribe = subscribe(chatId, bucket, viewer);
    const heartbeat = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
    req.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.post('/api/chats/:id/browser/input', async (req, reply) => {
    const chatId = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const bucket = bucketOf(b.role);
    if (!bucket) return reply.code(400).send({ error: 'role must be builder or reviewer' });
    if (!getChat(chatId)) return reply.code(404).send({ error: 'Chat not found' });
    try {
      switch (b.action) {
        case 'start':
          await userBrowserAction(chatId, bucket, 'opened the browser', async () => undefined, { start: true });
          break;
        case 'click': {
          const x = coord(b.x); const y = coord(b.y);
          await userBrowserAction(chatId, bucket, `clicked at (${Math.round(x)}, ${Math.round(y)})`, async (p) => {
            await p.mouse.click(x, y);
            await settle(p);
          });
          break;
        }
        case 'wheel': {
          const x = coord(b.x); const y = coord(b.y);
          const dx = Math.max(-5000, Math.min(5000, Number(b.dx) || 0));
          const dy = Math.max(-5000, Math.min(5000, Number(b.dy) || 0));
          await userBrowserAction(chatId, bucket, 'scrolled the page', async (p) => {
            await p.mouse.move(x, y);
            await p.mouse.wheel(dx, dy);
          });
          break;
        }
        case 'key': {
          const key = String(b.key ?? '');
          const printable = [...key].length === 1;
          if (!printable && !NAMED_KEYS.has(key)) return reply.code(400).send({ error: 'That key is not supported.' });
          // what was typed is never repeated to the agent: it may be a password
          await userBrowserAction(chatId, bucket, printable ? 'typed a character' : `pressed ${key}`, async (p) => {
            if (printable) await p.keyboard.type(key);
            else await p.keyboard.press(key === 'Space' ? ' ' : key);
            if (key === 'Enter') await settle(p);
          });
          break;
        }
        case 'text': {
          const text = String(b.text ?? '');
          if (!text || text.length > 5_000) return reply.code(400).send({ error: 'Type between 1 and 5000 characters.' });
          await userBrowserAction(chatId, bucket, `typed ${text.length} character${text.length === 1 ? '' : 's'}`, async (p) => {
            await p.keyboard.type(text);
          });
          break;
        }
        case 'navigate': {
          const url = userUrl(b.url);
          await userBrowserAction(chatId, bucket, `opened ${url}`, async (p) => {
            await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 18_000 });
          }, { start: true });
          break;
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const action = b.action;
          await userBrowserAction(chatId, bucket, action === 'reload' ? 'reloaded the page' : `went ${action}`, async (p) => {
            if (action === 'back') await p.goBack({ timeout: 15_000 });
            else if (action === 'forward') await p.goForward({ timeout: 15_000 });
            else await p.reload({ timeout: 18_000, waitUntil: 'domcontentloaded' });
          });
          break;
        }
        default:
          return reply.code(400).send({ error: 'Unknown action.' });
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof BrowserUserError) return reply.code(err.status).send({ error: err.message });
      return reply.code(502).send({ error: String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300) });
    }
  });
}
