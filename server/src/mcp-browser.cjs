#!/usr/bin/env node
/**
 * Tandem's internal browser — MCP stdio PROXY.
 *
 * The browser itself lives in the Tandem SERVER (engine/browserHost.ts),
 * keyed by chat + role, so live browser state survives across AI invocations:
 * the agent that logged in and scrolled somewhere last turn is still there
 * next turn. This process only translates MCP tool calls into token-authed
 * localhost HTTP calls and streams the results (text + screenshots) back.
 *
 * Isolation is canonical, not process-based: different chats never share a
 * browser, and the Reviewer never shares the Builder's browser.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID || '';
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN || '';
const ROLE = process.env.TANDEM_BROWSER_ROLE || 'builder';

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in Tandem\'s internal Chromium browser (real rendering; localhost and file:// URLs work). Also accepts "back", "forward", or "reload". Returns the page title, URL, and an element snapshot with [ref=…] ids for interaction. The browser belongs to this chat and persists across turns: earlier sign-ins and the last open page are still there.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open, or back|forward|reload' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    description: 'Get the current page\'s structure: interactive elements with [ref=…] ids plus visible text. Refs are valid until the page changes or the next snapshot. Works on whatever page this chat\'s browser is currently on — including one left open in an earlier turn.',
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
    description: 'Capture a screenshot of the current page. You receive the image for visual inspection, and it is stored in the chat timeline for the user \u2014 you never need to save it yourself, and never need to read it back with Read. fullPage captures beyond the viewport.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
  },
  {
    name: 'browser_resize',
    description: 'Set the viewport to any width×height (and optionally deviceScaleFactor). Use for responsive checks at whatever sizes you judge useful. Changing deviceScaleFactor reloads the page in a fresh context (sign-in is preserved).',
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
  {
    name: 'browser_reload',
    description: 'Reload the current page in place. hard=true additionally clears the HTTP cache first (cookies and sign-in are always preserved) — use it to verify freshly deployed UI changes. Errors if no page is open yet.',
    inputSchema: { type: 'object', properties: { hard: { type: 'boolean', description: 'true = clear the HTTP cache before reloading (assets refetched)' } } },
  },
  {
    name: 'browser_reset',
    description: 'Replace this chat\'s live browser context with a fresh one when it is stuck or contaminated. Cookies/localStorage are saved first and restored into the fresh context, and the previous page is reopened — but live-only state (open dialogs, sessionStorage, in-memory page state) is discarded. Only affects this chat\'s own browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_kill',
    description: 'Close this chat\'s browser and release its resources when you are done with it for a while. Cookies/localStorage and the last page are saved: the next browser tool call starts fresh and restores them. This is NOT a logout and does NOT clear browser data.',
    inputSchema: { type: 'object', properties: {} },
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

// ---------------------------------------------------------------- forwarding

async function callTool(name, args) {
  if (!BASE || !TOKEN || !CHAT_ID) {
    return { content: [{ type: 'text', text: 'Browser unavailable: this invocation has no Tandem connection.' }], isError: true };
  }
  try {
    const res = await fetch(`${BASE}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, chatId: CHAT_ID, role: ROLE, tool: name, args: args || {} }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.content)) {
      return { content: [{ type: 'text', text: `${name} failed: ${body.error || `HTTP ${res.status}`}` }], isError: true };
    }
    return { content: body.content, ...(body.isError ? { isError: true } : {}) };
  } catch (err) {
    return { content: [{ type: 'text', text: `${name} failed: ${String(err && err.message ? err.message : err).slice(0, 300)}` }], isError: true };
  }
}

// ---------------------------------------------------------------- MCP plumbing

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tandem_browser', version: '2.0.0' },
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
// the browser lives in the Tandem server — nothing to shut down here
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
