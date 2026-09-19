#!/bin/bash
# A completed session's outcome reaches the Director AUTHORITATIVELY.
#   1. the Builder's hand-off recommends a future check ("Worth re-running: npm test");
#   2. round 1 finds F-001; the Builder repairs it and repeats the recommendation;
#   3. round 2 runs the check, PASSes and records RESOLVED F-001 with evidence;
#   4. the session completes → what the Director is handed must lead with the final
#      verdict and the Reviewer's evidence, and label the hand-off as historical;
#   5. the hand-off text is still in the record; 6. Builder Reviewer and Director
#      Reviewer are labelled by their own role in events and exports.
# Real isolated server, fake CLIs (Director scripted), no model.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7990}"
mkdir -p "$RR/.work"; DD=$RR/.work/data; STATE=$RR/.work/state; PROJ=$RR/.work/proj
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
NOTE='Worth re-running: `npm test` end to end — I changed the test entry point but did not run the suite myself.'
RECIPES='{"RECIPE_BUILD":["echo a > a.txt"],"returned these findings":["echo fixed >> a.txt"]}'
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_DIRECTOR_SCRIPT="$RR/dscript.json" FAKE_BUILDER_RECIPES="$RECIPES"
     FAKE_FINDINGS_FOR=1 FAKE_R2=resolved FAKE_BUILDER_NOTE="$NOTE")
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
# the Builder Reviewer on (fake) Codex, the Director Reviewer on (fake) Claude — two roles, two providers
api -X PUT -d '{"roles":{"builder_reviewer":{"provider":"codex","model":"gpt-5.6-sol","effort":"medium","enabled":true},"director_reviewer":{"provider":"claude-code","model":"claude-sonnet-5","effort":"high"}}}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
RUN=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { console.log(JSON.parse(process.argv[1]).chat.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }
api -d '{"text":"Build the outcome demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages" >/dev/null
SESS="SELECT chat_id FROM pd_sessions WHERE key='S1' AND chat_id IS NOT NULL"
waitfor "$SESS" 60 || { echo "session never launched"; stop; exit 1; }
SCHAT=$(q "$SESS")
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1' AND status='completed'" 150 || { echo "session never completed"; stop; exit 1; }
# the Director's NEXT turn (the observation) — wait for one more director ai_call after completion
waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$PCHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"director\"%' AND payload LIKE '%COMPLETED%'" 60 || echo "(no Director wake observed yet)"
sleep 2
MD_S=$(api "http://127.0.0.1:$PORT/api/chats/$SCHAT/export?format=markdown")
MD_P=$(api "http://127.0.0.1:$PORT/api/chats/$PCHAT/export?format=markdown")
printf '%s' "$MD_S" > "$DD/session-export.md"; printf '%s' "$MD_P" > "$DD/project-export.md"

node - "$DD/tandem.db" "$PCHAT" "$SCHAT" "$NOTE" "$DD" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3"); const fs=require('fs');
const [dbPath, pchat, schat, note, dd]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const sess=db.prepare("SELECT status, review_verdict, result_summary, final_state FROM pd_sessions WHERE key='S1'").get();
const fs1=sess.final_state?JSON.parse(sess.final_state):null;
const sRows=db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(schat).map(r=>({...r,p:JSON.parse(r.payload)}));
const pRows=db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(pchat).map(r=>({...r,p:JSON.parse(r.payload)}));
const obsCall=pRows.filter(r=>r.kind==='ai_call'&&r.p.role==='director'&&/Session S1 COMPLETED/.test(r.p.request?.prompt||'')).slice(-1)[0];
const obs=obsCall? obsCall.p.request.prompt.slice(obsCall.p.request.prompt.indexOf('Session S1 COMPLETED')) : '';
const snapshotLine=obsCall? (obsCall.p.request.prompt.match(/^\s*S1 Feature \[completed\].*$/m)||[''])[0] : '';
const mdS=fs.readFileSync(dd+'/session-export.md','utf8'), mdP=fs.readFileSync(dd+'/project-export.md','utf8');
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+d:''}`); };
console.log('   S1:', sess.status, sess.review_verdict, '| final_state verdict:', fs1?.verdict, '| verified:', JSON.stringify(fs1?.verified?.map(v=>v.id)));
console.log('   result_summary head:', String(sess.result_summary||'').slice(0,160).replace(/\n/g,' ⏎ '));
console.log('   observation head:', obs.slice(0,200).replace(/\n/g,' ⏎ '));
console.log('   snapshot line:', snapshotLine.slice(0,220));

// 1+2+3: the loop happened as described
const r2=sRows.find(r=>r.kind==='findings'&&r.p.round===2)?.p;
check('1. the Builder hand-off recommended a future check (both turns)', sRows.filter(r=>r.kind==='ai_call'&&r.p.role==='builder').every(c=>(c.p.response?.text||'').includes('Worth re-running')));
check('2. round 2 ran the check and PASSed with RESOLVED F-001 + evidence', r2 && r2.verdict==='pass' && (r2.verified||[]).includes('F-001') && (r2.verifiedEvidence||[]).some(v=>v.id==='F-001'&&/re-ran the check/.test(v.evidence)));
check('   the registry keeps the verification evidence on F-001', db.prepare("SELECT resolution_evidence e, state, repair_status rs FROM review_findings WHERE chat_id=? AND id='F-001'").get(schat)?.rs==='verified' && /re-ran the check/.test(db.prepare("SELECT resolution_evidence e FROM review_findings WHERE chat_id=? AND id='F-001'").get(schat).e||''));
// 4: what the Director is handed
check('3. the persisted final_state says PASS, Builder Reviewer round 2, F-001 verified with evidence', fs1 && fs1.verdict==='pass' && fs1.reviewer==='builder_reviewer' && fs1.round===2 && fs1.verified.some(v=>v.id==='F-001'&&/re-ran the check/.test(v.evidence)));
check('   result_summary LEADS with the final state, not the hand-off', /^FINAL STATE: PASS — Builder Reviewer, round 2\./.test(sess.result_summary||''), (sess.result_summary||'').slice(0,80));
check('   result_summary names the verification as already done', /Verified by the Builder Reviewer \(already done — do not commission again\): F-001/.test(sess.result_summary||''));
check('   result_summary carries the hand-off AFTER, labelled historical / pre-review', (()=>{const s=sess.result_summary||''; const i=s.indexOf('FINAL STATE'), j=s.indexOf("Builder's last hand-off (HISTORICAL"), k=s.indexOf('Worth re-running'); return i===0 && j>0 && k>j; })());
check('4. the Director\'s wake observation leads with the final verdict and the evidence', /^Session S1 COMPLETED\. Final verdict: PASS\.\nFINAL STATE: PASS/.test(obs) && /F-001 "[^"]+" — re-ran the check/.test(obs), obs.slice(0,120));
check('   …and the "worth re-running" note appears only after the HISTORICAL label', (()=>{const j=obs.indexOf('HISTORICAL'), k=obs.indexOf('Worth re-running'); return j>0 && k>j; })());
check('   the state snapshot line leads with "final: PASS … verified F-001" and labels the hand-off', /final: PASS \(Builder Reviewer, round 2\); verified F-001/.test(snapshotLine) && /builder hand-off \(historical, pre-review\)/.test(snapshotLine), snapshotLine.slice(0,160));
check('   the Director created no second session', db.prepare("SELECT COUNT(*) c FROM pd_sessions").get().c===1);
// 5: history retained
check('5. the Builder\'s hand-off text is retained verbatim in the ai_call record and as an assistant message', sRows.some(r=>r.kind==='ai_call'&&r.p.role==='builder'&&(r.p.response?.text||'').includes(note)) && sRows.some(r=>r.kind==='assistant_message'&&(r.p.text||'').includes('Worth re-running')));
check('   the export still shows the hand-off', mdS.includes('Worth re-running'));
// 6: reviewer roles distinct everywhere
const planFindings=pRows.filter(r=>r.kind==='findings').map(r=>r.p);
const sessFindings=sRows.filter(r=>r.kind==='findings').map(r=>r.p);
check('6. session findings events name builder_reviewer; plan-review findings name director_reviewer', sessFindings.length>0 && sessFindings.every(f=>f.reviewer==='builder_reviewer') && planFindings.length>0 && planFindings.every(f=>f.reviewer==='director_reviewer'));
check('   ai_calls: session reviews are builder_reviewer on codex, plan reviews are director_reviewer on claude-code', sRows.filter(r=>r.kind==='ai_call'&&/reviewer/.test(r.p.role)).every(r=>r.p.role==='builder_reviewer'&&r.p.provider==='codex') && pRows.filter(r=>r.kind==='ai_call'&&/reviewer/.test(r.p.role)).every(r=>r.p.role==='director_reviewer'&&r.p.provider==='claude-code'));
check('   the session export says "Builder Reviewer" and never "Director Reviewer"', /Builder Reviewer/.test(mdS) && !/Director Reviewer/.test(mdS));
check('   the project export says "Director Reviewer" for the plan review and never "Builder Reviewer"', /Director Reviewer (findings|PASS)/.test(mdP) && !/Builder Reviewer (findings|PASS)/.test(mdP));
check('   the PASS export line carries the verification evidence', /Builder Reviewer PASS.*verified F-001/.test(mdS) && /F-001: re-ran the check/.test(mdS));
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "ALL OUTCOME CHECKS PASSED"; else echo "OUTCOME CHECKS FAILED"; fi
exit $RC
