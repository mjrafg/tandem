#!/bin/bash
# Review is intentional, per session — decided by the Director, separate from difficulty, live.
#   S1 (hard, review WAIVED)  → completes with NO reviewer call; verdict "waived"; the Director's outcome says so
#   S2 (easy, review REQUIRED) → reviewed as usual
#   then the Director REQUIRES a review of the completed S1 → a round-1 review runs on the result as it stands → PASS
# Real isolated server, fake CLIs (the Director scripted).
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8002}"
mkdir -p "$RR/.work"; DD=$RR/.work/data; STATE=$RR/.work/state; PROJ=$RR/.work/proj
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

echo "== boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
RUN=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { console.log(JSON.parse(process.argv[1]).chat.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }
api -d '{"text":"Build the review decision demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE status='completed'" 150 >/dev/null
waitfor "SELECT COUNT(*)-1 FROM pd_sessions WHERE status='completed'" 150 || echo "(both sessions did not complete in time)"
# wait for the Director's completion observations to be delivered
waitfor "SELECT COUNT(*)-1 FROM events WHERE chat_id='$PCHAT' AND kind='ai_call' AND payload LIKE '%COMPLETED%'" 60 >/dev/null
echo "== both completed: the Director now REQUIRES a review of S1 after the fact"
TOOL=$(curl -s -H 'content-type: application/json' -d "{\"token\":\"devtoken\",\"chatId\":\"$PCHAT\",\"op\":\"set_session_review\",\"args\":{\"key\":\"S1\",\"review_required\":true,\"reasoning\":\"the file feeds the deploy script; worth an independent look\"}}" "http://127.0.0.1:$PORT/api/internal/director")
echo "== tool: ${TOOL:0:200}"
S1CHAT=$(q "SELECT chat_id FROM pd_sessions WHERE key='S1'")
waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$S1CHAT' AND kind='findings'" 90 || echo "(the requested review never ran)"
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1' AND status='completed' AND review_verdict='pass'" 60 >/dev/null
sleep 2

node - "$DD/tandem.db" "$PCHAT" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const [dbPath, pchat]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const sess=(k)=>db.prepare("SELECT * FROM pd_sessions WHERE key=?").get(k);
const s1=sess('S1'), s2=sess('S2');
const ev=(chat)=>db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(chat).map(r=>({...r,p:JSON.parse(r.payload)}));
const e1=ev(s1.chat_id), e2=ev(s2.chat_id), ep=ev(pchat);
const reviewers=(rows)=>rows.filter(r=>r.kind==='ai_call'&&r.p.role==='builder_reviewer');
const acts=db.prepare("SELECT text FROM pd_activity ORDER BY ts").all().map(a=>a.text);
const obsS1=ep.filter(r=>r.kind==='ai_call'&&r.p.role==='director').map(r=>r.p.request?.prompt||'').find(t=>/Session S1 COMPLETED/.test(t))||'';
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+d:''}`); };
console.log(`   S1 ${s1.status}/${s1.review_verdict} review_required=${s1.review_required} difficulty=${s1.difficulty} reviewer calls=${reviewers(e1).length}`);
console.log(`   S2 ${s2.status}/${s2.review_verdict} review_required=${s2.review_required} difficulty=${s2.difficulty} reviewer calls=${reviewers(e2).length}`);
// the first pass: S1 waived, S2 reviewed
const s1FirstRun=e1.filter(r=>r.kind==='run'&&r.p.phase==='finished')[0];
const s1FirstReviewers=reviewers(e1).filter(r=>r.seq<(s1FirstRun?.seq??Infinity));
check('S1 (hard, review waived) completed its first run with NO reviewer call', s1FirstReviewers.length===0 && !!s1FirstRun);
check('   the waiver is recorded in the session chat and as the standing verdict at that point', e1.some(r=>r.kind==='status'&&/Independent review waived by the Project Director/.test(r.p.text||'')) && /Review WAIVED by your decision/.test(obsS1));
check('   the Director\'s outcome for S1 said so explicitly, not "no verdict"', /FINAL STATE: REVIEW WAIVED/.test(obsS1));
check('   the planning decision recorded the waiver next to the difficulty (hard, review waived)', acts.some(a=>/S1: hard, review waived/.test(a)));
check('S2 (easy, review required) was reviewed as usual — difficulty did not decide review', reviewers(e2).length>=1 && s2.review_verdict==='pass' && s2.difficulty==='easy');
// the change of mind: a review after the fact
check('set_session_review on the completed S1 recorded the decision', acts.some(a=>/^S1: independent review now REQUIRED \(it had completed with its review waived\)/.test(a)));
check('   a round-1 review then ran on S1\'s result as it stands', reviewers(e1).length===1 && e1.some(r=>r.kind==='findings'&&r.p.round===1));
check('   S1 is completed again with a real verdict (pass) and review_required=1', s1.status==='completed' && s1.review_verdict==='pass' && s1.review_required===1);
check('   no pending review is left behind', db.prepare("SELECT COUNT(*) c FROM pending_reviews").get().c===0);
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "ALL REVIEW-DECISION CHECKS PASSED"; else echo "REVIEW-DECISION CHECKS FAILED"; fi
exit $RC
