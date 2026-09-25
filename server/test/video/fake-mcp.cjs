#!/usr/bin/env node
// A stand-in MCP server for the tests: FAKE_KIND=engine serves a few Video
// Engine tools, FAKE_KIND=labs a paid text-to-speech tool. Every call, and the
// environment it was started with, is appended to FAKE_LOG.
const fs = require('node:fs');
const readline = require('node:readline');
const KIND = process.env.FAKE_KIND;
const LOG = process.env.FAKE_LOG;
const obj = (props) => ({ type: 'object', properties: props });
const TOOLS = KIND === 'engine' ? [
  { name: 'asset_import', description: 'Import an asset.', inputSchema: obj({ workspaceId: { type: 'string' }, source: { type: 'object' }, assetId: { type: 'string' } }) },
  { name: 'scene_create', description: 'Create a scene.', inputSchema: obj({ workspaceId: { type: 'string' }, sceneId: { type: 'string' } }) },
  { name: 'scene_get', description: 'Read a scene.', inputSchema: obj({ workspaceId: { type: 'string' }, sceneId: { type: 'string' } }) },
  { name: 'layer_add', description: 'Add layers.', inputSchema: obj({ workspaceId: { type: 'string' }, sceneId: { type: 'string' } }) },
  { name: 'timeline_apply', description: 'Animate.', inputSchema: obj({ workspaceId: { type: 'string' }, sceneId: { type: 'string' }, operations: { type: 'array' } }) },
  { name: 'render_video_start', description: 'Render.', inputSchema: obj({ workspaceId: { type: 'string' }, sceneId: { type: 'string' } }) },
] : [
  { name: 'creative_generate_speech', description: 'Generate speech.', inputSchema: obj({ text: { type: 'string' }, voice: { type: 'string' } }) },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `fake-${KIND}`, version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  else if (m.method === 'tools/call') {
    fs.appendFileSync(LOG, JSON.stringify({ tool: m.params.name, args: m.params.arguments, libraries: process.env.VIDEO_ENGINE_LIBRARIES || '' }) + '\n');
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name} ok #${fs.readFileSync(LOG, 'utf8').trim().split('\n').length}` }] } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
