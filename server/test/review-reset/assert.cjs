// Judge one scenario against the desired invariants (second generation). Exit 1 on any failure.
const fs = require('fs');
const D = require(require('path').join(__dirname, '..', '..', '..', 'node_modules', 'better-sqlite3'));
const [dbPath, stateDir, scenario, schat, projDir] = process.argv.slice(2);
const db = new D(dbPath, { readonly: true });
const CANON = 'CANONICAL_TASK_MARKER_7731';
const rows = db.prepare("SELECT seq,run_id,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(schat).map(r => ({ ...r, p: JSON.parse(r.payload) }));
const findings = rows.filter(r => r.kind === 'findings').map(r => ({ seq: r.seq, run: r.run_id.slice(0, 8), ...r.p }));
const calls = rows.filter(r => r.kind === 'ai_call');
const reviewerCalls = calls.filter(r => r.p.role === 'reviewer' || r.p.role === 'builder_reviewer').length;
const runs = [...new Set(rows.filter(r => r.run_id).map(r => r.run_id))];
const status = db.prepare("SELECT status FROM pd_sessions WHERE chat_id=?").get(schat).status;
const pending = (() => { try { return db.prepare("SELECT COUNT(*) c FROM pending_reviews WHERE chat_id=?").get(schat).c; } catch { return 0; } })();
let ledger = null; try { ledger = db.prepare("SELECT * FROM review_ledger WHERE chat_id=?").get(schat); } catch {}
const log = (() => { try { return fs.readFileSync(`${stateDir}/codex-prompts.log`, 'utf8'); } catch { return ''; } })();
const prompts = log.split(/=====PROMPT kind=session n=\d+=====\n/).slice(1);
const original = prompts.map(p => (/# The user's original request\n([^\n]*)/.exec(p) || [, ''])[1]);
const steering = prompts.map(p => { const m = /# Later instructions in this session[^\n]*\n(?:[^\n]*\n)?([^\n]*)/.exec(p); return m ? m[1] : null; });
const argv = (() => { try { return fs.readFileSync(`${stateDir}/claude-argv.log`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
// I11 — every Claude CLI call carried Tandem's compaction ceiling as the CLI's own auto-compact window (mid-run compaction)
const noWindow = argv.filter((l) => l && typeof l === 'object' && !Array.isArray(l) && l.autoCompactWindow !== '200000' && !(l.argv || []).some((x) => x === '/context' || x === '/compact'));
const continuationBuilders = calls.filter(r => r.p.role === 'builder' && rows.some(u => u.kind === 'user_message' && u.seq < r.seq && /interrupted/.test(u.p.text || '') && !rows.some(v => v.kind === 'user_message' && v.seq > u.seq && v.seq < r.seq)));

console.log(`\n=========== ${scenario} ===========`);
console.log(`runs: ${runs.length}   reviewer calls: ${reviewerCalls}   final status: ${status}   pending reviews left: ${pending}`);
for (const f of findings) console.log(`  findings seq=${String(f.seq).padStart(4)} run=${f.run}  round ${f.round}  ${f.verdict}${f.finalRepairNotReviewed ? '  [final repair not reviewed]' : ''}`);
console.log(`  ledger: ${ledger ? JSON.stringify({ reviews_consumed: ledger.reviews_consumed, repairs: ledger.repairs_consumed, last_verdict: ledger.last_verdict, final_repair_done: ledger.final_repair_done }) : '(no review_ledger row)'}`);
prompts.forEach((_, i) => console.log(`  reviewer prompt #${i + 1}: original = ${JSON.stringify(original[i].slice(0, 60))}${steering[i] != null ? `  |  steering = ${JSON.stringify(steering[i].slice(0, 44))}` : ''}`));

const fails = [];
// I1 — round numbers strictly increase within the task (never 1,1 / 2,1)
for (let i = 1; i < findings.length; i++) if (findings[i].round <= findings[i - 1].round) fails.push(`I1 round ${findings[i].round} (seq ${findings[i].seq}) after round ${findings[i - 1].round}: the budget restarted`);
// I2 — never more than the cap, in events or in the ledger
if (findings.length > 2) fails.push(`I2 ${findings.length} reviews recorded for one task (cap 2)`);
if (ledger && ledger.reviews_consumed > 2) fails.push(`I2 ledger reviews_consumed=${ledger.reviews_consumed} > 2`);
// I3 — every Reviewer saw the canonical request, never the recovery text
// An INTEGRATION session is a different task by design: its original request is
// the integration contract, not the session's. Judge only the session's own.
const INTEGRATION = /^This is a milestone INTEGRATION session/;
original.forEach((o, i) => { if (INTEGRATION.test(o)) return;
                             if (!o.includes(CANON)) fails.push(`I3 prompt #${i + 1} original request is not the canonical task: ${JSON.stringify(o.slice(0, 60))}`);
                              if (/interrupted|Continue exactly/i.test(o)) fails.push(`I3 prompt #${i + 1} original request IS the recovery message`); });
// I4 — a review of a continuation carries the continuation as steering, not as the request
if (['AFTER_R1', 'DURING_R2'].includes(scenario) && !steering.some(s => s && /interrupted/i.test(s))) fails.push('I4 no reviewer prompt carried the continuation as steering context');
// I5 — the task still finished, and no wait was left dangling
if (status !== 'completed') fails.push(`I5 session status is ${status}, not completed`);
if (pending > 0) fails.push(`I5 a pending review was left behind`);
// I6 — Builder continuity: every continuation builder call resumed the provider session
for (const c of continuationBuilders) if (!/--resume/.test(String(c.p.cli?.command || ''))) fails.push(`I6 continuation builder (seq ${c.seq}) did not --resume the session`);
// I7 — quota scenario: exactly one round-2 verdict, reached by a retry of the SAME round
if (['QUOTA_R2', 'QUOTA_CRASH_FINAL', 'QUOTA_WAIT_RESTART'].includes(scenario)) { const r2 = findings.filter(f => f.round === 2); if (r2.length !== 1) fails.push(`I7 expected exactly one round-2 verdict after the quota retry, got ${r2.length}`); }
// I8 — the checkpoint commit names the task, never the recovery message (finishGitRun)
const commits = (() => { try { return require('child_process').execFileSync('git', ['--no-optional-locks', '-C', projDir, 'log', '--all', '--format=%h %s'], { encoding: 'utf8' }).split('\n').filter(l => / tandem: /.test(l)); } catch (e) { return []; } })();
commits.forEach((c) => { if (/tandem: This is a milestone INTEGRATION session/.test(c)) return; // the integration session's own task
                         if (/interrupted|Continue exactly/i.test(c)) fails.push(`I8 checkpoint commit carries the recovery message: ${JSON.stringify(c.slice(0, 80))}`);
                         if (!/tandem: RECIPE_BUILD Implement the feature/.test(c)) fails.push(`I8 checkpoint commit does not name the task: ${JSON.stringify(c.slice(0, 80))}`); });
console.log(`  checkpoint commits: ${commits.length ? commits.map(c => JSON.stringify(c.slice(0, 70))).join(' ; ') : '(none)'}`);
// I9 — a completed review records the revision it accepted, so a replay can be deduplicated
if (findings.length > 0 && (!ledger || !ledger.reviewed_revision)) fails.push('I9 ledger has no reviewed_revision after a review');
// I10 — an overload is a wait, not a failure: the wake was persisted and consumed, the session was never failed
if (scenario.startsWith('OVERLOAD')) {
  const runId = db.prepare("SELECT run_id FROM pd_sessions WHERE chat_id=?").get(schat).run_id;
  const acts = db.prepare("SELECT text FROM pd_activity WHERE run_id=? ORDER BY ts").all(runId).map((a) => a.text);
  const wakesLeft = db.prepare("SELECT COUNT(*) c FROM pending_wakes WHERE run_id=?").get(runId).c;
  const expect = scenario === 'OVERLOAD_BUILDER' ? /S1\.1 hit the Claude overload — work preserved/ : /Claude overload — work is preserved; the Director picks this up again/;
  if (!acts.some((t) => expect.test(t))) fails.push(`I10 no activity line recorded the overload as a wait (${expect})`);
  if (acts.some((t) => /^S1\.1 failed/.test(t))) fails.push('I10 the overload was recorded as a session FAILURE');
  if (wakesLeft > 0) fails.push('I10 a pending wake was left behind');
  console.log(`  overload activity: ${acts.filter((t) => /overload/i.test(t)).map((t) => JSON.stringify(t.slice(0, 90))).join(' ; ') || '(none)'}`);
}
if (noWindow.length > 0) fails.push(`I11 ${noWindow.length} Claude CLI call(s) ran without CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`);

// I12 — the loop is bounded: review 1 → Builder response → review 2 → ONE final
// Builder pass → the Director's final decision. Never a third review, never a
// final pass before round 2, and a round-2 findings verdict is always followed
// by the Director's final decision (recorded as an arbitration event).
const arbitrations = rows.filter((r) => r.kind === 'arbitration').map((r) => ({ seq: r.seq, ...r.p }));
const dispositions = rows.filter((r) => r.kind === 'finding_dispositions').map((r) => ({ seq: r.seq, ...r.p }));
const finalPasses = dispositions.filter((d) => d.final);
if (finalPasses.length > 1) fails.push(`I12 ${finalPasses.length} final Builder passes ran (at most one)`);
const r2 = findings.find((f) => f.round === 2);
for (const fp of finalPasses) if (!r2 || fp.seq < r2.seq) fails.push(`I12 a final Builder pass (seq ${fp.seq}) ran before round 2`);
const capped = findings.filter((f) => f.round === 2 && f.verdict === 'findings');
for (const f of capped) {
  if (!arbitrations.some((a) => a.final && a.seq > f.seq)) fails.push(`I12 round-2 findings (seq ${f.seq}) were not followed by the Director's final decision`);
  if (rows.some((r) => r.kind === 'ai_call' && (r.p.role === 'reviewer' || r.p.role === 'builder_reviewer') && r.seq > f.seq)) fails.push('I12 a third Reviewer call ran after round 2');
}
// I13 — a findings verdict is never reported as a PASS; after the Director's
// final decision the ledger says `findings` (something blocks) or `resolved`
// (nothing blocks) — never `pass`
if (capped.length > 0 && ledger && !['findings', 'resolved'].includes(ledger.last_verdict)) {
  fails.push(`I13 ledger last_verdict is ${ledger.last_verdict} after a round-2 findings verdict`);
}
const lastArb = arbitrations.filter((a) => a.final).slice(-1)[0];
if (lastArb && ledger) {
  const blocking = (lastArb.items || []).some((a) => a.blocking);
  if (blocking && ledger.last_verdict !== 'findings') fails.push(`I13 the Director judged a finding blocking but the ledger says ${ledger.last_verdict}`);
  if (!blocking && ledger.last_verdict !== 'resolved') fails.push(`I13 nothing blocks but the ledger says ${ledger.last_verdict}`);
}
// I14 — a finding keeps one identity: round 2 never re-raises a round-1 title as a new finding
const r1Titles = (findings.find((f) => f.round === 1)?.items || []).map((i) => i.title.toLowerCase());
for (const it of (r2?.items || [])) if (r1Titles.includes(it.title.toLowerCase())) fails.push(`I14 round 2 re-raised "${it.title}" as a new finding instead of updating it`);
console.log(fails.length ? `\nFAIL\n  - ${fails.join('\n  - ')}` : '\nPASS — all invariants hold');
process.exit(fails.length ? 1 : 0);
