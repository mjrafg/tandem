#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for ONE capability: handing the user a file.
 *
 *   tandem_share_file — a file from the working directory, or text the agent
 *   wrote, becomes a download card in the chat (images, audio and video
 *   preview in it).
 *
 * It is its own server, rather than one more Builder workdir tool, so that a
 * read-only role can have it without the Builder's other powers (changing the
 * working directory, the git workflow, project memory). Sharing changes
 * nothing in the project: a file is COPIED out of it, and text is stored by
 * Tandem, never written into the project. That is what lets a Reviewer hand
 * over a report without its review stopping being independent.
 *
 * Calls go to the Tandem app on localhost (token-authed), which resolves the
 * chat itself and refuses anything outside its directory.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;
const ROLE = process.env.TANDEM_LOGICAL_ROLE || 'builder';
// roles that cannot write to the project are told how to hand over what they wrote
const READ_ONLY = ['builder_reviewer', 'director_reviewer', 'reviewer', 'director'].includes(ROLE);

const TOOLS = [
  {
    name: 'tandem_share_file',
    description: [
      'Give the user a file, as a download card in the chat — a report, spreadsheet, PDF, archive, log, dataset, image, audio or video. Images, audio and video also play or preview in the card.',
      'Use it whenever the user asked for a file, or what you have to hand over IS a file: they cannot reach this machine\'s disk, so a file you only mention is a file they do not have.',
      READ_ONLY
        ? 'Your access to the project is read-only, so there are two ways to use it: share an existing file by `path`, or pass text you wrote — a review report, a summary, a log, a CSV — as `content` with a `name`, and Tandem creates the file. Nothing is written into the project either way.'
        : 'Share a file by `path` (inside your working directory), or pass text as `content` with a `name` to hand it over without adding a file to the project.',
      'A shared file is a copy taken at that moment: share it again after changing it. Archive a folder before sharing it. Limit 200 MB for a file, 5 MB for content.',
      'After sharing, just say the file is ready; do not paste what you shared.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'An existing file to share, relative to your working directory, e.g. "dist/report.pdf". Give this or `content`.' },
        content: { type: 'string', description: 'The text of a file to create and share, instead of `path` — e.g. a markdown report or a CSV. Requires `name`.' },
        name: { type: 'string', description: 'The file name for the download, with its extension, e.g. "review.md". Required with `content`; optional with `path`.' },
        note: { type: 'string', description: 'Optional one line telling the user what the file is.' },
      },
    },
  },
];

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem_share.${tool.name}`];
    if (!ov) continue;
    if (ov.description) tool.description = ov.description;
    for (const [param, desc] of Object.entries(ov.params || {})) {
      const prop = tool.inputSchema.properties[param];
      if (prop && desc) prop.description = desc;
    }
  }
} catch { /* ignore malformed overrides */ }

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function sizeText(n) {
  return n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

async function callTool(name, args) {
  args = args || {};
  if (name !== 'tandem_share_file') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const res = await fetch(`${BASE}/share-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: CHAT_ID, token: TOKEN, role: ROLE,
      path: typeof args.path === 'string' ? args.path : undefined,
      content: typeof args.content === 'string' ? args.content : undefined,
      name: typeof args.name === 'string' ? args.name : undefined,
      note: typeof args.note === 'string' ? args.note : undefined,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { content: [{ type: 'text', text: `The file was not shared: ${body.error || `HTTP ${res.status}`}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Shared "${body.name}" (${sizeText(body.size)}). The user now has a download card for it in the chat.` }] };
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
      serverInfo: { name: 'tandem_share', version: '1.0.0' },
    });
  } else if (method && method.startsWith('notifications/')) {
    // notifications need no response
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    callTool(params && params.name, params && params.arguments)
      .then((result) => reply(id, result))
      .catch((err) => reply(id, { content: [{ type: 'text', text: `Tool call failed: ${String(err)}` }], isError: true }));
  } else if (method === 'ping') {
    reply(id, {});
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not implemented: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
