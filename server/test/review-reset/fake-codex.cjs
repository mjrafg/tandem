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
const fs = require('fs'); const path = require('path');
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const dir = process.env.FAKE_STATE_DIR || '/tmp';
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
