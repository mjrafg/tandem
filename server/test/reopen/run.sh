#!/bin/bash
# A finished project can be taken up again without losing what it already did.
#   build M1 → complete it → complete the PROJECT → (the guard refuses changes)
#   → reopen_project → add M2 beside the untouched M1 → run it → complete again
# Real isolated server, fake CLIs. The lifecycle is driven through the internal
# Director API so the assertions do not depend on a model's turn alignment.
#   run.sh KEPT     the integration branch still exists when the project reopens
#   run.sh DELETED  a delivery session merged and deleted it, as usually happens
set -u
SCENARIO="${1:-KEPT}"
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8004}"
[ "$SCENARIO" = DELETED ] && PORT=8005
mkdir -p "$RR/.work"; DD=$RR/.work/data-$SCENARIO; STATE=$RR/.work/state-$SCENARIO; PROJ=$RR/.work/proj-$SCENARIO
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
RECIPES='{"RECIPE_BUILD":["echo a > a.txt"],"RECIPE_TWO":["echo b > b.txt"]}'
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_DIRECTOR_SCRIPT="$RR/dscript.json" FAKE_BUILDER_RECIPES="$RECIPES" FAKE_FINDINGS_FOR=0)
boot(){ env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
        for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "boot failed"; exit 1; }
stop(){ { kill -9 "$(cat "$DD/pid")" 2>/dev/null; wait "$(cat "$DD/pid")" 2>/dev/null; } 2>/dev/null; sleep 1; }
q(){ node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
try{ const r=db.prepare(process.argv[2]).get(); console.log(r?Object.values(r)[0]:""); }catch(e){ console.log(""); }' "$DD/tandem.db" "$1"; }
waitfor(){ for i in $(seq 1 "$2"); do v=$(q "$1"); [ -n "$v" ] && [ "$v" != "0" ] && return 0; sleep 1; done; return 1; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
dir(){ curl -s -H 'content-type: application/json' -d "{\"token\":\"devtoken\",\"chatId\":\"$PCHAT\",\"op\":\"$1\",\"args\":$2}" "http://127.0.0.1:$PORT/api/internal/director"; }

echo "== boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
RUN=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { console.log(JSON.parse(process.argv[1]).chat.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }

echo "== build and finish the project"
api -d '{"text":"Build the reopen demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1' AND status='completed'" 150 || echo "(S1 did not complete)"
S1CHAT=$(q "SELECT chat_id FROM pd_sessions WHERE key='S1'")
S1EVENTS=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$S1CHAT'")
R_CM1=$(dir complete_milestone '{"milestone":"M1"}')
R_DEL1=$(dir deliver '{}')
R_CP1=$(dir complete_project '{"summary":"first delivery"}')
echo "   m1=${R_CM1:0:60} deliver=${R_DEL1:0:60} complete=${R_CP1:0:80}"
waitfor "SELECT COUNT(*) FROM project_runs WHERE state='COMPLETED'" 30 || echo "(project did not complete)"

# the real user path: a message to a finished project must still reach the
# Director, or it could never decide to reopen anything
DIRCALLS_BEFORE=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$PCHAT' AND kind='ai_call'")
api -d '{"text":"I found a bug in what you delivered, and I want b.txt added."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null
for i in $(seq 1 60); do
  now=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$PCHAT' AND kind='ai_call'")
  [ "$now" -gt "$DIRCALLS_BEFORE" ] && break; sleep 1
done
DIRCALLS_AFTER=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$PCHAT' AND kind='ai_call'")

if [ "$SCENARIO" = DELETED ]; then
  # what a delivery session normally leaves behind: the work is on the base
  # branch and the integration branch is gone, while the run still records it
  ( cd "$PROJ" && git branch -D pd/integration >/dev/null 2>&1 )
  echo "   deleted pd/integration; run still records: $(q "SELECT integration_branch FROM project_runs")"
fi

echo "== a finished project refuses changes, then is reopened"
R_GUARD=$(dir start_sessions '{"keys":["S1"]}')
R_NOREASON=$(dir reopen_project '{}')
R_REOPEN=$(dir reopen_project '{"reason":"the user found a bug: a.txt has the wrong contents, and wants b.txt added"}')
R_TWICE=$(dir reopen_project '{"reason":"already open"}')

echo "== new work in the SAME project"
R_PLAN2=$(dir set_plan '{"title":"Reopen Demo","summary":"M1 delivered; M2 is the follow-up.","milestones":[{"key":"M1","name":"First feature","goal":"Create a.txt","acceptance":"a.txt exists"},{"key":"M2","name":"Follow-up","goal":"Create b.txt","acceptance":"b.txt exists","depends_on":["M1"]}]}')
R_SESS2=$(dir plan_sessions '{"milestone":"M2","reasoning":"one session for the follow-up","sessions":[{"key":"S2","name":"Build b","purpose":"create b.txt","review_required":false,"prompt":"RECIPE_TWO Implement the follow-up: create b.txt. CANONICAL_TASK_MARKER_7731"}]}')
R_START2=$(dir start_sessions '{"keys":["S2"]}')
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S2' AND status='completed'" 150 || echo "(S2 did not complete)"
R_CM2=$(dir complete_milestone '{"milestone":"M2"}')
R_DEL2=$(dir deliver '{}')
R_CP2=$(dir complete_project '{"summary":"follow-up delivered"}')
waitfor "SELECT COUNT(*) FROM project_runs WHERE state='COMPLETED'" 30 || echo "(project did not re-complete)"
sleep 1

BRANCH_AFTER=$(q "SELECT COALESCE(integration_branch,'(cleared)') FROM project_runs")
node - "$DD/tandem.db" "$PCHAT" "$S1CHAT" "$S1EVENTS" "$R_GUARD" "$R_NOREASON" "$R_REOPEN" "$R_TWICE" "$R_PLAN2" "$R_CP2" "$SCENARIO" "$BRANCH_AFTER" "$DIRCALLS_BEFORE" "$DIRCALLS_AFTER" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const [dbPath,pchat,s1chat,s1events,rGuard,rNoReason,rReopen,rTwice,rPlan2,rCp2,scenario,branchAfter,dirBefore,dirAfter]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const run=db.prepare("SELECT * FROM project_runs").get();
const ms=(k)=>db.prepare("SELECT * FROM pd_milestones WHERE key=?").get(k);
const se=(k)=>db.prepare("SELECT * FROM pd_sessions WHERE key=?").get(k);
const acts=db.prepare("SELECT kind,text FROM pd_activity WHERE run_id=? ORDER BY ts").all(run.id);
const pev=db.prepare("SELECT kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(pchat).map(r=>({...r,p:JSON.parse(r.payload)}));
const j=(s)=>{ try { return JSON.parse(s); } catch { return {}; } };
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+String(d).slice(0,200):''}`); };
const m1=ms('M1'), m2=ms('M2'), s1=se('S1'), s2=se('S2');
console.log(`   run=${run.state} | M1=${m1?.status} M2=${m2?.status} | S1=${s1?.status} S2=${s2?.status}`);

check('a user message to a finished project still reaches the Director', Number(dirAfter)>Number(dirBefore), `${dirBefore} → ${dirAfter}`);

// the guard
check('a finished project refuses a change', j(rGuard).ok===false, rGuard);
check('   and the refusal points at reopen_project, not at starting a second project',
  /reopen_project/.test(j(rGuard).error||'') && !/new project run/i.test(j(rGuard).error||''), j(rGuard).error);
check('reopening without a reason is refused', j(rNoReason).ok===false && /why/i.test(j(rNoReason).error||''), rNoReason);
check('reopening a project that is already open is refused', j(rTwice).ok===false && /already open/i.test(j(rTwice).error||''), rTwice);

// the reopen itself
check('reopen_project succeeded', j(rReopen).ok===true, rReopen);
check('   it told the Director the completed milestones stand', /M1/.test(j(rReopen).text||'') && /not to be redone/.test(j(rReopen).text||''), j(rReopen).text);
check('   it is recorded as project history with the reason', acts.some(a=>/Project reopened \(it was COMPLETED\)/.test(a.text) && /found a bug/.test(a.text)), JSON.stringify(acts.map(a=>a.text.slice(0,60))));
check('   the user was told in the project chat', pev.some(e=>e.kind==='status' && /reopened this project/.test(e.p.text||'')));

// nothing from before was lost or rewritten
check('M1 is still completed and was not redone', m1?.status==='completed');
check('S1 is still completed, on the same chat, with its history intact',
  s1?.status==='completed' && s1?.chat_id===s1chat && db.prepare("SELECT COUNT(*) c FROM events WHERE chat_id=?").get(s1chat).c>=Number(s1events));
check('the first completion is still in the project history', acts.some(a=>/Project completed: first delivery/.test(a.text)));
check('re-planning kept M1 untouched and added M2', j(rPlan2).ok===true && !!m2, rPlan2);

// the new work ran and the project finished again
check('S2 ran in the SAME project run', s2?.status==='completed' && se('S2') && db.prepare("SELECT COUNT(*) c FROM project_runs").get().c===1);
check('M2 completed', m2?.status==='completed');
check('the project completed a second time', j(rCp2).ok===true && run.state==='COMPLETED', rCp2);
check('both milestones are completed in one run', db.prepare("SELECT COUNT(*) c FROM pd_milestones WHERE run_id=? AND status='completed'").get(run.id).c===2);
check('both sessions belong to that run', db.prepare("SELECT COUNT(*) c FROM pd_sessions WHERE run_id=?").get(run.id).c===2);
if (scenario==='DELETED') {
  check('a delivered-and-deleted integration branch was not carried over as a stale ref',
    /was delivered and no longer exists/.test(j(rReopen).text||''), j(rReopen).text);
  check('   and the follow-up work got a fresh integration branch', branchAfter!=='(cleared)');
}
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "[$SCENARIO] ALL REOPEN CHECKS PASSED"; else echo "[$SCENARIO] REOPEN CHECKS FAILED"; fi
exit $RC
