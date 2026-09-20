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
const SID = 'fake-sess-' + (process.env.TANDEM_CHAT_ID || '0001').slice(0, 8);
const resumeIdx = args.indexOf('--resume');
const sid = resumeIdx >= 0 ? args[resumeIdx + 1] : SID;
// the "compacted" state is per provider SESSION, as it is for the real CLI —
// one chat's compaction must not change what another chat's /context reports
const marker = path.join(process.env.FAKE_STATE_DIR || '/tmp', `fake-compacted-${sid}`);
const prompt = args[args.length - 1];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// test hook: record every invocation's argv for assertion (BEFORE any stdin
// read — slash-command spawns never write stdin and must not block here)
try { fs.appendFileSync(path.join(process.env.FAKE_STATE_DIR || '/tmp', 'claude-argv.log'), JSON.stringify({ argv: args, autoCompactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null }) + '\n'); } catch {}

function ctxTokens() { return fs.existsSync(marker) ? 9100 : 42300; }

// test hook: the Nth call of a role is refused exactly as the real CLI reported
// an Anthropic overload — exit 0, a result with is_error and the API message
const FAIL_TEXT = process.env.FAKE_CLAUDE_FAIL_TEXT
  || 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.';
function countCall(role) {
  const f = path.join(process.env.FAKE_STATE_DIR || '/tmp', `${role}-call-count`);
  let n = 0; try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
  n += 1; fs.writeFileSync(f, String(n)); return n;
}
function refuse() {
  emit({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: FAIL_TEXT }] } });
  emit({ type: 'result', subtype: 'success', is_error: true, result: FAIL_TEXT, num_turns: 1, session_id: SID,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [] },
    modelUsage: { 'fake-model': { contextWindow: 1000000 } } });
  process.exit(0);
}

if (prompt === '/context') {
  emit({ is_error: false, subtype: 'success', session_id: sid, num_turns: 0, total_cost_usd: 0,
    result: `## Context Usage\n\n**Model:** fake-model  \n**Tokens:** ${(ctxTokens() / 1000).toFixed(1)}k / 200k (${Math.round(ctxTokens() / 2000)}%)\n` });
  process.exit(0);
}
if (prompt === '/compact') {
  // FAKE_COMPACT_NOOP=1: answer success but leave the session exactly as it was —
  // what the real CLI did under the 2026-09-03 overload
  if (!process.env.FAKE_COMPACT_NOOP) fs.writeFileSync(marker, '1');
  emit({ is_error: false, subtype: 'success', session_id: sid, num_turns: 0, total_cost_usd: 0.02, result: process.env.FAKE_COMPACT_RESULT || '' });
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
  // a refused turn does not advance the script: the engine re-says it later
  const dn = countCall('director');
  if (String(dn) === String(process.env.FAKE_DIRECTOR_FAIL_ON_TURN || '')) refuse();
  // FAKE_DIRECTOR_CRASH_ON_TURN: the Nth Director turn dies with a generic, NON-outage
  // error (a crash, a refused model) — the case that used to end a project silently
  if (String(dn) === String(process.env.FAKE_DIRECTOR_CRASH_ON_TURN || '')) {
    process.stderr.write('fatal: the CLI crashed before producing a result\n');
    process.exit(3);
  }
  const stateFile = path.join(process.env.FAKE_STATE_DIR || '/tmp', `director-step-${process.env.TANDEM_CHAT_ID}`);
  let step = 0;
  try { step = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
  const turn = script[step] || { reply: 'Standing by.' };
  fs.writeFileSync(stateFile, String(step + 1));

  emit({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
  let toolResults = [];
  // FAKE_DIRTY_FILE: leave an uncommitted file in the project immediately before
  // the turn's tools run, so a decision that must inspect the WORKING TREE (not
  // just branch ancestry) is exercised deterministically, with HEAD unchanged.
  if (process.env.FAKE_DIRTY_FILE) {
    try { fs.writeFileSync(process.env.FAKE_DIRTY_FILE, `uncommitted ${Date.now()}\n`); } catch {}
  }
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
  if (String(countCall('builder')) === String(process.env.FAKE_CLAUDE_FAIL_ON_CALL || '')) refuse();
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
  let text = `Session work done (${did}).`;
  // FAKE_BUILDER_NOTE: a hand-off line recommending a future check — the Reviewer's job, and the
  // kind of sentence that must never outrank the Reviewer's later verdict downstream
  if (process.env.FAKE_BUILDER_NOTE) text += `\n\n${process.env.FAKE_BUILDER_NOTE}`;
  // Findings are advice: when the engine asks for dispositions, answer every
  // numbered finding. FAKE_DISPOSITION picks the word (default accepted), so a
  // scenario can make the Builder reject with evidence and send it to the Director.
  if (/FINDING 1: accepted \| partially_accepted/.test(stdin)) {
    const n = (stdin.match(/^\s*\d+\.\s*(F-\d{3} )?\[(major|minor)\]/gm) || []).length || 1;
    const isFinalPass = /FINAL repair pass/.test(stdin);
    const word = (isFinalPass && process.env.FAKE_DISPOSITION_FINAL) || process.env.FAKE_DISPOSITION || 'accepted';
    text += '\n\n' + Array.from({ length: n }, (_, i) => `FINDING ${i + 1}: ${word}\nReason: ${word === 'rejected' ? 'the finding enforces a generated brief line, not a user requirement' : 'fixed as the finding describes'}\nEvidence: ${word === 'rejected' ? 'git log shows commits attributed to the runtime that made them' : 'a.txt now holds the corrected content'}`).join('\n');
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  // FAKE_BIG_CONTEXT: report a context far past the auto-compact ceiling, for the Builder too
  const bcr = process.env.FAKE_BIG_CONTEXT ? 800000 : 4000;
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: SID,
    usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: bcr, cache_creation_input_tokens: 100,
      iterations: [{ input_tokens: 500, cache_read_input_tokens: bcr, cache_creation_input_tokens: 100, output_tokens: 60 }] },
    modelUsage: { 'fake-model': { contextWindow: 1000000 } } });
  process.exit(0);
}

// ------------------------------------------------- Reviewer (provider-switch tests)
// The engine names the role in TANDEM_ROLE for every provider. As a Reviewer
// this fake answers exactly like fake-codex does — same counter file, same
// verdict schedule — so a scenario reads the same whichever backend reviews.
function runReviewer() {
  const isSession = stdin.includes("# The user's original request");
  let n = 0;
  if (isSession) { const f = path.join(process.env.FAKE_STATE_DIR || '/tmp', 'session-review-count'); try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {} n += 1; fs.writeFileSync(f, String(n)); }
  try { fs.appendFileSync(path.join(process.env.FAKE_STATE_DIR || '/tmp', 'claude-review-prompts.log'), `=====PROMPT kind=${isSession ? 'session' : 'other'} n=${n}=====\n${stdin}\n`); } catch {}
  const findings = isSession && n <= Number(process.env.FAKE_FINDINGS_FOR || 2);
  // round 2 speaks about known findings by id: FAKE_R2 = resolved | repair_failed | new (default: resolved
  // when the engine asked for verification, else a new finding — the historical shape)
  const isRound2 = /# Round 2 is not round 1 again/.test(stdin);
  // the ids to speak about are the ones the engine asked this round to verify
  const verifySection = (stdin.split('# What this round verifies')[1] || '').split('# Closed by')[0];
  const knownIds = [...new Set((verifySection.match(/\bF-\d{3}\b/g) || []))];
  let text;
  if (isRound2 && knownIds.length) {
    const mode = process.env.FAKE_R2 || (findings ? 'new' : 'resolved');
    if (mode === 'resolved') text = `PASS\n${knownIds.map((id) => `RESOLVED ${id} — re-ran the check; it passes now`).join('\n')}`;
    else if (mode === 'repair_failed') text = `FINDINGS\n${knownIds.map((id) => `REPAIR_FAILED ${id} — re-ran the check; it still fails the same way`).join('\n')}`;
    else text = `FINDINGS\n${knownIds.map((id) => `RESOLVED ${id} — verified`).join('\n')}\n1. [minor] Round ${n} new finding — b.txt\n   A different file has a new problem.\n   Evidence: b.txt line 1\n   Category: defect\n   Recommendation: fix b.txt`;
  } else {
    text = findings ? `1. [major] Round ${n} finding — a.txt\n   The file needs another change.\n   Evidence: a.txt line 1 still reads the old value\n   Category: ${process.env.FAKE_FINDING_CATEGORY || 'defect'}\n   Recommendation: change it again` : 'PASS';
  }
  emit({ type: 'system', subtype: 'init', session_id: 'fake-review-' + n, model: 'fake-model' });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 'fake-review-' + n,
    usage: { input_tokens: 800, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [] } });
  process.exit(0);
}

// ------------------------------------------------- Arbiter (the Director deciding)
// FAKE_ARBITER picks the decision word for every finding (default reviewer_upheld,
// which keeps the historical strictness); FAKE_ARBITER_REQUIRED sets the Required line.
function runArbiter() {
  try { fs.appendFileSync(path.join(process.env.FAKE_STATE_DIR || '/tmp', 'arbiter-prompts.log'), `=====ARBITRATION=====\n${stdin}\n`); } catch {}
  const n = (stdin.match(/^\s*\d+\.\s*\[(major|minor)\]/gm) || []).length || 1;
  const word = process.env.FAKE_ARBITER || 'reviewer_upheld';
  const isFinal = /This is the FINAL decision/.test(stdin);
  // the final decision may use a different word (FAKE_ARBITER_FINAL) — e.g. accept unverified repairs as non_blocking
  const w = isFinal && process.env.FAKE_ARBITER_FINAL ? process.env.FAKE_ARBITER_FINAL : word;
  const blk = w === 'reviewer_upheld' || w === 'different_resolution_required';
  const text = Array.from({ length: n }, (_, i) => `FINDING ${i + 1}: ${w}\nReason: ${w === 'builder_upheld' ? 'the brief line was Director-generated, not a user requirement; the Builder attributed truthfully' : w === 'deferred' || w === 'non_blocking' ? 'valid observation with no acceptance impact for this session' : 'the finding is a real defect against the request'}\nRequired: ${blk ? (process.env.FAKE_ARBITER_REQUIRED || 'the file must hold the corrected content') : 'none'}\nBlocking: ${blk ? 'yes' : 'no'}`).join('\n')
    + (isFinal ? `\nPROCEED: ${blk ? 'no' : 'yes'} — ${blk ? 'a real defect remains' : 'the result is acceptable as it stands'}` : '');
  emit({ type: 'system', subtype: 'init', session_id: 'fake-arbiter', model: 'fake-model' });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, session_id: 'fake-arbiter',
    usage: { input_tokens: 600, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [] } });
  process.exit(0);
}

// The engine hands every CLI its precise logical role (TANDEM_LOGICAL_ROLE) beside
// the tool-grant family (TANDEM_ROLE). The Director's family is "reviewer" (read-only
// tools), so the family alone cannot tell a Director turn from a review.
const LOGICAL = process.env.TANDEM_LOGICAL_ROLE || process.env.TANDEM_ROLE || 'builder';
if (LOGICAL === 'arbiter') runArbiter();
else if (LOGICAL === 'builder_reviewer' || LOGICAL === 'director_reviewer' || LOGICAL === 'reviewer') runReviewer();
else if (isDirector) void runDirector();
else void runBuilder();
