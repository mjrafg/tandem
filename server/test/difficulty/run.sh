#!/bin/bash
# Difficulty tiers, live. Real isolated server, fake CLIs (the Director scripted).
#   1. the Director plans S1 as HARD → its first Builder call runs on the hard tier's Builder,
#      its round-1 review on the hard tier's Reviewer (both recorded with difficulty + source);
#   2. while round 1 is running, the admin changes the HARD Builder tier in Settings →
#      the next Builder request (the repair) runs on the NEW model — nothing was frozen at launch;
#   3. while the repair runs, the Director changes S1's difficulty to EASY →
#      the next request (the round-2 review) runs on the EASY tier's Reviewer;
#   4. every ai_call names the difficulty and which configuration picked its model.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8001}"
mkdir -p "$RR/.work"; DD=$RR/.work/data; STATE=$RR/.work/state; PROJ=$RR/.work/proj
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
# the repair sleeps so the Director's difficulty change lands while it runs
RECIPES='{"RECIPE_BUILD":["echo a > a.txt"],"returned these findings":["sleep 8","echo fixed >> a.txt"]}'
# Difficulty routing is ARCHIVED by default (shared/features.ts). This harness is
# the proof that it still works, so it boots the server with the feature on.
ENV=(TANDEM_DIFFICULTY_ROUTING=1 DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_DIRECTOR_SCRIPT="$RR/dscript.json" FAKE_BUILDER_RECIPES="$RECIPES"
     FAKE_FINDINGS_FOR=1 FAKE_R2=resolved FAKE_CODEX_SLEEP_ON_CALL=1)
boot(){ env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
        for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "boot failed"; exit 1; }
stop(){ { kill -9 "$(cat "$DD/pid")" 2>/dev/null; wait "$(cat "$DD/pid")" 2>/dev/null; } 2>/dev/null; sleep 1; }
q(){ node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
try{ const r=db.prepare(process.argv[2]).get(); console.log(r?Object.values(r)[0]:""); }catch(e){ console.log(""); }' "$DD/tandem.db" "$1"; }
waitfor(){ for i in $(seq 1 "$2"); do v=$(q "$1"); [ -n "$v" ] && [ "$v" != "0" ] && return 0; sleep 0.5; done; return 1; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }

echo "== boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
# tiers: hard → Builder sonnet/high on Claude, Reviewer terra/high on Codex; easy → Builder haiku/low, Reviewer sonnet/low on Claude
R=$(api -X PUT -d '{"difficulty":{"hard":{"builder":{"provider":"claude-code","model":"claude-sonnet-5","effort":"high"},"reviewer":{"provider":"codex","model":"gpt-5.6-terra","effort":"high"}},"easy":{"builder":{"provider":"claude-code","model":"claude-haiku-4-5","effort":"low"},"reviewer":{"provider":"claude-code","model":"claude-sonnet-5","effort":"low"}}}}' "http://127.0.0.1:$PORT/api/settings")
echo "$R" | grep -q '"hard":{"builder":{"provider":"claude-code","model":"claude-sonnet-5"' || { echo "tiers not stored: ${R:0:300}"; stop; exit 1; }
RUN=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { console.log(JSON.parse(process.argv[1]).chat.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }
api -d '{"text":"Build the difficulty demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null
SESS="SELECT chat_id FROM pd_sessions WHERE key='S1' AND chat_id IS NOT NULL"
waitfor "$SESS" 120 || { echo "session never launched"; stop; exit 1; }
SCHAT=$(q "$SESS")

# window 1: round-1 review running (the fake reviewer sleeps 20s) → change the HARD Builder tier
waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"builder_reviewer\"%'" 120 || { echo "round 1 never started"; stop; exit 1; }
echo "== round 1 running: changing the HARD Builder tier to claude-haiku-4-5 / medium"
api -X PUT -d '{"difficulty":{"hard":{"builder":{"provider":"claude-code","model":"claude-haiku-4-5","effort":"medium"}}}}' "http://127.0.0.1:$PORT/api/settings" >/dev/null

# window 2: the repair Builder turn running (sleeps 8s) → the Director changes S1 to EASY
waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"builder\"%'" 120 >/dev/null
waitfor "SELECT COUNT(*)-1 FROM events WHERE chat_id='$SCHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"builder\"%'" 120 || { echo "repair turn never started"; stop; exit 1; }
echo "== repair running: the Director sets S1 difficulty to EASY"
TOOL=$(curl -s -H 'content-type: application/json' -d "{\"token\":\"devtoken\",\"chatId\":\"$PCHAT\",\"op\":\"set_session_difficulty\",\"args\":{\"key\":\"S1\",\"difficulty\":\"easy\",\"reasoning\":\"turned out to be a one-liner\"}}" "http://127.0.0.1:$PORT/api/internal/director")
echo "== tool: ${TOOL:0:200}"
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1' AND status='completed'" 150 || echo "(S1 did not complete in time)"
sleep 2

node - "$DD/tandem.db" "$PCHAT" "$SCHAT" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const [dbPath, pchat, schat]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const rows=db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(schat).map(r=>({...r,p:JSON.parse(r.payload)}));
const calls=rows.filter(r=>r.kind==='ai_call');
const builders=calls.filter(c=>c.p.role==='builder'), reviewers=calls.filter(c=>c.p.role==='builder_reviewer');
const model=(c)=>((c.p.cli?.command||'').match(/(?:--model|-m) (\S+)/)||[])[1];
const s1=db.prepare("SELECT status, difficulty FROM pd_sessions WHERE key='S1'").get();
const acts=db.prepare("SELECT text FROM pd_activity ORDER BY ts").all().map(a=>a.text);
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+d:''}`); };
console.log(`   S1=${s1?.status}/${s1?.difficulty}`);
for (const c of calls) console.log(`   ${c.seq} ${c.p.role.padEnd(16)} ${c.p.provider.padEnd(11)} model=${model(c)} effort=${c.p.effort} difficulty=${c.p.difficulty} source=${c.p.modelSource}`);
check('1. S1 was planned HARD and its first Builder call ran on the hard tier (claude-sonnet-5 / high, source difficulty)', builders[0] && model(builders[0])==='claude-sonnet-5' && builders[0].p.effort==='high' && builders[0].p.difficulty==='hard' && builders[0].p.modelSource==='difficulty');
check('   round 1 ran on the hard tier\'s Reviewer (codex gpt-5.6-terra / high)', reviewers[0] && reviewers[0].p.provider==='codex' && model(reviewers[0])==='gpt-5.6-terra' && reviewers[0].p.effort==='high' && reviewers[0].p.difficulty==='hard' && reviewers[0].p.modelSource==='difficulty');
check('2. after the Settings change mid-round-1, the repair Builder call ran on the NEW hard tier (claude-haiku-4-5 / medium)', builders[1] && model(builders[1])==='claude-haiku-4-5' && builders[1].p.effort==='medium' && builders[1].p.difficulty==='hard', builders[1] && `${model(builders[1])}/${builders[1].p.effort}/${builders[1].p.difficulty}`);
check('3. after the Director set S1 to EASY mid-repair, round 2 ran on the EASY tier\'s Reviewer (claude-code claude-sonnet-5 / low)', reviewers[1] && reviewers[1].p.provider==='claude-code' && model(reviewers[1])==='claude-sonnet-5' && reviewers[1].p.effort==='low' && reviewers[1].p.difficulty==='easy' && reviewers[1].p.modelSource==='difficulty', reviewers[1] && `${reviewers[1].p.provider}/${model(reviewers[1])}/${reviewers[1].p.effort}/${reviewers[1].p.difficulty}`);
check('   the in-flight repair kept the model it started with (haiku), only later requests moved', builders[1] && model(builders[1])==='claude-haiku-4-5');
check('   the difficulty change is recorded as a project decision and announced in the session chat', acts.some(a=>/^S1 difficulty hard → easy/.test(a)) && rows.some(r=>r.kind==='status'&&/reassessed this session's difficulty: hard → easy/.test(r.p.text||'')));
check('   the session row shows the current difficulty', s1?.difficulty==='easy');
check('4. every Builder / Builder Reviewer call names its difficulty and the source of its model', [...builders, ...reviewers].every(c=>c.p.difficulty && c.p.modelSource));
check('   the session completed', s1?.status==='completed');
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "ALL DIFFICULTY CHECKS PASSED"; else echo "DIFFICULTY CHECKS FAILED"; fi
exit $RC
