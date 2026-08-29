#!/usr/bin/env node
/**
 * Minimal MCP stdio server exposing Tandem's one capability to the Builder:
 * tandem_set_working_dir. The tool call is forwarded to the Tandem app on
 * localhost, which validates the path, re-points the chat, and records the
 * change in the timeline. No other tools, no other side effects.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const API = `${BASE}/workdir`;
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;

const TOOL = {
  name: 'tandem_set_working_dir',
  description: [
    'Make a different directory this chat\'s active working directory in Tandem.',
    'Use it when further work belongs in another directory — for example after cloning a repository or extracting an attached archive into a new folder.',
    'The UI header, git status, and future turns will follow the new path.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path of the directory to make active.' },
    },
    required: ['path'],
  },
};

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const ov = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}')[`tandem.${TOOL.name}`];
  if (ov) {
    if (typeof ov.description === 'string' && ov.description.trim()) TOOL.description = ov.description;
    if (ov.params) {
      for (const [param, desc] of Object.entries(ov.params)) {
        if (TOOL.inputSchema.properties[param] && typeof desc === 'string' && desc.trim()) {
          TOOL.inputSchema.properties[param].description = desc;
        }
      }
    }
  }
} catch { /* factory text stands */ }

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(args) {
  const path = args && typeof args.path === 'string' ? args.path : '';
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT_ID, path, token: TOKEN }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { content: [{ type: 'text', text: `Could not change the working directory: ${body.error || res.status}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Working directory is now ${body.path}. The chat UI and future turns follow this path.` }] };
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
      serverInfo: { name: 'tandem', version: '1.0.0' },
    });
  } else if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) {
    // notifications need no response
  } else if (method === 'tools/list') {
    reply(id, { tools: [TOOL] });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== TOOL.name) {
      replyError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    callTool(params.arguments)
      .then((result) => reply(id, result))
      .catch((err) => reply(id, { content: [{ type: 'text', text: `Working-directory change failed: ${String(err)}` }], isError: true }));
  } else if (method === 'ping') {
    reply(id, {});
  } else if (id !== undefined) {
    replyError(id, -32601, `Method not implemented: ${method}`);
  }
});
rl.on('close', () => process.exit(0));
