#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for ONE capability: generating an image.
 *
 *   tandem_generate_image — an image from a prompt, on the provider and model
 *   chosen in Admin → Image generation (Codex by default). The user sees it in
 *   the chat, with a Download button; `save_to` also writes it into the
 *   working directory.
 *
 * Only the Builder is given this server. Generation runs in the Tandem app
 * (token-authed), which also refuses any other role.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;
const ROLE = process.env.TANDEM_LOGICAL_ROLE || 'builder';
// the CLI starts this server in the agent's working directory
const WORKDIR = process.env.TANDEM_WORKDIR || process.cwd();

const TOOLS = [
  {
    name: 'tandem_generate_image',
    description: [
      'Generate a raster image from a text prompt — an illustration, photo, texture, hero image, product shot, sprite, icon art or mockup.',
      'The user sees the image in the chat with a Download button, so you do not need to share it separately.',
      'Pass `save_to` to also write it into your working directory when the project uses it (e.g. "public/hero.png"); it never overwrites an existing file.',
      'Write a specific prompt: subject, style or medium, composition, lighting, colours, and any exact text in quotes. Generation takes up to a few minutes and costs quota, so generate what is needed, not variations nobody asked for.',
      'Prefer SVG, HTML or CSS for simple shapes, diagrams, icons that must match an existing vector set, or anything that should stay editable as code.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate, in detail.' },
        shape: { type: 'string', enum: ['square', 'landscape', 'portrait', 'auto'], description: 'Aspect of the image. Default: auto.' },
        transparent: { type: 'boolean', description: 'A transparent background (for a cut-out, sprite or logo). Default: false.' },
        save_to: { type: 'string', description: 'Optional path, relative to your working directory, to also save the image at, e.g. "assets/hero.png". The extension follows the generated format.' },
        name: { type: 'string', description: 'Optional file name for the download, e.g. "hero.png".' },
        note: { type: 'string', description: 'Optional one line telling the user what the image is.' },
        reference_asset_ids: { type: 'array', items: { type: 'string' }, description: 'Asset ids (from asset_search) of reference images to condition on — a character\'s canonical sheet to keep its identity, a location to place something in, a style reference. Name each one\'s role in the prompt ("image 1 is the character, image 2 the location").' },
        register: {
          type: 'object',
          description: 'Also register the image as a searchable asset (in a video project it belongs to the project; elsewhere pass channel).',
          properties: {
            kind: { type: 'string', enum: ['reference', 'production'] },
            name: { type: 'string' },
            description: { type: 'string' },
            entity_id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            attributes: { type: 'object', description: 'view, pose, expression, state, transparent, processed, engineReady…' },
            channel: { type: 'string' },
          },
          required: ['kind'],
        },
        variant: { type: 'string', description: 'Set only to deliberately get a DIFFERENT image for an identical request (in a video project an identical request otherwise returns the earlier image, free).' },
      },
      required: ['prompt'],
    },
  },
];

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem_image.${tool.name}`];
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
  if (name !== 'tandem_generate_image') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const res = await fetch(`${BASE}/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: CHAT_ID, token: TOKEN, role: ROLE, workdir: WORKDIR,
      prompt: str(args.prompt), shape: str(args.shape), transparent: args.transparent === true,
      save_to: str(args.save_to), name: str(args.name), note: str(args.note),
      reference_asset_ids: Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids : undefined,
      register: args.register && typeof args.register === 'object' ? args.register : undefined,
      variant: str(args.variant),
    }),
    // generation can take minutes; the server bounds it itself
    signal: AbortSignal.timeout(300_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { content: [{ type: 'text', text: `No image was generated: ${body.error || `HTTP ${res.status}`}` }], isError: true };
  }
  const dims = body.width && body.height ? `${body.width}×${body.height} ` : '';
  const saved = body.savedTo ? ` Saved in the working directory at ${body.savedTo}.` : '';
  const asset = body.assetId ? ` Registered as ${body.assetKind} asset ${body.assetId} (${body.assetScope} scope).` : '';
  const cost = typeof body.costUsd === 'number' ? ` Charged to the video budget: $${body.costUsd.toFixed(2)}.` : '';
  const head = body.reused
    ? `An identical request already produced "${body.name}" in this project — returned it again instead of generating (nothing charged).`
    : `Generated "${body.name}" (${dims}${String(body.mime).replace('image/', '').toUpperCase()}, ${sizeText(body.size)}) with ${body.provider}/${body.model}. The user can see it in the chat now.`;
  return { content: [{ type: 'text', text: `${head}${saved}${asset}${cost}` }] };
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
      serverInfo: { name: 'tandem_image', version: '1.0.0' },
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
