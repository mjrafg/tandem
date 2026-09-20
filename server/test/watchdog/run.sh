#!/bin/bash
# The autonomy watchdog: an active project never sits forever with unfinished
# work, nothing running and nothing scheduled. Real isolated server, fake CLIs.
#   run.sh STANDBY   the Director plans a session but never starts it → the watchdog wakes it → it starts the session
#   run.sh CRASH     the Director's FIRST turn crashes (non-outage) → a "Director failure" wake is persisted and delivered → the project proceeds
#   run.sh GIVEUP    the Director never acts → after stallMaxWakes=2 wakes the project is PAUSED with the reason stated
set -u
SCENARIO="${1:-STANDBY}"
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7998}"
mkdir -p "$RR/.work"; DD=$RR/.work/data-$SCENARIO; STATE=$RR/.work/state-$SCENARIO; PROJ=$RR/.work/proj-$SCENARIO
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
case "$SCENARIO" in
  STANDBY) DS=dscript-standby.json; CRASH= ;;
  CRASH)   DS=dscript-crash.json;   CRASH=1 ;;
  GIVEUP)  DS=dscript-silent.json;  CRASH= ;;
  *) echo "unknown scenario"; exit 1 ;;
esac
RECIPES='{"RECIPE_BUILD":["echo a > a.txt"]}'
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000 TANDEM_STALL_AFTER_MS=6000 TANDEM_DIRECTOR_RETRY_MS=4000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_DIRECTOR_SCRIPT="$RR/$DS" FAKE_BUILDER_RECIPES="$RECIPES" FAKE_FINDINGS_FOR=0
     FAKE_DIRECTOR_CRASH_ON_TURN="$CRASH")
boot(){ env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
        for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "boot failed"; exit 1; }
stop(){ { kill -9 "$(cat "$DD/pid")" 2>/dev/null; wait "$(cat "$DD/pid")" 2>/dev/null; } 2>/dev/null; sleep 1; }
q(){ node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
try{ const r=db.prepare(process.argv[2]).get(); console.log(r?Object.values(r)[0]:""); }catch(e){ console.log(""); }' "$DD/tandem.db" "$1"; }
waitfor(){ for i in $(seq 1 "$2"); do v=$(q "$1"); [ -n "$v" ] && [ "$v" != "0" ] && return 0; sleep 1; done; return 1; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }

echo "== [$SCENARIO] boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
[ "$SCENARIO" = GIVEUP ] && api -X PUT -d '{"orchestration":{"stallAfterMinutes":2,"stallMaxWakes":2}}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
RUN=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { console.log(JSON.parse(process.argv[1]).chat.id) } catch { console.log("") }' "$RUN")
RUNID=$(node -e 'try { console.log(JSON.parse(process.argv[1]).run.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }
api -d '{"text":"Build the watchdog demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null

case "$SCENARIO" in
  STANDBY|CRASH)
    waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1' AND status='completed'" 120 || echo "(S1 did not complete in time)" ;;
  GIVEUP)
    waitfor "SELECT COUNT(*) FROM project_runs WHERE state='PAUSED'" 120 || echo "(run never paused)" ;;
esac
sleep 3
node - "$DD/tandem.db" "$PCHAT" "$SCENARIO" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const [dbPath, pchat, scenario]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const run=db.prepare("SELECT * FROM project_runs").get();
const acts=db.prepare("SELECT ts, kind, text FROM pd_activity WHERE run_id=? ORDER BY ts").all(run.id);
const rows=db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(pchat).map(r=>({...r,p:JSON.parse(r.payload)}));
const dirCalls=rows.filter(r=>r.kind==='ai_call'&&r.p.role==='director');
const s1=db.prepare("SELECT status, difficulty FROM pd_sessions WHERE key='S1'").get();
const wakes=db.prepare("SELECT * FROM pending_wakes").all();
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+d:''}`); };
console.log(`   run=${run.state} stall_streak=${run.stall_streak} | S1=${s1?.status}/${s1?.difficulty} | director calls=${dirCalls.length} (${dirCalls.map(c=>c.p.status).join(',')}) | wakes left=${wakes.length}`);
for (const a of acts) console.log('   ', new Date(a.ts).toISOString().slice(11,19), a.text.slice(0,150));
const progress=acts.filter(a=>/^Progress check \d/.test(a.text));
const stallCall=dirCalls.find(c=>/PROGRESS CHECK/.test(c.p.request?.prompt||''));
if (scenario==='STANDBY') {
  check('the Director\'s first turns started nothing (S1 was started only after the progress check)', progress.length>=1 && acts.findIndex(a=>/^Progress check \d/.test(a.text)) < acts.findIndex(a=>/^S1 Feature started/.test(a.text)));
  check('the watchdog recorded a progress check', progress.length>=1, JSON.stringify(acts.map(a=>a.text.slice(0,60))));
  check('the Director was woken with the PROGRESS CHECK observation naming the unfinished session', !!stallCall && /Unfinished sessions: S1 \[planned\]/.test(stallCall.p.request.prompt));
  check('the woken Director started S1 and it completed', s1?.status==='completed');
  check('progress reset the stall streak', run.stall_streak===0);
  check('the run is still RUNNING (not paused) and no wake is left behind', run.state==='RUNNING' && wakes.length===0);
  check('the session carried its planned difficulty', s1?.difficulty==='easy');
}
if (scenario==='CRASH') {
  check('the first Director call failed (non-outage)', dirCalls[0]?.p.status==='failed');
  check('a "Director failure" wake was recorded and later delivered', acts.some(a=>/^Director failure — work is preserved/.test(a.text)) && acts.some(a=>/Director failure .* — the Director picks the project back up|retrying the failed Director turn/.test(a.text)), JSON.stringify(acts.map(a=>a.text.slice(0,70))));
  check('the retried turn ran the script\'s first step: S1 was planned, started and completed', s1?.status==='completed');
  check('the crashed turn\'s message was re-said, not lost (the retry carried the user\'s brief)', dirCalls.length>=2 && /Build the watchdog demo project/.test(dirCalls[1].p.request.prompt));
  check('the run is RUNNING with no wake left behind', run.state==='RUNNING' && wakes.length===0);
}
if (scenario==='GIVEUP') {
  check('the watchdog woke the Director stallMaxWakes (2) times', progress.length===2, String(progress.length));
  check('each wake produced a Director turn that did nothing', dirCalls.filter(c=>/PROGRESS CHECK/.test(c.p.request?.prompt||'')).length===2);
  check('then the project was PAUSED with the stall stated as the reason', run.state==='PAUSED' && acts.some(a=>/The project stalled: 2 automatic Director wakes produced no progress/.test(a.text)));
  check('the pause note tells the user what to do', acts.some(a=>/press Resume/.test(a.text)));
  check('S1 was never started (no session ran)', s1?.status==='planned');
  check('no further wake is scheduled for a paused project', wakes.length===0);
}
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "[$SCENARIO] ALL WATCHDOG CHECKS PASSED"; else echo "[$SCENARIO] FAILED"; fi
exit $RC
