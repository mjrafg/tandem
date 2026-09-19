#!/bin/bash
# The bounded review loop, end to end, on a REAL isolated Tandem with fake CLIs:
#   review 1 → Builder response → (Director arbitration) → review 2 → final Builder pass → Director final decision
# No model is called. Work dirs live under ./.work (gitignored).
#
#   run.sh SCENARIO   where SCENARIO ∈ ATTRIBUTION | REPAIR_FAILED | NEW_FINDING | ALL_ACCEPTED_PASS
#
#   ATTRIBUTION       R1 finding (metadata) → Builder REJECTS with evidence → Director upholds the Builder →
#                     no round 2 at all, verdict resolved. (The S6.2 failure mode, prevented.)
#   REPAIR_FAILED     R1 F-001 accepted+repaired → R2 says REPAIR_FAILED F-001 (no F-002) → final pass repairs F-001 →
#                     Director's final decision: non_blocking (unverified repair accepted, uncertainty recorded) → resolved
#   NEW_FINDING       R1 F-001 accepted → R2 verifies F-001 and raises F-002 → final pass → Director: reviewer_upheld →
#                     verdict findings (blocking recorded), still no third review
#   ALL_ACCEPTED_PASS R1 F-001 accepted → R2 RESOLVED F-001 → PASS, no final pass, no arbitration
set -u
SCENARIO="${1:-ATTRIBUTION}"
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7978}"
mkdir -p "$RR/.work"; DD=$RR/.work/data-$SCENARIO; STATE=$RR/.work/state-$SCENARIO; PROJ=$RR/.work/proj-$SCENARIO
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

RECIPES='{"RECIPE_BUILD":["echo a > a.txt"],"returned these findings":["echo fixed >> a.txt"],"FINAL repair pass":["echo final >> a.txt"],"Director reviewed the findings":["echo mandated >> a.txt"]}'
case "$SCENARIO" in
  ATTRIBUTION)       DISP=rejected;  R2=resolved;      ARB=builder_upheld; ARBF=;             CAT=metadata; FINDINGS_FOR=1 ;;
  REPAIR_FAILED)     DISP=accepted;  R2=repair_failed; ARB=reviewer_upheld; ARBF=non_blocking; CAT=defect;   FINDINGS_FOR=2 ;;
  NEW_FINDING)       DISP=accepted;  R2=new;           ARB=reviewer_upheld; ARBF=reviewer_upheld; CAT=defect; FINDINGS_FOR=2 ;;
  ALL_ACCEPTED_PASS) DISP=accepted;  R2=resolved;      ARB=reviewer_upheld; ARBF=;             CAT=defect;   FINDINGS_FOR=1 ;;
  *) echo "unknown scenario"; exit 1 ;;
esac
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_BUILDER_RECIPES="$RECIPES" FAKE_FINDINGS_FOR=$FINDINGS_FOR FAKE_FINDING_CATEGORY=$CAT
     FAKE_DISPOSITION=$DISP FAKE_R2=$R2 FAKE_ARBITER=$ARB FAKE_ARBITER_FINAL=$ARBF)
boot(){ env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
        for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "boot failed"; exit 1; }
stop(){ { kill -9 "$(cat "$DD/pid")" 2>/dev/null; wait "$(cat "$DD/pid")" 2>/dev/null; } 2>/dev/null; sleep 1; }
q(){ node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
try{ const r=db.prepare(process.argv[2]).get(); console.log(r?Object.values(r)[0]:""); }catch(e){ console.log(""); }' "$DD/tandem.db" "$1"; }
waitfor(){ for i in $(seq 1 "$2"); do v=$(q "$1"); [ -n "$v" ] && [ "$v" != "0" ] && return 0; sleep 1; done; return 1; }
BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — $3}"; BAD=$((BAD+1)); fi; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }

echo "== [$SCENARIO] boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
# Builder and Builder Reviewer both on the (fake) Claude CLI, Director too: the same provider, three roles
api -X PUT -d '{"roles":{"builder":{"provider":"claude-code","model":"claude-opus-5","effort":"high"},"builder_reviewer":{"provider":"claude-code","model":"claude-sonnet-5","effort":"medium","enabled":true},"director":{"provider":"claude-code","model":"claude-fable-5-1","effort":"high"},"director_reviewer":{"provider":"codex","model":"gpt-5.6-sol","effort":"high"}}}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
P=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/projects/directory"); PID=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$P")
C=$(api -d "{\"projectId\":\"$PID\"}" "http://127.0.0.1:$PORT/api/chats"); CHAT=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$C")
[ -n "$CHAT" ] || { echo "chat not created: $C"; stop; exit 1; }
api -d '{"text":"RECIPE_BUILD Implement the feature","review":true}' "http://127.0.0.1:$PORT/api/chats/$CHAT/messages" >/dev/null
waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='run' AND payload LIKE '%finished%'" 120 || echo "(run did not finish in time)"

FINDINGS=$(api "http://127.0.0.1:$PORT/api/chats/$CHAT/findings")
node - "$DD/tandem.db" "$CHAT" "$SCENARIO" "$FINDINGS" "$STATE" <<'JS'
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3"); const fs=require('fs');
const [dbPath, chat, scenario, findingsJson, state]=process.argv.slice(2);
const db=new D(dbPath,{readonly:true});
const rows=db.prepare("SELECT seq,kind,payload FROM events WHERE chat_id=? ORDER BY seq").all(chat).map(r=>({...r,p:JSON.parse(r.payload)}));
const calls=rows.filter(r=>r.kind==='ai_call');
const byRole=(role)=>calls.filter(r=>r.p.role===role);
const findings=rows.filter(r=>r.kind==='findings').map(r=>({seq:r.seq,...r.p}));
const disp=rows.filter(r=>r.kind==='finding_dispositions').map(r=>({seq:r.seq,...r.p}));
const arbs=rows.filter(r=>r.kind==='arbitration').map(r=>({seq:r.seq,...r.p}));
const ledger=db.prepare("SELECT * FROM review_ledger WHERE chat_id=?").get(chat);
const reg=JSON.parse(findingsJson).findings;
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+d:''}`); };
console.log(`   calls: builder=${byRole('builder').length} builder_reviewer=${byRole('builder_reviewer').length} arbiter=${byRole('arbiter').length} reviewer(legacy)=${byRole('reviewer').length} | findings events=${findings.length} | dispositions=${disp.length} | arbitrations=${arbs.length} | ledger=${ledger?.last_verdict}`);
console.log(`   registry: ${reg.map(f=>`${f.id}:${f.state}/${f.repairStatus??'-'}${f.blocking==null?'':f.blocking?'/BLOCKING':'/ok'}`).join(' ')}`);
// common invariants
check('every reviewer call carries the precise role builder_reviewer (no generic reviewer)', byRole('reviewer').length===0 && byRole('builder_reviewer').length>=1);
check('never more than two reviewer calls', byRole('builder_reviewer').length<=2, String(byRole('builder_reviewer').length));
check('the review used the Builder Reviewer configuration (claude-sonnet-5 / medium)', byRole('builder_reviewer').every(c=>/--model claude-sonnet-5\b/.test(c.p.cli?.command||'')&&c.p.effort==='medium'));
check('the arbiter, when it ran, used the Director configuration (claude-fable-5-1)', byRole('arbiter').every(c=>/--model claude-fable-5-1\b/.test(c.p.cli?.command||'')));
check('every ai_call records its provider session id when the CLI reported one', byRole('builder').every(c=>typeof c.p.sessionId==='string'));
check('round-1 findings carry stable ids', (findings[0]?.items||[]).every(i=>/^F-\d{3}$/.test(i.id||'')));
check('the first finding is F-001', findings[0]?.items?.[0]?.id==='F-001');
const r1=findings.find(f=>f.round===1), r2=findings.find(f=>f.round===2);
if (scenario==='ATTRIBUTION') {
  check('the Builder rejected the finding with evidence', disp[0]?.items?.[0]?.disposition==='rejected' && !!disp[0].items[0].evidence);
  check('the Director upheld the Builder', arbs[0]?.items?.[0]?.decision==='builder_upheld' && arbs[0].items[0].blocking===false);
  check('NO round 2 ran — the disagreement was not re-argued', !r2 && byRole('builder_reviewer').length===1);
  check('no final pass, no second arbitration', disp.length===1 && arbs.length===1);
  check('the finding is closed as builder_upheld in the registry', reg[0]?.state==='builder_upheld' && reg[0]?.blocking===false);
  check('the task verdict is resolved (the Director\'s approval)', ledger?.last_verdict==='resolved');
  const arbPrompt=(()=>{try{return fs.readFileSync(state+'/arbiter-prompts.log','utf8')}catch{return ''}})();
  check('the Director saw the requirement, the finding, the Builder\'s evidence and the runtime policies', /original request/.test(arbPrompt) && /Builder evidence:/.test(arbPrompt) && /Attribution is truthful/.test(arbPrompt) && /Category: metadata/.test(arbPrompt));
}
if (scenario==='REPAIR_FAILED') {
  check('round 2 reopened F-001 as repair_failed instead of raising a new finding', r2 && (r2.repairFailed||[]).some(x=>x.id==='F-001') && (r2.items||[]).length===0, JSON.stringify(r2&&{items:r2.items,rf:r2.repairFailed}));
  check('no F-002 exists anywhere', !reg.some(f=>f.id==='F-002'));
  check('one final Builder pass ran, after round 2', disp.filter(d=>d.final).length===1 && disp.find(d=>d.final).seq>r2.seq);
  check('no third reviewer call after the final pass', !calls.some(c=>c.p.role==='builder_reviewer' && c.seq>disp.find(d=>d.final).seq));
  const fin=arbs.find(a=>a.final);
  check('the Director\'s FINAL decision was recorded with a proceed verdict', !!fin && fin.proceed===true && fin.items[0].id==='F-001');
  check('the final-pass repair is recorded as UNVERIFIED (uncertainty preserved), and F-001 keeps its identity', reg[0]?.id==='F-001' && reg[0]?.repairStatus==='unverified' && reg[0]?.state==='non_blocking');
  check('the task verdict is resolved', ledger?.last_verdict==='resolved');
  check('exactly two reviewer calls', byRole('builder_reviewer').length===2);
}
if (scenario==='NEW_FINDING') {
  check('round 2 verified F-001 and raised exactly one NEW finding F-002', r2 && (r2.verified||[]).includes('F-001') && r2.items.length===1 && r2.items[0].id==='F-002');
  check('F-001 is resolved (verified) in the registry', reg.find(f=>f.id==='F-001')?.state==='resolved' && reg.find(f=>f.id==='F-001')?.repairStatus==='verified');
  const fin=arbs.find(a=>a.final);
  check('the final pass handled F-002 and the Director judged it blocking', disp.find(d=>d.final)?.items?.[0]?.id==='F-002' && !!fin && fin.items.some(a=>a.id==='F-002'&&a.blocking));
  check('the task verdict is findings (blocking recorded) and round-2 findings are marked as not re-reviewed', ledger?.last_verdict==='findings' && r2.repairSkippedAtCap===true);
  check('no third reviewer call', byRole('builder_reviewer').length===2);
}
if (scenario==='ALL_ACCEPTED_PASS') {
  check('round 2 was PASS with F-001 verified', r2 && r2.verdict==='pass' && (r2.verified||[]).includes('F-001'));
  check('no final pass and no arbitration were spent', !disp.some(d=>d.final) && arbs.length===0);
  check('the task verdict is pass', ledger?.last_verdict==='pass');
}
process.exit(bad?1:0);
JS
RC=$?
stop
echo; if [ $RC = 0 ]; then echo "[$SCENARIO] ALL CHECKS PASSED"; else echo "[$SCENARIO] FAILED"; fi
exit $RC
