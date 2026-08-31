#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for app-state capabilities offered to the Builder:
 *   - tandem_set_working_dir: re-point the chat's active working directory
 *   - tandem_set_git_workflow: update the chat's persistent Git policy
 *   - project_memory_*: the project's shared memory (Builder only)
 * Tool calls are forwarded to the Tandem app on localhost (token-authed),
 * which validates, persists, and records the change in the timeline.
 *
 * This server is configured only for Builder/final-repair invocations, so the
 * Reviewer is never served these tools; the app additionally refuses memory
 * calls made while a review is running.
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
  {
    name: 'project_memory_search',
    description: [
      'Search this project\'s shared memory — notes kept about the project itself (architecture decisions, conventions, constraints, gotchas).',
      'Plain case-insensitive text matching over title, content and tags. Optional: call it when project knowledge would help; nothing is retrieved automatically.',
      'The memory belongs to the project, so every chat in this project sees the same entries.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in the memory titles, content and tags.' },
        limit: { type: 'number', description: 'Maximum number of memories to return (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'project_memory_list',
    description: 'List this project\'s stored memories, most recently updated first. Useful to see what the project already knows before searching for something specific.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum number of memories to return (default 20, max 50).' } },
    },
  },
  {
    name: 'project_memory_get',
    description: 'Read one memory of this project in full, by the memory_id returned from a search or list.',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string', description: 'The memory_id from project_memory_search or project_memory_list.' } },
      required: ['memory_id'],
    },
  },
  {
    name: 'project_memory_create',
    description: [
      'Record one durable fact about this project that would help future work — an architectural decision, a convention, a constraint, a hard-won gotcha.',
      'Write it only when the knowledge outlives the current task; do not log task progress, summaries, or anything already obvious from the code.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the fact, e.g. "Auth architecture".' },
        content: { type: 'string', description: 'The fact itself, stated plainly in a sentence or two.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'A few lowercase keywords for retrieval, e.g. ["auth", "jwt"].' },
      },
      required: ['title', 'content'],
    },
  },
];

// Served only on a Director session's FIRST Builder turn (TANDEM_NAME_SESSION):
// the model contributes just the short descriptive part; Tandem composes the
// final "M2 - S2.1 - Storage Engine" title from Director metadata.
if (process.env.TANDEM_NAME_SESSION === '1') {
  TOOLS.push({
    name: 'tandem_name_session',
    description: [
      'Register a short, meaningful display name for this working session, chosen from the work you are about to do — e.g. "Storage Engine", "CLI Surface", "Cross-Surface Reconciliation".',
      'Call it exactly once, as your very first action this session. 2–5 words, Title Case, no punctuation.',
      'Do not mention the name or this step in your reply.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short descriptive session name (2–5 words, Title Case).' },
      },
      required: ['name'],
    },
  });
}

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
  if (name === 'tandem_name_session') {
    const { httpOk, body } = await post('/name-session', { name: typeof args.name === 'string' ? args.name : '' });
    if (!httpOk || body.ok === false) {
      return { content: [{ type: 'text', text: `Session name not applied: ${body.error || 'error'}. Continue with the work.` }], isError: true };
    }
    return { content: [{ type: 'text', text: 'Session name registered. Continue with the work; do not mention this step.' }] };
  }
  if (name.startsWith('project_memory_')) {
    // the app resolves the project from this chat — no project id is accepted
    // from the model, so a call can only ever touch its own project's memory
    const { httpOk, body } = await post('/project-memory', {
      op: name.replace('project_memory_', ''),
      query: args.query,
      limit: args.limit,
      memory_id: args.memory_id,
      title: args.title,
      content: args.content,
      tags: args.tags,
    });
    if (!httpOk || body.ok === false) {
      return { content: [{ type: 'text', text: `Project memory: ${body.error || 'error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: body.text }] };
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
