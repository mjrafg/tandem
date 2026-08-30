#!/usr/bin/env node
/**
 * Tandem's internal browser: an MCP stdio server backed by headless Chromium
 * (Playwright). It is a plain tool — the AI decides if/when/how to use it.
 *
 * Every action self-reports to the Tandem app (localhost, token-authenticated)
 * so Builder and Reviewer browser activity lands in the chat timeline
 * identically. Screenshots are returned to the model as images AND saved for
 * the user. The browser launches lazily on first use and dies with this
 * process (stdin close / SIGTERM), which ties it to Tandem's Stop behavior.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const INTERNAL_BASE = process.env.TANDEM_INTERNAL_URL || '';
const CHAT_ID = process.env.TANDEM_CHAT_ID || '';
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN || '';
const SHOTS_DIR = process.env.TANDEM_SHOTS_DIR || '';
const ROLE = process.env.TANDEM_BROWSER_ROLE || '';

// ---------------------------------------------------------------- state

let browser = null;
let context = null;
let page = null;
let dsr = 1;
let viewport = { width: 1280, height: 800 };
let shotSeq = 0;
const consoleBuf = [];
let ariaRefWorks = true;

/** set when a crashed browser had to be relaunched, so the AI is told state was lost */
const CRASH_NOTE = ' (note: the browser had crashed and was restarted — page state, cookies and history were reset)';
let recoveredNote = '';

function dropBrowserState() {
  browser = null;
  context = null;
  page = null;
  ariaRefWorks = true;
}

async function launchBrowser() {
  const { chromium } = require('playwright');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  // Chromium can die on its own (renderer crash, heavy pages, external kill).
  // Forget the dead handle immediately — otherwise every later call fails with
  // "Target page, context or browser has been closed" for the rest of the run.
  browser.on('disconnected', () => {
    dropBrowserState();
    recoveredNote = CRASH_NOTE;
  });
}

async function ensurePage() {
  for (let attempt = 0; ; attempt++) {
    try {
      if (browser && !browser.isConnected()) {
        // whichever notices first — this check or the disconnected event — the
        // relaunch must be reported, so set the note here too
        dropBrowserState();
        recoveredNote = CRASH_NOTE;
      }
      if (page && !page.isClosed()) return page;
      if (!browser) await launchBrowser();
      context = await browser.newContext({ viewport, deviceScaleFactor: dsr });
      context.on('page', (p) => wirePage(p));
      page = await context.newPage();
      return page;
    } catch (err) {
      // a browser that died between the check and the call lands here
      dropBrowserState();
      if (attempt >= 1) throw err;
      recoveredNote = CRASH_NOTE;
    }
  }
}

/** consume the pending recovery note, if any */
function takeRecoveredNote() {
  const note = recoveredNote;
  recoveredNote = '';
  return note;
}

function wirePage(p) {
  page = p; // popups/new tabs become the active page
  p.on('console', (msg) => pushConsole(msg.type(), msg.text()));
  p.on('pageerror', (err) => pushConsole('error', String(err)));
  p.on('requestfailed', (req) => {
    const failure = req.failure();
    if (failure && failure.errorText !== 'net::ERR_ABORTED') {
      pushConsole('network', `${req.method()} ${req.url()} — ${failure.errorText}`);
    }
  });
}

function pushConsole(level, text) {
  consoleBuf.push({ level, text: String(text).slice(0, 500), at: Date.now() });
  if (consoleBuf.length > 200) consoleBuf.shift();
}

async function pageInfo() {
  try {
    return { url: page.url(), title: await page.title() };
  } catch {
    return { url: page ? page.url() : undefined, title: undefined };
  }
}

// ---------------------------------------------------------------- reporting

function report(payload) {
  if (!INTERNAL_BASE || !TOKEN) return;
  fetch(`${INTERNAL_BASE}/browser-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, chatId: CHAT_ID, role: ROLE, ...payload }),
  }).catch(() => undefined);
}

// ---------------------------------------------------------------- snapshot

async function snapshotText() {
  // Playwright's AI snapshot (aria tree with [ref=eNN] markers) when available
  try {
    if (ariaRefWorks && typeof page._snapshotForAI === 'function') {
      const snap = await page._snapshotForAI();
      const text = typeof snap === 'string' ? snap : String(snap);
      if (text.trim()) return cap(text, 12_000);
    }
  } catch { ariaRefWorks = false; }
  return cap(await customSnapshot(), 12_000);
}

async function customSnapshot() {
  return page.evaluate(() => {
    let n = 0;
    const lines = [];
    const seen = new Set();
    const label = (el) => {
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
      return t.slice(0, 80);
    };
    const push = (el, kind) => {
      if (seen.has(el)) return;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      n += 1;
      const ref = `t${n}`;
      el.setAttribute('data-tandem-ref', ref);
      lines.push(`- ${kind} "${label(el)}" [ref=${ref}]`);
    };
    document.querySelectorAll('button, [role=button], input[type=submit]').forEach((el) => push(el, 'button'));
    document.querySelectorAll('a[href]').forEach((el) => push(el, 'link'));
    document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea').forEach((el) => push(el, `input(${el.type || 'text'})`));
    document.querySelectorAll('select').forEach((el) => push(el, 'select'));
    document.querySelectorAll('[role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], summary').forEach((el) => push(el, el.getAttribute('role') || 'control'));
    const bodyText = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
    return `Interactive elements:\n${lines.slice(0, 150).join('\n') || '(none found)'}\n\nVisible text:\n${bodyText}`;
  });
}

function locFor(args) {
  if (args.ref) {
    const ref = String(args.ref).replace(/[^\w-]/g, '');
    if (/^e\d/i.test(ref) && ariaRefWorks) return page.locator(`aria-ref=${ref}`);
    return page.locator(`[data-tandem-ref="${ref}"]`);
  }
  if (args.selector) return page.locator(String(args.selector)).first();
  throw new Error('Provide "ref" (from browser_snapshot) or a CSS "selector".');
}

function cap(s, max) {
  s = String(s ?? '');
  return s.length > max ? `${s.slice(0, max)}\n… [truncated — ${s.length - max} more chars]` : s;
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in Tandem\'s internal Chromium browser (real rendering; localhost and file:// URLs work). Also accepts "back", "forward", or "reload". Returns the page title, URL, and an element snapshot with [ref=…] ids for interaction.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open, or back|forward|reload' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    description: 'Get the current page\'s structure: interactive elements with [ref=…] ids plus visible text. Refs are valid until the page changes or the next snapshot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element, identified by ref (from the latest snapshot) or CSS selector.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, element: { type: 'string', description: 'short human description for the activity log' }, doubleClick: { type: 'boolean' } } },
  },
  {
    name: 'browser_type',
    description: 'Fill an input/textarea (clears it first), identified by ref or CSS selector. Set submit=true to press Enter afterwards. Set sensitive=true for secrets so the value is redacted in the activity log.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, sensitive: { type: 'boolean' }, element: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'browser_select',
    description: 'Choose option(s) in a <select>, by visible label or value.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['values'] },
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key on the page (e.g. Enter, Escape, Tab, ArrowDown, Control+a).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page by dx/dy pixels (default dy=600), or scroll a specific element (ref/selector) into view.',
    inputSchema: { type: 'object', properties: { dy: { type: 'number' }, dx: { type: 'number' }, ref: { type: 'string' }, selector: { type: 'string' } } },
  },
  {
    name: 'browser_wait',
    description: 'Wait for seconds (max 30), or until text appears/disappears on the page.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' }, text: { type: 'string' }, textGone: { type: 'string' } } },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current page. You receive the image for visual inspection, and it is stored in the chat timeline for the user. fullPage captures beyond the viewport.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
  },
  {
    name: 'browser_resize',
    description: 'Set the viewport to any width×height (and optionally deviceScaleFactor). Use for responsive checks at whatever sizes you judge useful. Changing deviceScaleFactor reloads the page in a fresh context.',
    inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, deviceScaleFactor: { type: 'number' } }, required: ['width', 'height'] },
  },
  {
    name: 'browser_console',
    description: 'Read recent browser console output, page errors, and failed network requests. level="error" (default) filters to errors; level="all" includes logs/warnings.',
    inputSchema: { type: 'object', properties: { level: { type: 'string', enum: ['error', 'all'] } } },
  },
  {
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the page and get its JSON result — for inspecting application state exposed through the rendered page.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
];

// Admin-edited AI-facing text (descriptions only; names/types/required/enums
// and behavior are code). Served from the next invocation on — one source of
// truth with Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem_browser.${tool.name}`];
    if (!ov) continue;
    if (typeof ov.description === 'string' && ov.description.trim()) tool.description = ov.description;
    if (ov.params && tool.inputSchema && tool.inputSchema.properties) {
      for (const [param, desc] of Object.entries(ov.params)) {
        if (tool.inputSchema.properties[param] && typeof desc === 'string' && desc.trim()) {
          tool.inputSchema.properties[param].description = desc;
        }
      }
    }
  }
} catch { /* factory text stands */ }

const handlers = {
  async browser_navigate(args) {
    await ensurePage();
    const url = String(args.url || '').trim();
    let action = 'navigate';
    if (url === 'back') { await page.goBack({ timeout: 15_000 }); action = 'back'; }
    else if (url === 'forward') { await page.goForward({ timeout: 15_000 }); action = 'forward'; }
    else if (url === 'reload') { await page.reload({ timeout: 20_000 }); action = 'reload'; }
    else {
      if (!/^(https?|file):\/\//i.test(url)) throw new Error('URL must start with http://, https://, or file://');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo();
    const snap = await snapshotText();
    return {
      report: { action, detail: `${action === 'navigate' ? 'Opened' : action} ${info.url}`, ...info },
      text: `Loaded: ${info.title || '(no title)'} — ${info.url}\n\n${snap}`,
    };
  },

  async browser_snapshot() {
    await ensurePage();
    const info = await pageInfo();
    const snap = await snapshotText();
    return {
      report: { action: 'snapshot', detail: `Inspected page structure (${info.title || info.url})`, ...info },
      text: `${info.title || '(no title)'} — ${info.url}\n\n${snap}`,
    };
  },

  async browser_click(args) {
    await ensurePage();
    const loc = locFor(args);
    if (args.doubleClick) await loc.dblclick({ timeout: 8_000 });
    else await loc.click({ timeout: 8_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    const info = await pageInfo();
    const what = args.element || args.ref || args.selector;
    return {
      report: { action: 'click', detail: `Clicked ${what}`, ref: args.ref || args.selector, ...info },
      text: `Clicked ${what}. Now at: ${info.title || ''} — ${info.url}`,
    };
  },

  async browser_type(args) {
    await ensurePage();
    const loc = locFor(args);
    let sensitive = !!args.sensitive;
    try {
      const type = await loc.evaluate((el) => (el.type || '').toLowerCase()).catch(() => '');
      if (type === 'password') sensitive = true;
    } catch { /* non-input */ }
    await loc.fill(String(args.text), { timeout: 8_000 });
    if (args.submit) await loc.press('Enter');
    const info = await pageInfo();
    const what = args.element || args.ref || args.selector;
    const shown = sensitive ? '•••' : cap(String(args.text), 200);
    return {
      report: { action: 'type', detail: `Typed into ${what}${args.submit ? ' and pressed Enter' : ''}`, ref: args.ref || args.selector, value: shown, ...info },
      text: `Filled ${what} with ${sensitive ? '(redacted)' : JSON.stringify(shown)}${args.submit ? ' and submitted' : ''}.`,
    };
  },

  async browser_select(args) {
    await ensurePage();
    const loc = locFor(args);
    const values = (args.values || []).map(String);
    let chosen;
    try { chosen = await loc.selectOption(values.map((v) => ({ label: v })), { timeout: 5_000 }); }
    catch { chosen = await loc.selectOption(values, { timeout: 5_000 }); }
    const info = await pageInfo();
    return {
      report: { action: 'select', detail: `Selected ${values.join(', ')}`, ref: args.ref || args.selector, value: values.join(', '), ...info },
      text: `Selected ${JSON.stringify(chosen)}.`,
    };
  },

  async browser_press(args) {
    await ensurePage();
    await page.keyboard.press(String(args.key), { timeout: 5_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined);
    const info = await pageInfo();
    return { report: { action: 'press', detail: `Pressed ${args.key}`, ...info }, text: `Pressed ${args.key}.` };
  },

  async browser_scroll(args) {
    await ensurePage();
    if (args.ref || args.selector) {
      await locFor(args).scrollIntoViewIfNeeded({ timeout: 5_000 });
      const info = await pageInfo();
      return { report: { action: 'scroll', detail: `Scrolled ${args.ref || args.selector} into view`, ...info }, text: 'Scrolled element into view.' };
    }
    const dy = args.dy ?? 600;
    const dx = args.dx ?? 0;
    await page.mouse.wheel(dx, dy);
    const info = await pageInfo();
    return { report: { action: 'scroll', detail: `Scrolled by ${dx},${dy}`, ...info }, text: `Scrolled by (${dx}, ${dy}).` };
  },

  async browser_wait(args) {
    await ensurePage();
    if (args.text) {
      await page.getByText(String(args.text)).first().waitFor({ state: 'visible', timeout: 30_000 });
      const info = await pageInfo();
      return { report: { action: 'wait', detail: `Waited until "${args.text}" appeared`, ...info }, text: `"${args.text}" is visible.` };
    }
    if (args.textGone) {
      await page.getByText(String(args.textGone)).first().waitFor({ state: 'hidden', timeout: 30_000 });
      const info = await pageInfo();
      return { report: { action: 'wait', detail: `Waited until "${args.textGone}" disappeared`, ...info }, text: `"${args.textGone}" is gone.` };
    }
    const s = Math.min(Math.max(Number(args.seconds) || 1, 0.1), 30);
    await new Promise((r) => setTimeout(r, s * 1000));
    const info = await pageInfo();
    return { report: { action: 'wait', detail: `Waited ${s}s`, ...info }, text: `Waited ${s}s.` };
  },

  async browser_screenshot(args) {
    await ensurePage();
    const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: !!args.fullPage, timeout: 15_000 });
    const info = await pageInfo();
    let file;
    if (SHOTS_DIR && CHAT_ID) {
      const dir = path.join(SHOTS_DIR, CHAT_ID);
      fs.mkdirSync(dir, { recursive: true });
      shotSeq += 1;
      file = `${Date.now()}-${shotSeq}.jpg`;
      fs.writeFileSync(path.join(dir, file), buf);
    }
    return {
      report: {
        action: 'screenshot',
        detail: `Screenshot${args.fullPage ? ' (full page)' : ''} at ${viewport.width}×${viewport.height}`,
        screenshotFile: file, ...info,
      },
      content: [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `Screenshot captured (${args.fullPage ? 'full page' : `${viewport.width}×${viewport.height}`}) of ${info.url}` },
      ],
    };
  },

  async browser_resize(args) {
    await ensurePage();
    const width = Math.min(Math.max(Math.round(args.width), 200), 4000);
    const height = Math.min(Math.max(Math.round(args.height), 200), 4000);
    const newDsr = args.deviceScaleFactor ? Math.min(Math.max(Number(args.deviceScaleFactor), 1), 4) : dsr;
    viewport = { width, height };
    let note = '';
    if (newDsr !== dsr) {
      dsr = newDsr;
      const current = page.url();
      await context.close().catch(() => undefined);
      context = null;
      page = null;
      await ensurePage();
      if (current && current !== 'about:blank') {
        await page.goto(current, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
        note = ` (fresh context at deviceScaleFactor ${dsr}; page reloaded)`;
      }
    } else {
      await page.setViewportSize(viewport);
    }
    const info = await pageInfo();
    return {
      report: { action: 'resize', detail: `Viewport → ${width}×${height}${dsr !== 1 ? ` @${dsr}x` : ''}`, viewport: { ...viewport, deviceScaleFactor: dsr }, ...info },
      text: `Viewport is now ${width}×${height}${dsr !== 1 ? ` at ${dsr}x` : ''}${note}. The page is interactive at this size.`,
    };
  },

  async browser_console(args) {
    await ensurePage();
    const level = args.level === 'all' ? 'all' : 'error';
    const entries = consoleBuf.filter((e) => level === 'all' || e.level === 'error' || e.level === 'network' || e.level === 'warning');
    const shown = entries.slice(-40);
    const info = await pageInfo();
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

  async browser_evaluate(args) {
    await ensurePage();
    const value = await page.evaluate((code) => {
      // eslint-disable-next-line no-eval
      const r = eval(code);
      try { return JSON.parse(JSON.stringify(r)); } catch { return String(r); }
    }, String(args.code));
    const info = await pageInfo();
    const text = cap(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 5_000);
    return {
      report: { action: 'evaluate', detail: `Evaluated: ${cap(String(args.code), 90)}`, ...info },
      text,
    };
  },
};

// ---------------------------------------------------------------- MCP plumbing

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function callTool(name, args) {
  const handler = handlers[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  const t0 = Date.now();
  try {
    const out = await handler(args || {});
    // a crash-and-relaunch during this call is stated plainly: the AI must know
    // the page it was working with is gone rather than silently starting over
    const note = takeRecoveredNote();
    if (out.report) {
      report({ ...out.report, detail: `${out.report.detail}${note ? ' · browser restarted after a crash' : ''}`, durationMs: Date.now() - t0, status: 'done' });
    }
    if (out.content) {
      if (note && out.content[0] && out.content[0].type === 'text') {
        out.content[0] = { type: 'text', text: `${out.content[0].text}${note}` };
      }
      return { content: out.content };
    }
    return { content: [{ type: 'text', text: `${out.text ?? 'ok'}${note}` }] };
  } catch (err) {
    const message = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 400);
    let info = {};
    try { info = await pageInfo(); } catch { /* no page */ }
    report({ action: name.replace('browser_', ''), detail: `${name.replace('browser_', '')} failed`, error: message, durationMs: Date.now() - t0, status: 'failed', ...info });
    return { content: [{ type: 'text', text: `${name} failed: ${message}` }], isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tandem_browser', version: '1.0.0' },
    });
  } else if (method && method.startsWith('notifications/')) {
    // no response needed
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    void callTool(params && params.name, params && params.arguments)
      .then((result) => reply(id, result))
      .catch((err) => reply(id, { content: [{ type: 'text', text: String(err) }], isError: true }));
  } else if (method === 'ping') {
    reply(id, {});
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not implemented: ${method}`);
  }
});

async function shutdown() {
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  process.exit(0);
}
rl.on('close', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
