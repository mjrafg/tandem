#!/usr/bin/env node
// Fake Codex Reviewer, second generation:
//  - session reviews (prompt carries "# The user's original request") are counted per state dir;
//    the first FAKE_FINDINGS_FOR (default 2) return FINDINGS, later ones PASS
//  - plan / recovery reviews always PASS
//  - FAKE_CODEX_SLEEP_ON_CALL=n : session-review call n sleeps 20s (a crash window)
//  - FAKE_CODEX_QUOTA_ON_CALL=n : session-review call n fails like a usage limit (retry named in 1 min)
//  - FAKE_CODEX_CRASH_ON_CALL=n : session-review call n dies with a generic, NON-outage error
//    (the path where the Reviewer simply failed — it must never be read as an approval)
//  - every prompt is appended to $FAKE_STATE_DIR/codex-prompts.log with its ordinal
//  - as a BUILDER (TANDEM_ROLE=builder, provider-switch tests): runs the same scripted recipe
//    fake-claude does, and honors `exec resume <thread>` by continuing that thread id
//  - every invocation's argv is appended to $FAKE_STATE_DIR/codex-argv.log
const fs = require('fs'); const path = require('path');
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const dir = process.env.FAKE_STATE_DIR || '/tmp';
const argv = process.argv.slice(2);
try { fs.appendFileSync(path.join(dir, 'codex-argv.log'), JSON.stringify({ argv, role: process.env.TANDEM_ROLE ?? null }) + '\n'); } catch {}
// exactly as codex 0.155 behaves: `exec resume` accepts -m/-c/--json/--skip-git-repo-check
// but rejects the exec-level options after the subcommand
{
  const ri = argv.indexOf('resume');
  if (ri >= 0) {
    const after = argv.slice(ri + 1);
    const bad = after.find((a) => ['-p', '--profile', '--approve-for-me', '-s', '--sandbox'].includes(a));
    if (bad) { process.stderr.write(`error: unexpected argument '${bad}' found\n\nUsage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n`); process.exit(2); }
  }
}
const emitB = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (process.env.TANDEM_ROLE === 'builder' || process.env.TANDEM_ROLE === 'final_repair') {
  // `codex exec resume <id> …` continues a thread; anything else starts one
  const ri = argv.indexOf('resume');
  const thread = ri >= 0 && argv[ri + 1] ? argv[ri + 1] : 'codex-thread-' + (process.env.TANDEM_CHAT_ID || '0000').slice(0, 8);
  const cwd = process.cwd();
  const recipes = {};
  try { Object.assign(recipes, JSON.parse(process.env.FAKE_BUILDER_RECIPES || '{}')); } catch {}
  // the marker that appears LAST wins: a fresh session is seeded with the
  // chat's earlier requests, and the new request comes after them
  let did = 'no-op'; let at = -1;
  for (const marker of Object.keys(recipes)) {
    const i = stdin.lastIndexOf(marker);
    if (i > at) { at = i; did = marker; }
  }
  for (const cmd of (recipes[did] ?? [])) { try { require('child_process').execSync(cmd, { cwd, stdio: 'pipe', env: process.env }); } catch {} }
  emitB({ type: 'thread.started', thread_id: thread }); emitB({ type: 'turn.started' });
  emitB({ type: 'item.completed', item: { type: 'agent_message', text: `Session work done by codex (${did}).` } });
  emitB({ type: 'turn.completed', usage: { input_tokens: 700, output_tokens: 40, reasoning_output_tokens: 0 } });
  process.exit(0);
}
const isSession = stdin.includes("# The user's original request");
let n = 0;
if (isSession) { const f = path.join(dir, 'session-review-count'); try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {} n += 1; fs.writeFileSync(f, String(n)); }
try { fs.appendFileSync(path.join(dir, 'codex-prompts.log'), `=====PROMPT kind=${isSession ? 'session' : 'other'} n=${n}=====\n${stdin}\n`); } catch {}
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (isSession && String(n) === String(process.env.FAKE_CODEX_QUOTA_ON_CALL || '')) {
  process.stderr.write('You have hit your usage limit. Try again in 1 minute.\n');
  process.exit(1);
}
if (isSession && String(n) === String(process.env.FAKE_CODEX_CRASH_ON_CALL || '')) {
  process.stderr.write('codex: fatal: unexpected internal error while starting the session\n');
  process.exit(3);
}
if (isSession && String(n) === String(process.env.FAKE_CODEX_SLEEP_ON_CALL || '')) {
  const until = Date.now() + 20_000; while (Date.now() < until) { require('child_process').execSync('sleep 1'); }
}
const findings = isSession && n <= Number(process.env.FAKE_FINDINGS_FOR || 2);
emit({ type: 'thread.started', thread_id: 't-' + n }); emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { type: 'agent_message', text: findings ? `1. [major] Round ${n} finding — a.txt\n   The file needs another change.\n   Recommendation: change it again` : 'PASS' } });
emit({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 20, reasoning_output_tokens: 0 } });
