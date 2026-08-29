#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for app-state capabilities offered to the Builder:
 *   - tandem_set_working_dir: re-point the chat's active working directory
 *   - tandem_set_git_workflow: update the chat's persistent Git policy
 * Tool calls are forwarded to the Tandem app on localhost (token-authed),
 * which validates, persists, and records the change in the timeline.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;

const TOOLS = [
  {
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
  },
  {
    name: 'tandem_set_git_workflow',
    description: [
      'Update this chat\'s persistent Git workflow policy when the user asks for a change; it applies to future requests without re-asking.',
      'Modes: working-branch (Tandem commits checkpoints on its own tandem/ branch, no merging), auto-merge (after each completed request, merge the Tandem branch into the target branch), direct (work and commit directly on the target branch).',
      'Optionally set the target branch and whether completed merges are pushed to the remote.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['working-branch', 'auto-merge', 'direct'], description: 'The Git workflow mode to use from now on.' },
        target_branch: { type: 'string', description: 'Branch that auto-merge/direct mode targets (must exist). Defaults to the current target.' },
        push: { type: 'string', enum: ['auto', 'never'], description: 'Whether completed work is pushed to origin. Only set when the user clearly authorized ongoing pushing (or revoked it).' },
      },
    },
  },
];

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem.${tool.name}`];
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

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT_ID, token: TOKEN, ...body }),
  });
  const parsed = await res.json().catch(() => ({}));
  return { httpOk: res.ok, body: parsed };
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'tandem_set_working_dir') {
    const { httpOk, body } = await post('/workdir', { path: typeof args.path === 'string' ? args.path : '' });
    if (!httpOk || body.ok === false) {
      return { content: [{ type: 'text', text: `Could not change the working directory: ${body.error || 'error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Working directory is now ${body.path}. The chat UI and future turns follow this path.` }] };
  }
  if (name === 'tandem_set_git_workflow') {
    const { httpOk, body } = await post('/git-workflow', {
      mode: args.mode, target_branch: args.target_branch, push: args.push,
    });
    if (!httpOk || body.ok === false) {
      return { content: [{ type: 'text', text: `Could not update the Git workflow: ${body.error || 'error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Git workflow updated and persisted for this chat: ${body.summary}` }] };
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
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
      serverInfo: { name: 'tandem', version: '1.1.0' },
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
