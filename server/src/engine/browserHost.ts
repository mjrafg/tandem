import fs from 'node:fs';
import path from 'node:path';
import { config, shotsDir } from '../config';

/**
 * The Tandem browser host: the SERVER owns every internal browser, keyed by
 * canonical identity — chat + role bucket — so browser continuity belongs to
 * the Tandem session, never to an individual AI CLI invocation.
 *
 *   same chat + same role      → one live Chromium context across invocations
 *   different chat             → separate instance, nothing shared
 *   same chat, Builder vs
 *   Reviewer                   → separate instances (review independence)
 *
 * The per-invocation mcp-browser.cjs is a thin stdio→HTTP proxy into this
 * module. Live state (open page, scroll, SPA state, sessionStorage) survives
 * as long as the instance lives; durable state (cookies/localStorage via
 * Playwright storageState, plus the last URL/scroll) is checkpointed under
 * DATA_DIR/browser/ and restored when an instance is lazily recreated — after
 * a kill, an idle reap, a crash, or a Tandem restart. What cannot survive a
 * dead process (JS heap, modals, sessionStorage) is honestly reported as reset.
 */

export type RoleBucket = 'builder' | 'reviewer';

interface BrowserInstance {
  key: string;
  chatId: string;
  bucket: RoleBucket;
  browser: any | null;
  context: any | null;
  page: any | null;
  dsr: number;
  viewport: { width: number; height: number };
  shotSeq: number;
  consoleBuf: { level: string; text: string; at: number }[];
  ariaRefWorks: boolean;
  /** pending one-shot notes appended to the next tool reply */
  notes: string[];
  lastUsed: number;
  lastSaved: number;
  /** once torn down, this object must never relaunch — a queued call gets a clean error */
  disposed: boolean;
  /** serializes tool calls on this instance — two callers can never interleave */
  chain: Promise<unknown>;
  /** an agent tool call is running right now (the live view shows it) */
  busy: boolean;
  /** what the user did from the live view since the agent's last call, told to the agent once */
  userLog: string[];
}

export interface BrowserToolResult {
  content?: { type: string; data?: string; mimeType?: string; text?: string }[];
  text?: string;
  isError?: boolean;
  report?: Record<string, unknown> | null;
}

// neutral: whether anything is actually restored is stated by ensurePage's
// restore branch, which alone knows if a durable checkpoint existed
const CRASH_NOTE = ' (note: the browser had crashed and was restarted; live page state was reset)';
const IDLE_MS = 30 * 60_000;         // release live Chromium after 30 idle minutes
const CHECKPOINT_MS = 60_000;        // durable checkpoint at most once a minute per instance
const REAPER_TICK_MS = 5 * 60_000;
const CALL_WATCHDOG_MS = 100_000;    // a wedged handler is force-recovered before the proxy's 120s timeout

const instances = new Map<string, BrowserInstance>();

const stateDir = path.join(config.dataDir, 'browser');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

function roleBucket(role: string): RoleBucket {
  // final_repair continues the Builder's work — same browser; everything
  // that is not the independent Reviewer belongs to the builder bucket
  return role === 'reviewer' ? 'reviewer' : 'builder';
}

function keyFor(chatId: string, bucket: RoleBucket): string {
  return `${chatId}::${bucket}`;
}

/** filenames derive ONLY from sanitized ids — no path traversal, ever */
function stateFile(chatId: string, bucket: RoleBucket): string {
  const safe = String(chatId).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 64);
  return path.join(stateDir, `${safe}--${bucket}.json`);
}

function getInstance(chatId: string, role: string): BrowserInstance {
  const bucket = roleBucket(role);
  const key = keyFor(chatId, bucket);
  let inst = instances.get(key);
  if (!inst || inst.disposed) {
    inst = {
      key, chatId, bucket,
      browser: null, context: null, page: null,
      dsr: 1, viewport: { width: 1280, height: 800 },
      shotSeq: 0, consoleBuf: [], ariaRefWorks: true,
      notes: [], lastUsed: Date.now(), lastSaved: 0, disposed: false,
      chain: Promise.resolve(), busy: false, userLog: [],
    };
    instances.set(key, inst);
  }
  return inst;
}

// ---------------------------------------------------------------- live view hooks
//
// The live view (./browserLive.ts) watches an instance without owning it: it
// is told when the active page may have changed, when an agent call starts or
// ends, and when the browser goes away, and it re-reads the state itself.

const changeListeners = new Set<(key: string) => void>();

export function onBrowserChange(fn: (key: string) => void): () => void {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

function changed(inst: BrowserInstance): void {
  for (const fn of changeListeners) {
    try { fn(inst.key); } catch { /* a viewer must never break the browser */ }
  }
}

// ---------------------------------------------------------------- durable state

interface DurableState {
  storageState?: unknown;
  url?: string;
  scrollX?: number;
  scrollY?: number;
  tabs?: string[];
  viewport?: { width: number; height: number };
  dsr?: number;
  savedAt: number;
}

function readDurable(inst: BrowserInstance): DurableState | null {
  try {
    const raw = fs.readFileSync(stateFile(inst.chatId, inst.bucket), 'utf8');
    return JSON.parse(raw) as DurableState;
  } catch {
    return null;
  }
}

/** checkpoint cookies/localStorage + navigation facts; never blocks callers */
async function saveDurable(inst: BrowserInstance): Promise<void> {
  if (!inst.context || inst.disposed) return;
  try {
    const storageState = await inst.context.storageState();
    let url: string | undefined;
    let scrollX = 0;
    let scrollY = 0;
    let tabs: string[] = [];
    try {
      tabs = (inst.context.pages() as any[]).map((p) => p.url()).filter((u: string) => u && u !== 'about:blank');
      if (inst.page && !inst.page.isClosed()) {
        url = inst.page.url();
        const pos = await inst.page.evaluate('({ x: window.scrollX, y: window.scrollY })').catch(() => null);
        if (pos) { scrollX = pos.x; scrollY = pos.y; }
      }
    } catch { /* navigation facts are best-effort */ }
    // re-check after the awaits above: if the instance was disposed meanwhile
    // (chat deleted → durable file rm'd), this write must NOT resurrect it
    if (inst.disposed) return;
    const durable: DurableState = {
      storageState, url, scrollX, scrollY, tabs,
      viewport: inst.viewport, dsr: inst.dsr, savedAt: Date.now(),
    };
    fs.writeFileSync(stateFile(inst.chatId, inst.bucket), JSON.stringify(durable), { mode: 0o600 });
    inst.lastSaved = Date.now();
  } catch { /* a dying context loses its last delta — recovery stays best-effort */ }
}

// ---------------------------------------------------------------- lifecycle

function dropLive(inst: BrowserInstance): void {
  inst.browser = null;
  inst.context = null;
  inst.page = null;
  inst.ariaRefWorks = true;
  changed(inst);
}

async function closeLive(inst: BrowserInstance): Promise<void> {
  const b = inst.browser;
  dropLive(inst);
  try { if (b) await b.close(); } catch { /* already gone */ }
}

/** tear an instance down for good: no queued or future call may relaunch it */
async function disposeInstance(inst: BrowserInstance): Promise<void> {
  inst.disposed = true;
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  await closeLive(inst);
  changed(inst);
}

async function launch(inst: BrowserInstance): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    // Tandem owns process lifecycle: Playwright must NOT install its own signal
    // handlers, or a SIGTERM/SIGINT would kill Chromium and exit before the
    // graceful checkpoint in index.ts runs
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  inst.browser = browser;
  browser.on('disconnected', () => {
    // only react if THIS browser is still the instance's current one — a stale
    // listener from a replaced browser must never null out the live replacement
    if (inst.browser === browser) {
      dropLive(inst);
      inst.notes.push(CRASH_NOTE);
    }
  });
}

function wirePage(inst: BrowserInstance, p: any): void {
  inst.page = p; // popups/new tabs become the active page
  changed(inst);
  p.on('console', (msg: any) => pushConsole(inst, msg.type(), msg.text()));
  p.on('pageerror', (err: unknown) => pushConsole(inst, 'error', String(err)));
  p.on('requestfailed', (req: any) => {
    const failure = req.failure();
    if (failure && failure.errorText !== 'net::ERR_ABORTED') {
      pushConsole(inst, 'network', `${req.method()} ${req.url()} — ${failure.errorText}`);
    }
  });
}

function pushConsole(inst: BrowserInstance, level: string, text: string): void {
  inst.consoleBuf.push({ level, text: String(text).slice(0, 500), at: Date.now() });
  if (inst.consoleBuf.length > 200) inst.consoleBuf.shift();
}

/** live page, creating browser+context lazily and restoring durable state */
async function ensurePage(inst: BrowserInstance): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (inst.disposed) throw new Error('This browser was released; a fresh one starts on the next tool call.');
      if (inst.browser && !inst.browser.isConnected()) {
        dropLive(inst);
        inst.notes.push(CRASH_NOTE);
      }
      if (inst.page && !inst.page.isClosed()) return inst.page;
      if (inst.context) {
        // active page closed but the context lives — adopt another open page
        const open = (inst.context.pages() as any[]).filter((p) => !p.isClosed());
        if (open.length > 0) { inst.page = open[open.length - 1]; return inst.page; }
      }
      if (!inst.browser) await launch(inst);
      if (!inst.context) {
        const durable = readDurable(inst);
        if (durable?.viewport) inst.viewport = durable.viewport;
        if (durable?.dsr) inst.dsr = durable.dsr;
        inst.context = await inst.browser.newContext({
          viewport: inst.viewport,
          deviceScaleFactor: inst.dsr,
          ...(durable?.storageState ? { storageState: durable.storageState } : {}),
        });
        inst.context.on('page', (p: any) => wirePage(inst, p));
        inst.page = await inst.context.newPage();
        if (durable?.url) {
          // best-effort recovery: reopen where the agent was, restore scroll.
          // Live-only state (JS heap, modals, sessionStorage) does not return.
          try {
            await inst.page.goto(durable.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            if (durable.scrollX || durable.scrollY) {
              await inst.page.evaluate(`window.scrollTo(${durable.scrollX || 0}, ${durable.scrollY || 0})`).catch(() => undefined);
            }
            inst.notes.push(` (note: this browser was restored from saved state — cookies/localStorage recovered and ${durable.url} reopened; live in-page state such as sessionStorage, form contents, and open dialogs was reset)`);
          } catch {
            inst.notes.push(' (note: this browser was restored from saved state — cookies/localStorage recovered, but the previous page could not be reopened)');
          }
        } else if (durable?.storageState) {
          inst.notes.push(' (note: this browser was restored from saved state — cookies/localStorage recovered; there was no previous page to reopen)');
        }
        return inst.page;
      }
      inst.page = await inst.context.newPage();
      return inst.page;
    } catch (err) {
      if (inst.disposed) throw err;
      // a partially-launched browser (launch OK, context/page failed) must be
      // CLOSED, not merely forgotten, or its Chromium process is orphaned
      await closeLive(inst);
      if (attempt >= 1) throw err;
      inst.notes.push(CRASH_NOTE);
    }
  }
}

function takeNotes(inst: BrowserInstance): string {
  const notes = inst.notes.splice(0).join('');
  return notes;
}

/** what the user did in this browser since the agent last used it, said once */
function takeUserNote(inst: BrowserInstance): string {
  const acts = inst.userLog.splice(0);
  if (acts.length === 0) return '';
  return ` (note: since your last browser call, the user acted in this browser from Tandem's live view: ${acts.join('; ')}. The page may have changed — take a fresh snapshot before relying on earlier refs.)`;
}

// ---------------------------------------------------------------- snapshot

function cap(s: unknown, max: number): string {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max)}\n… [truncated — ${str.length - max} more chars]` : str;
}

async function snapshotText(inst: BrowserInstance): Promise<string> {
  try {
    if (inst.ariaRefWorks && typeof inst.page._snapshotForAI === 'function') {
      const snap = await inst.page._snapshotForAI();
      const text = typeof snap === 'string' ? snap : String(snap);
      if (text.trim()) return cap(text, 12_000);
    }
  } catch { inst.ariaRefWorks = false; }
  return cap(await customSnapshot(inst), 12_000);
}

// the in-page half of the fallback snapshot runs in the BROWSER — shipped as
// a source string so the server build needs no DOM typings
const CUSTOM_SNAPSHOT_JS = `(() => {
  let n = 0;
  const lines = [];
  const seen = new Set();
  const label = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ');
    return t.slice(0, 80);
  };
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    n += 1;
    const ref = 't' + n;
    el.setAttribute('data-tandem-ref', ref);
    lines.push('- ' + kind + ' "' + label(el) + '" [ref=' + ref + ']');
  };
  document.querySelectorAll('button, [role=button], input[type=submit]').forEach((el) => push(el, 'button'));
  document.querySelectorAll('a[href]').forEach((el) => push(el, 'link'));
  document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea').forEach((el) => push(el, 'input(' + (el.type || 'text') + ')'));
  document.querySelectorAll('select').forEach((el) => push(el, 'select'));
  document.querySelectorAll('[role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], summary').forEach((el) => push(el, el.getAttribute('role') || 'control'));
  const bodyText = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 4000);
  return 'Interactive elements:\\n' + (lines.slice(0, 150).join('\\n') || '(none found)') + '\\n\\nVisible text:\\n' + bodyText;
})()`;

async function customSnapshot(inst: BrowserInstance): Promise<string> {
  return inst.page.evaluate(CUSTOM_SNAPSHOT_JS);
}

function locFor(inst: BrowserInstance, args: any): any {
  if (args.ref) {
    const ref = String(args.ref).replace(/[^\w-]/g, '');
    if (/^e\d/i.test(ref) && inst.ariaRefWorks) return inst.page.locator(`aria-ref=${ref}`);
    return inst.page.locator(`[data-tandem-ref="${ref}"]`);
  }
  if (args.selector) return inst.page.locator(String(args.selector)).first();
  throw new Error('Provide "ref" (from browser_snapshot) or a CSS "selector".');
}

async function pageInfo(inst: BrowserInstance): Promise<{ url?: string; title?: string }> {
  try {
    return { url: inst.page.url(), title: await inst.page.title() };
  } catch {
    return { url: inst.page ? inst.page.url() : undefined, title: undefined };
  }
}

// ---------------------------------------------------------------- tool handlers

type Handler = (inst: BrowserInstance, args: any) => Promise<BrowserToolResult>;

const handlers: Record<string, Handler> = {
  async browser_navigate(inst, args) {
    await ensurePage(inst);
    const url = String(args.url || '').trim();
    let action = 'navigate';
    if (url === 'back') { await inst.page.goBack({ timeout: 15_000 }); action = 'back'; }
    else if (url === 'forward') { await inst.page.goForward({ timeout: 15_000 }); action = 'forward'; }
    else if (url === 'reload') { await inst.page.reload({ timeout: 20_000 }); action = 'reload'; }
    else {
      if (!/^(https?|file):\/\//i.test(url)) throw new Error('URL must start with http://, https://, or file://');
      await inst.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    }
    await inst.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    const snap = await snapshotText(inst);
    return {
      report: { action, detail: `${action === 'navigate' ? 'Opened' : action} ${info.url}`, ...info },
      text: `Loaded: ${info.title || '(no title)'} — ${info.url}\n\n${snap}`,
    };
  },

  async browser_snapshot(inst) {
    await ensurePage(inst);
    const info = await pageInfo(inst);
    const snap = await snapshotText(inst);
    return {
      report: { action: 'snapshot', detail: `Inspected page structure (${info.title || info.url})`, ...info },
      text: `${info.title || '(no title)'} — ${info.url}\n\n${snap}`,
    };
  },

  async browser_click(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    if (args.doubleClick) await loc.dblclick({ timeout: 8_000 });
    else await loc.click({ timeout: 8_000 });
    await inst.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    const what = args.element || args.ref || args.selector;
    return {
      report: { action: 'click', detail: `Clicked ${what}`, ref: args.ref || args.selector, ...info },
      text: `Clicked ${what}. Now at: ${info.title || ''} — ${info.url}`,
    };
  },

  async browser_type(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    let sensitive = !!args.sensitive;
    try {
      const type = await loc.evaluate((el: any) => (el.type || '').toLowerCase()).catch(() => '');
      if (type === 'password') sensitive = true;
    } catch { /* non-input */ }
    await loc.fill(String(args.text), { timeout: 8_000 });
    if (args.submit) await loc.press('Enter');
    const info = await pageInfo(inst);
    const what = args.element || args.ref || args.selector;
    const shown = sensitive ? '•••' : cap(String(args.text), 200);
    return {
      report: { action: 'type', detail: `Typed into ${what}${args.submit ? ' and pressed Enter' : ''}`, ref: args.ref || args.selector, value: shown, ...info },
      text: `Filled ${what} with ${sensitive ? '(redacted)' : JSON.stringify(shown)}${args.submit ? ' and submitted' : ''}.`,
    };
  },

  async browser_select(inst, args) {
    await ensurePage(inst);
    const loc = locFor(inst, args);
    const values = (args.values || []).map(String);
    let chosen;
    try { chosen = await loc.selectOption(values.map((v: string) => ({ label: v })), { timeout: 5_000 }); }
    catch { chosen = await loc.selectOption(values, { timeout: 5_000 }); }
    const info = await pageInfo(inst);
    return {
      report: { action: 'select', detail: `Selected ${values.join(', ')}`, ref: args.ref || args.selector, value: values.join(', '), ...info },
      text: `Selected ${JSON.stringify(chosen)}.`,
    };
  },

  async browser_press(inst, args) {
    await ensurePage(inst);
    await inst.page.keyboard.press(String(args.key), { timeout: 5_000 });
    await inst.page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    return { report: { action: 'press', detail: `Pressed ${args.key}`, ...info }, text: `Pressed ${args.key}.` };
  },

  async browser_scroll(inst, args) {
    await ensurePage(inst);
    if (args.ref || args.selector) {
      await locFor(inst, args).scrollIntoViewIfNeeded({ timeout: 5_000 });
      const info = await pageInfo(inst);
      return { report: { action: 'scroll', detail: `Scrolled ${args.ref || args.selector} into view`, ...info }, text: 'Scrolled element into view.' };
    }
    const dy = args.dy ?? 600;
    const dx = args.dx ?? 0;
    await inst.page.mouse.wheel(dx, dy);
    const info = await pageInfo(inst);
    return { report: { action: 'scroll', detail: `Scrolled by ${dx},${dy}`, ...info }, text: `Scrolled by (${dx}, ${dy}).` };
  },

  async browser_wait(inst, args) {
    await ensurePage(inst);
    if (args.text) {
      await inst.page.getByText(String(args.text)).first().waitFor({ state: 'visible', timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: 'wait', detail: `Waited until "${args.text}" appeared`, ...info }, text: `"${args.text}" is visible.` };
    }
    if (args.textGone) {
      await inst.page.getByText(String(args.textGone)).first().waitFor({ state: 'hidden', timeout: 30_000 });
      const info = await pageInfo(inst);
      return { report: { action: 'wait', detail: `Waited until "${args.textGone}" disappeared`, ...info }, text: `"${args.textGone}" is gone.` };
    }
    const s = Math.min(Math.max(Number(args.seconds) || 1, 0.1), 30);
    await new Promise((r) => setTimeout(r, s * 1000));
    const info = await pageInfo(inst);
    return { report: { action: 'wait', detail: `Waited ${s}s`, ...info }, text: `Waited ${s}s.` };
  },

  async browser_screenshot(inst, args) {
    await ensurePage(inst);
    // `scale: 'css'` pins the capture to CSS pixels, so a deviceScaleFactor of
    // 2 or 3 no longer multiplies the image by 4x or 9x. A screenshot is read
    // once by the model but then re-read from cache on EVERY later request in
    // the session, so its size is paid hundreds of times over — a full-page
    // capture, which is unbounded in height, is compressed harder for that
    // reason. Visual verification does not need the extra bytes.
    const buf = await inst.page.screenshot({
      type: 'jpeg',
      quality: args.fullPage ? 55 : 70,
      scale: 'css',
      fullPage: !!args.fullPage,
      timeout: 15_000,
    });
    const info = await pageInfo(inst);
    let file: string | undefined;
    if (shotsDir && inst.chatId) {
      const dir = path.join(shotsDir, inst.chatId);
      fs.mkdirSync(dir, { recursive: true });
      inst.shotSeq += 1;
      file = `${Date.now()}-${inst.shotSeq}.jpg`;
      fs.writeFileSync(path.join(dir, file), buf);
    }
    return {
      report: {
        action: 'screenshot',
        detail: `Screenshot${args.fullPage ? ' (full page)' : ''} at ${inst.viewport.width}×${inst.viewport.height}`,
        screenshotFile: file, ...info,
      },
      content: [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `Screenshot captured (${args.fullPage ? 'full page' : `${inst.viewport.width}×${inst.viewport.height}`}) of ${info.url}` },
      ],
    };
  },

  async browser_resize(inst, args) {
    await ensurePage(inst);
    const width = Math.min(Math.max(Math.round(args.width), 200), 4000);
    const height = Math.min(Math.max(Math.round(args.height), 200), 4000);
    // capped at 2: screenshots are captured at CSS scale anyway, and a higher
    // factor only inflates what every later request re-reads
    const newDsr = args.deviceScaleFactor ? Math.min(Math.max(Number(args.deviceScaleFactor), 1), 2) : inst.dsr;
    inst.viewport = { width, height };
    let note = '';
    if (newDsr !== inst.dsr) {
      inst.dsr = newDsr;
      const current = inst.page.url();
      // recreate the context WITH its storage — a scale change must not log out
      await saveDurable(inst);
      await inst.context.close().catch(() => undefined);
      inst.context = null;
      inst.page = null;
      await ensurePage(inst);
      inst.notes.splice(0); // the restore note would be misleading here
      if (current && current !== 'about:blank') {
        await inst.page.goto(current, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
        note = ` (fresh context at deviceScaleFactor ${inst.dsr}; page reloaded, sign-in preserved)`;
      }
    } else {
      await inst.page.setViewportSize(inst.viewport);
    }
    const info = await pageInfo(inst);
    return {
      report: { action: 'resize', detail: `Viewport → ${width}×${height}${inst.dsr !== 1 ? ` @${inst.dsr}x` : ''}`, viewport: { ...inst.viewport, deviceScaleFactor: inst.dsr }, ...info },
      text: `Viewport is now ${width}×${height}${inst.dsr !== 1 ? ` at ${inst.dsr}x` : ''}${note}. The page is interactive at this size.`,
    };
  },

  async browser_console(inst, args) {
    await ensurePage(inst);
    const level = args.level === 'all' ? 'all' : 'error';
    const entries = inst.consoleBuf.filter((e) => level === 'all' || e.level === 'error' || e.level === 'network' || e.level === 'warning');
    const shown = entries.slice(-40);
    const info = await pageInfo(inst);
    return {
      report: {
        action: 'console',
        detail: `Read console (${shown.length} ${level === 'all' ? 'entries' : 'errors/warnings'})`,
        console: shown.slice(-12).map(({ level: l, text }) => ({ level: l, text: cap(text, 200) })),
        ...info,
      },
      text: shown.length === 0
        ? `No ${level === 'all' ? 'console output' : 'errors or warnings'} recorded on this page.`
        : shown.map((e) => `[${e.level}] ${e.text}`).join('\n'),
    };
  },

  async browser_evaluate(inst, args) {
    await ensurePage(inst);
    const value = await inst.page.evaluate((code: string) => {
      // eslint-disable-next-line no-eval
      const r = eval(code);
      try { return JSON.parse(JSON.stringify(r)); } catch { return String(r); }
    }, String(args.code));
    const info = await pageInfo(inst);
    const text = cap(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 5_000);
    return {
      report: { action: 'evaluate', detail: `Evaluated: ${cap(String(args.code), 90)}`, ...info },
      text,
    };
  },

  // ------------------------------------------------ lifecycle tools

  async browser_reload(inst, args) {
    // reload operates on the CURRENT page — it never lazily creates one
    if (!inst.page || inst.page.isClosed()) {
      throw new Error('No active page to reload — navigate somewhere first (browser_navigate).');
    }
    const hard = !!args.hard;
    if (hard) {
      // cache-bypassing reload: clear the HTTP cache via CDP, keep cookies/storage
      try {
        const cdp = await inst.context.newCDPSession(inst.page);
        await cdp.send('Network.clearBrowserCache');
        await cdp.detach().catch(() => undefined);
      } catch { /* non-chromium or CDP hiccup — the plain reload below still runs */ }
    }
    await inst.page.reload({ timeout: 20_000, waitUntil: 'domcontentloaded' });
    await inst.page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo(inst);
    return {
      report: { action: 'reload', detail: `${hard ? 'Hard-reloaded (cache cleared)' : 'Reloaded'} ${info.url}`, ...info },
      text: `${hard ? 'Hard-reloaded (HTTP cache cleared; cookies and sign-in preserved)' : 'Reloaded'}: ${info.title || '(no title)'} — ${info.url}`,
    };
  },

  async browser_reset(inst) {
    // fresh live context for THIS chat+role only; durable auth survives
    await saveDurable(inst);
    await closeLive(inst);
    await ensurePage(inst);
    const restored = takeNotes(inst);
    const info = await pageInfo(inst);
    return {
      report: { action: 'reset', detail: `Browser reset — fresh context${restored ? ', saved state restored' : ''}`, ...info },
      text: `Browser reset: a fresh context replaced the previous one.${restored || ' No saved state existed, so it starts blank.'} Live-only state (open dialogs, sessionStorage, in-memory page state) is gone by design.`,
    };
  },

  async browser_kill(inst) {
    // release live resources; durable auth/storage is deliberately KEPT.
    // dispose so no queued call for this key relaunches a browser afterward.
    await saveDurable(inst);
    await disposeInstance(inst);
    return {
      report: { action: 'kill', detail: 'Browser closed — saved state kept for the next use' },
      text: 'Browser closed and its resources released. Cookies/localStorage and the last page were saved: the next browser tool call starts a fresh browser and restores them. (This is not a logout — use the site\'s own logout, or clear state via browser_evaluate, if you need that.)',
    };
  },
};

// ---------------------------------------------------------------- entry point

/**
 * Execute one browser tool for chat+role. Calls on the same instance are
 * strictly serialized — overlapping invocations can never interleave CDP
 * operations on one context.
 */
export async function handleBrowserTool(chatId: string, role: string, name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
  const handler = handlers[name];
  if (!handler) return { text: `Unknown tool ${name}`, isError: true, report: null };
  const inst = getInstance(chatId, role);
  const run = inst.chain.then(async (): Promise<BrowserToolResult> => {
    inst.lastUsed = Date.now();
    inst.busy = true;
    changed(inst);
    try {
      // watchdog: a wedged handler must not block this instance's chain (which
      // includes the recovery tools) forever. On timeout the instance is
      // disposed, so the agent's next call gets a fresh, working browser.
      let timer: NodeJS.Timeout | undefined;
      const out = await Promise.race([
        handler(inst, args ?? {}),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('the browser operation timed out and the browser was reset; retry your last step')), CALL_WATCHDOG_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); }) as BrowserToolResult;
      const sysNote = takeNotes(inst);
      if (sysNote && out.report) out.report = { ...out.report, detail: `${out.report.detail}${sysNote.includes('crash') ? ' · browser restarted after a crash' : ' · restored from saved state'}` };
      const note = sysNote + takeUserNote(inst);
      if (out.content) {
        if (note && out.content[0]?.type === 'text') out.content[0] = { type: 'text', text: `${out.content[0].text}${note}` };
        const textPart = out.content.find((c) => c.type === 'text');
        if (note && textPart && out.content[0]?.type !== 'text') textPart.text = `${textPart.text}${note}`;
      } else {
        out.text = `${out.text ?? 'ok'}${note}`;
      }
      // periodic durable checkpoint so a hard crash loses little
      if (!inst.disposed && Date.now() - inst.lastSaved > CHECKPOINT_MS && instances.get(inst.key) === inst) void saveDurable(inst);
      return out;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 400);
      // a watchdog trip means the live context is wedged — dispose it so the
      // next call self-heals rather than queueing behind the stuck operation
      if (/timed out and the browser was reset/.test(message)) { void disposeInstance(inst); }
      let info: Record<string, unknown> = {};
      try { if (!inst.disposed) info = await pageInfo(inst); } catch { /* no page */ }
      return {
        text: `${name} failed: ${message}`,
        isError: true,
        report: { action: name.replace('browser_', ''), detail: `${name.replace('browser_', '')} failed`, error: message, status: 'failed', ...info },
      };
    } finally {
      inst.busy = false;
      changed(inst);
    }
  });
  inst.chain = run.catch(() => undefined); // the chain itself never rejects
  return run;
}

/** What a live viewer may see of an instance: its open page, if any. Never launches anything. */
export function peekBrowser(chatId: string, bucket: RoleBucket): {
  page: any | null; context: any | null; busy: boolean; viewport: { width: number; height: number } | null;
} {
  const inst = instances.get(keyFor(chatId, bucket));
  if (!inst || inst.disposed || !inst.context || !inst.page || inst.page.isClosed()) {
    return { page: null, context: null, busy: !!inst?.busy, viewport: inst?.viewport ?? null };
  }
  return { page: inst.page, context: inst.context, busy: inst.busy, viewport: inst.viewport };
}

export class BrowserUserError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const USER_ACTION_MS = 20_000;

/**
 * Run something the USER did from the live view, in turn with the agent's calls
 * on the same queue, so a click can never land in the middle of an agent's
 * action. `start` may open the browser (restoring its saved state); anything
 * else needs one already open. The action is described to the agent on its
 * next call, so it never works from a page it thinks it still knows.
 */
export async function userBrowserAction(
  chatId: string, bucket: RoleBucket, describe: string, fn: (page: any) => Promise<void>, opts: { start?: boolean } = {},
): Promise<void> {
  const key = keyFor(chatId, bucket);
  const existing = instances.get(key);
  if (!opts.start && (!existing || existing.disposed)) throw new BrowserUserError(409, 'No browser is open. Open one first.');
  const inst = existing && !existing.disposed ? existing : getInstance(chatId, bucket);
  const run = inst.chain.then(async () => {
    if (inst.disposed) throw new BrowserUserError(409, 'This browser was just closed.');
    if (!opts.start && (!inst.page || inst.page.isClosed())) throw new BrowserUserError(409, 'No browser is open. Open one first.');
    inst.lastUsed = Date.now();
    const page = await ensurePage(inst);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      fn(page),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new BrowserUserError(504, 'The page did not respond in time.')), USER_ACTION_MS); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    inst.userLog.push(describe);
    if (inst.userLog.length > 12) inst.userLog.splice(0, inst.userLog.length - 12);
    if (!inst.disposed && Date.now() - inst.lastSaved > CHECKPOINT_MS) void saveDurable(inst);
  });
  inst.chain = run.catch(() => undefined);
  try {
    await run;
  } finally {
    changed(inst);
  }
}

/** Release a chat's live browsers (both roles). Durable state optionally erased — chat deletion must leave no cookies behind. */
export async function releaseBrowsers(chatId: string, opts: { deleteDurable: boolean }): Promise<void> {
  for (const bucket of ['builder', 'reviewer'] as RoleBucket[]) {
    const inst = instances.get(keyFor(chatId, bucket));
    if (inst) {
      if (!opts.deleteDurable) await saveDurable(inst);
      await disposeInstance(inst); // disposed → a mid-flight/queued call can't resurrect it
    }
    if (opts.deleteDurable) {
      // dispose (above) has set inst.disposed, so no checkpoint can rewrite the
      // file after this rm — the deletion is the last word
      try { fs.rmSync(stateFile(chatId, bucket), { force: true }); } catch { /* best effort */ }
    }
  }
}

/** graceful shutdown: checkpoint every instance, close every Chromium */
export async function shutdownBrowsers(): Promise<void> {
  const all = [...instances.values()];
  instances.clear();
  await Promise.allSettled(all.map(async (inst) => {
    inst.disposed = true;
    await saveDurable(inst);
    await closeLive(inst);
  }));
}

/** idle reaper: live Chromium is released after IDLE_MS; durable state stays */
let reaper: NodeJS.Timeout | null = null;
export function startBrowserReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const inst of instances.values()) {
      // idle means no call in the last 30 min, so nothing is in flight
      if (now - inst.lastUsed > IDLE_MS) {
        void (async () => {
          await saveDurable(inst);
          await disposeInstance(inst);
        })();
      }
    }
  }, REAPER_TICK_MS);
  reaper.unref?.();
}

/** test/observability hook: which instances are live right now */
export function liveBrowserKeys(): string[] {
  return [...instances.keys()];
}
