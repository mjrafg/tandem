#!/usr/bin/env node
/*
 * Fake Claude Code CLI — deterministic driver for Project Director E2E tests.
 * Three behaviors:
 *  - /context, /compact (provider-native context probes, unchanged)
 *  - DIRECTOR turns: scripted tool calls against the real tandem_director MCP
 *    server (spawned per --mcp-config), then a text reply. Script + step counter
 *    come from FAKE_DIRECTOR_SCRIPT / a per-run state file.
 *  - BUILDER sessions: run a scripted shell recipe (create files, git) so the
 *    Director observes real repository state, then emit a text result.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const marker = path.join(process.env.FAKE_STATE_DIR || '/tmp', 'fake-compacted');
const SID = 'fake-sess-' + (process.env.TANDEM_CHAT_ID || '0001').slice(0, 8);
const resumeIdx = args.indexOf('--resume');
const sid = resumeIdx >= 0 ? args[resumeIdx + 1] : SID;
const prompt = args[args.length - 1];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// test hook: record every invocation's argv for assertion (BEFORE any stdin
// read — slash-command spawns never write stdin and must not block here)
try { fs.appendFileSync(path.join(process.env.FAKE_STATE_DIR || '/tmp', 'claude-argv.log'), JSON.stringify(args) + '\n'); } catch {}

function ctxTokens() { return fs.existsSync(marker) ? 9100 : 42300; }

if (prompt === '/context') {
  emit({ is_error: false, subtype: 'success', session_id: sid, num_turns: 0, total_cost_usd: 0,
    result: `## Context Usage\n\n**Model:** fake-model  \n**Tokens:** ${(ctxTokens() / 1000).toFixed(1)}k / 200k (${Math.round(ctxTokens() / 2000)}%)\n` });
  process.exit(0);
}
if (prompt === '/compact') {
  fs.writeFileSync(marker, '1');
  emit({ is_error: false, subtype: 'success', session_id: sid, num_turns: 0, total_cost_usd: 0.02, result: '' });
  process.exit(0);
}
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}

const mcpConfigPath = arg('--mcp-config');
let mcpServers = {};
try { if (mcpConfigPath) mcpServers = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers || {}; } catch {}
const isDirector = !!mcpServers.tandem_director;
const cwd = arg('cwd') || process.cwd();

// ------------------------------------------------- MCP client (to a stdio server)
function mcpCall(server, calls) {
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    let buf = ''; const pending = new Map(); let id = 1; const results = [];
    let queue = [...calls]; let inited = false;
    const rpc = (method, params) => { const n = id++; return new Promise((r) => { pending.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); }); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} }
    });
    (async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05' });
      for (const call of queue) {
        const r = await rpc('tools/call', { name: call.name, arguments: call.args });
        results.push({ name: call.name, text: (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '', isError: !!(r.result && r.result.isError) });
      }
      child.kill();
      resolve(results);
    })();
    child.on('error', () => resolve(results));
  });
}

// ------------------------------------------------- director behavior
async function runDirector() {
  const scriptFile = process.env.FAKE_DIRECTOR_SCRIPT;
  let script = [];
  try { script = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch {}
  const stateFile = path.join(process.env.FAKE_STATE_DIR || '/tmp', `director-step-${process.env.TANDEM_CHAT_ID}`);
  let step = 0;
  try { step = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
  const turn = script[step] || { reply: 'Standing by.' };
  fs.writeFileSync(stateFile, String(step + 1));

  emit({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
  let toolResults = [];
  if (turn.tools && turn.tools.length) {
    toolResults = await mcpCall(mcpServers.tandem_director, turn.tools);
  }
  const summary = toolResults.map((r) => `[${r.name}${r.isError ? ' ERROR' : ''}] ${r.text.slice(0, 120)}`).join(' | ');
  const reply = `${turn.reply || 'Working.'}${summary ? `\n(tools: ${summary})` : ''}`;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  const cr = process.env.FAKE_BIG_CONTEXT ? 800000 : 20000;
  emit({ type: 'result', subtype: 'success', is_error: false, result: reply, num_turns: 1, session_id: SID,
    usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: cr, cache_creation_input_tokens: 100,
      iterations: [{ input_tokens: 500, cache_read_input_tokens: cr, cache_creation_input_tokens: 100, output_tokens: 60 }] },
    modelUsage: { 'fake-model': { contextWindow: 1000000 } } });
  process.exit(0);
}

// ------------------------------------------------- builder session behavior
async function runBuilder() {
  emit({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
  // exercise the session-naming tool exactly like a real Builder would: only
  // when the engine served it (env flag) and the prompt carries a NAMEME marker
  const nm = stdin.match(/NAMEME:([^;\n]+)/);
  if (process.env.TANDEM_NAME_SESSION === '1' && mcpServers.tandem && nm) {
    await mcpCall(mcpServers.tandem, [{ name: 'tandem_name_session', args: { name: nm[1].trim() } }]);
  }
  // a builder recipe is chosen by a marker word in the session prompt
  const recipes = {};
  try { Object.assign(recipes, JSON.parse(process.env.FAKE_BUILDER_RECIPES || '{}')); } catch {}
  let did = 'no-op';
  for (const [marker, cmds] of Object.entries(recipes)) {
    if (stdin.includes(marker)) {
      for (const cmd of cmds) {
        try { execSync(cmd, { cwd, stdio: 'pipe', env: process.env }); } catch (e) { /* leave a trace but keep going */ }
      }
      did = marker;
      break;
    }
  }
  // honor a forced-timeout marker: sleep past the run timeout so the engine reports it
  if (stdin.includes('FAKE_TIMEOUT')) {
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) { try { execSync('sleep 5'); } catch {} }
  }
  const text = `Session work done (${did}).`;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: SID,
    usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100,
      iterations: [{ input_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100, output_tokens: 60 }] },
    modelUsage: { 'fake-model': { contextWindow: 1000000 } } });
  process.exit(0);
}

if (isDirector) void runDirector();
else void runBuilder();
