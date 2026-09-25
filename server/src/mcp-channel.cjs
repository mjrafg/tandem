#!/usr/bin/env node
/**
 * Tandem's MCP stdio server for CHANNELS and VIDEO PROJECTS: the reusable
 * creative identity many videos share (Style Bible, characters, locations,
 * props, reference and production assets), and the production state of the
 * video project a chat belongs to.
 *
 * Every call goes to the Tandem app, which enforces who may do what: readers
 * see, writers change, only the Director asks for approval, and only the user
 * — in the UI — approves.
 */
'use strict';

const readline = require('node:readline');

const BASE = (process.env.TANDEM_INTERNAL_URL || '').replace(/\/workdir$/, '');
const CHAT_ID = process.env.TANDEM_CHAT_ID;
const TOKEN = process.env.TANDEM_INTERNAL_TOKEN;
const ROLE = process.env.TANDEM_LOGICAL_ROLE || 'builder';
const WORKDIR = process.env.TANDEM_WORKDIR || process.cwd();
const WRITER = ['builder', 'final_repair', 'director'].includes(ROLE);
const DIRECTOR = ROLE === 'director';

const channelRef = { type: 'string', description: 'Channel id, slug or name. Omit inside a video project to use the channel version it is pinned to.' };
const assetItem = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'A file in your working directory (or a Video Engine workspace), e.g. "art/quill-front.png".' },
    file_id: { type: 'string', description: 'Instead of path: the id of a file shared or generated in this chat or project.' },
    kind: { type: 'string', enum: ['reference', 'production'], description: 'reference = preserves identity or guides generation (character sheet, expression sheet, location or style reference) — never an engine layer. production = prepared for the engine (transparent cut-out, body part, mouth shape, processed prop, background layer).' },
    name: { type: 'string' },
    description: { type: 'string', description: 'What it shows, so a later search finds it.' },
    entity_id: { type: 'string', description: 'The character / location / prop it belongs to (id from channel_get).' },
    tags: { type: 'array', items: { type: 'string' } },
    attributes: { type: 'object', description: 'Searchable facts: view (front, side, three-quarter…), pose, expression, state, transparent (bool), processed (bool), engineReady (bool), anchors…' },
  },
  required: ['kind', 'name'],
};

const TOOLS = [
  {
    name: 'channel_list',
    description: 'List the channels: id, name, latest version, entities and asset counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'channel_get',
    description: 'Read a channel version: description, Style Bible, entities (characters, locations, props) and history. Inside a video project this is the version the project is pinned to. detail=true adds the full Style Bible sections and entity descriptions — read it when you create visuals.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: channelRef,
        version: { type: 'number', description: 'A specific version (default: the pinned version in a video project, else the latest).' },
        detail: { type: 'boolean' },
      },
    },
  },
  ...(WRITER ? [{
    name: 'channel_update',
    description: [
      'Create a channel, or change one. Every successful call writes ONE new immutable channel version — batch related changes into one call.',
      'Video projects stay on the version they were created with, so changing a channel never alters an existing video.',
      'Entities are characters, locations, props and other recurring things: pass them without id to create, with id to update (attributes merge).',
      'Style Bible sections are free-form named texts (e.g. "Palette", "Lighting", "Composition", "Character proportions", "Image prompt guidance"); set a section to null to remove it.',
      'Pass expected_version (the version you read) to refuse the write if someone changed the channel in the meantime.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        create: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'], description: 'Create a new channel with this name; the rest of this call becomes its first version.' },
        channel: channelRef,
        expected_version: { type: 'number' },
        rename: { type: 'string' },
        description: { type: 'string' },
        style_bible: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'The short version every visual agent is handed.' },
            sections: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
          },
        },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Omit to create a new entity.' },
              type: { type: 'string', enum: ['character', 'location', 'prop', 'other'] },
              name: { type: 'string' },
              summary: { type: 'string', description: 'One line.' },
              description: { type: 'string', description: 'The canonical description: appearance, proportions, palette, personality, rules.' },
              attributes: { type: 'object' },
            },
          },
        },
        remove_entities: { type: 'array', items: { type: 'string' } },
        defaults: { type: 'object', description: 'Production defaults: narration voice, pacing, aspect ratio…' },
        note: { type: 'string', description: 'What changed and why — the version history shows it.' },
      },
    },
  }] : []),
  {
    name: 'asset_search',
    description: 'Search reusable assets BEFORE generating anything: this project\'s own assets and the channel\'s (in a video project: the pinned version). Filter by kind (reference | production), entity_id, scope, tags, engine_ready or free text over names, descriptions and attributes. Results carry a small preview image path you can look at, and — for production assets only — the engine_import source for the Video Engine.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: channelRef,
        query: { type: 'string' },
        kind: { type: 'string', enum: ['reference', 'production'] },
        entity_id: { type: 'string' },
        scope: { type: 'string', enum: ['channel', 'project'] },
        tags: { type: 'array', items: { type: 'string' } },
        engine_ready: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  ...(WRITER ? [{
    name: 'asset_add',
    description: 'Register existing files as assets, with the metadata that makes them findable. In a video project they belong to THE PROJECT (use asset_promote to offer one to the channel); outside one they join the named channel (one new version for the whole batch). To register an image you are generating, pass `register` to tandem_generate_image instead.',
    inputSchema: {
      type: 'object',
      properties: { channel: channelRef, assets: { type: 'array', items: assetItem }, note: { type: 'string' } },
      required: ['assets'],
    },
  }, {
    name: 'asset_promote',
    description: 'Offer one of this video project\'s assets to the channel, so future videos can reuse it. The user decides; until they approve it stays project-only. Promote only assets worth reusing — not one-off shots, experiments or duplicates.',
    inputSchema: {
      type: 'object',
      properties: { asset_id: { type: 'string' }, reason: { type: 'string', description: 'Why it is worth reusing.' } },
      required: ['asset_id', 'reason'],
    },
  }] : []),
  {
    name: 'video_status',
    description: 'The video project this chat belongs to: channel and pinned version (and whether a newer one exists), production phase, approved budget, what has been spent and on what, the estimate, the narration, and approvals waiting for the user.',
    inputSchema: { type: 'object', properties: {} },
  },
  ...(DIRECTOR ? [{
    name: 'video_request_production_approval',
    description: [
      'Ask the user to approve the final production plan and its cost. Paid generation (images, narration, other paid APIs) is blocked until they do, and cannot exceed the budget they approve — call this again with a new estimate to ask for more.',
      'Do this only once story, script and plan are settled. Give COUNTS, not prices: the reuse analysis (which existing assets are reused — ids from asset_search), each new image still needed and why, new character variants, narration length in characters. Tandem prices them from the configured rates and shows the user the breakdown.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The production plan in a few paragraphs: story, scenes and how they reuse assets, narration, what will be generated.' },
        narration_seconds: { type: 'number' },
        reused_assets: { type: 'array', items: { type: 'string' } },
        new_images: { type: 'array', items: { type: 'object', properties: { purpose: { type: 'string' }, entity_id: { type: 'string' } }, required: ['purpose'] } },
        new_character_variants: { type: 'number' },
        tts_characters: { type: 'number', description: 'Characters of final narration text.' },
        tts_provider: { type: 'string' },
        other_paid: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, count: { type: 'number' } } } },
      },
      required: ['summary'],
    },
  }, {
    name: 'video_upgrade_channel',
    description: 'Ask the user to move this video project to another (usually the latest) channel version. Projects never move on their own; only do this when the user wants the newer channel content in this video.',
    inputSchema: { type: 'object', properties: { to_version: { type: 'number' }, reason: { type: 'string' } }, required: ['reason'] },
  }] : []),
  ...(WRITER ? [{
    name: 'video_lock_narration',
    description: 'Record the final production narration and its REAL timing, after it has been generated and registered as an audio asset. Animation timing and final renders are blocked until this is done, so visuals follow the narration. For a video without narration pass none=true with a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_id: { type: 'string', description: 'The narration audio asset.' },
        duration_seconds: { type: 'number' },
        segments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } }, description: 'Per-sentence or per-beat timings, in seconds.' },
        none: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
  }] : []),
];

// Admin-edited AI-facing text (descriptions only) — see Admin → AI Tools.
try {
  const overrides = JSON.parse(process.env.TANDEM_TOOL_TEXT || '{}');
  for (const tool of TOOLS) {
    const ov = overrides[`tandem_channel.${tool.name}`];
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

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const res = await fetch(`${BASE}/channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: CHAT_ID, token: TOKEN, role: ROLE, workdir: WORKDIR, op: name, args: args || {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { content: [{ type: 'text', text: `Channel tools: ${body.error || `HTTP ${res.status}`}` }], isError: true };
  }
  return { content: [{ type: 'text', text: body.text || 'ok' }] };
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
      serverInfo: { name: 'tandem_channel', version: '1.0.0' },
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
