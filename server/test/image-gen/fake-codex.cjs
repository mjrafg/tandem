#!/usr/bin/env node
// Stands in for `codex exec --json …` with the built-in image tool: writes an
// image where the real CLI does ($CODEX_HOME/generated_images/<thread>/) and
// prints the JSON events Tandem reads. FAKE_CODEX_MODE: ok | noimage | fail.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const mode = fs.existsSync(process.env.FAKE_CODEX_MODE_FILE) ? fs.readFileSync(process.env.FAKE_CODEX_MODE_FILE, 'utf8').trim() : 'ok';
const thread = `thr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });
if (mode === 'fail') { out({ type: 'error', message: 'usage limit reached' }); out({ type: 'turn.failed', error: { message: 'usage limit reached' } }); process.exit(1); }
if (mode === 'ok') {
  const dir = path.join(process.env.CODEX_HOME, 'generated_images', thread);
  fs.mkdirSync(dir, { recursive: true });
  // a real 1x1 PNG; the prompt rides after IEND (readers ignore it) so
  // different requests produce different bytes, as a real generator would
  fs.writeFileSync(path.join(dir, 'exec-1.png'), Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    Buffer.from(args.at(-1) || ''),
  ]));
}
out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: mode === 'noimage' ? 'I cannot generate that image.' : 'Done.' } });
out({ type: 'turn.completed', usage: {} });
