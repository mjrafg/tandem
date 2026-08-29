#!/usr/bin/env node
/**
 * Tandem integrations gateway — the MCP stdio server that exposes
 * Admin-configured integration tools (MCP / OpenAPI / HTTP / SSH) to the AI.
 *
 * It holds no credentials and performs no external calls itself: tools/list
 * fetches the role-filtered catalog from the Tandem server, and tools/call
 * forwards to the Tandem execution layer, which enforces role access, injects
 * credentials, sanitizes output, and records the timeline event.
 *
 * Env (inherited from the CLI spawn): TANDEM_INTERNAL_URL, TANDEM_INTERNAL_TOKEN,
 * TANDEM_CHAT_ID, TANDEM_ROLE.
 */
'use strict';

const BASE = process.env.TANDEM_INTERNAL_URL || 'http://127.0.0.1:7810/api/internal';
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN || '';
const CHAT_ID = process.env.TANDEM_CHAT_ID || '';
const ROLE = process.env.TANDEM_ROLE || 'builder';

let toolsCache = null;

async function fetchCatalog() {
  if (toolsCache) return toolsCache;
  const res = await fetch(`${BASE}/integration-catalog?role=${encodeURIComponent(ROLE)}&token=${encodeURIComponent(TOKEN)}`);
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  toolsCache = (data.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return toolsCache;
}

async function callTool(name, args) {
  const res = await fetch(`${BASE}/integration-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, chatId: CHAT_ID, role: ROLE, tool: name, args: args || {} }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `Gateway HTTP ${res.status}` }));
  if (data.ok) return { content: [{ type: 'text', text: data.result || '(empty result)' }] };
  return { content: [{ type: 'text', text: data.error || 'Tool execution failed.' }], isError: true };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tandem_ext', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      reply(id, { tools: await fetchCatalog() });
    } else if (method === 'tools/call') {
      reply(id, await callTool(params.name, params.arguments));
    } else if (method === 'ping') {
      reply(id, {});
    } else if (id !== undefined) {
      replyError(id, `Method not supported: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) replyError(id, err && err.message ? err.message : err);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      /* ignore malformed input */
    }
  }
});
process.stdin.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
