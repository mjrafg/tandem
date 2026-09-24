#!/bin/bash
# The Agent API over HTTP, not the store underneath it. Every field the UI sends
# must survive the route's whitelist: `enforceModel` once did not, so the "own
# model" toggle silently did nothing while the store-level tests all passed.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8007}"
export PATH="$HOME/.local/node22/bin:$PATH"
mkdir -p "$RR/.work"; DD=$RR/.work/api; rm -rf "$DD"; mkdir -p "$DD"
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken)
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }

CREATED=$(api -d '{"slug":"apitest","name":"API Test","systemPrompt":"p","provider":"codex","model":"gpt-5.6-terra","effort":"medium"}' "http://127.0.0.1:$PORT/api/agents")
ID=$(node -e 'try{console.log(JSON.parse(process.argv[1]).id)}catch{console.log("")}' "$CREATED")
AFTER_ON=$(api -X PATCH -d '{"enforceModel":true}' "http://127.0.0.1:$PORT/api/agents/$ID")
AFTER_OFF=$(api -X PATCH -d '{"enforceModel":false}' "http://127.0.0.1:$PORT/api/agents/$ID")
CREATED_ON=$(api -d '{"slug":"apitest2","name":"API Test 2","systemPrompt":"p","provider":"codex","model":"gpt-5.6-terra","effort":"medium","enforceModel":true}' "http://127.0.0.1:$PORT/api/agents")
LIST=$(api "http://127.0.0.1:$PORT/api/agents")

node - "$CREATED" "$AFTER_ON" "$AFTER_OFF" "$CREATED_ON" "$LIST" <<'JS'
const [created,on,off,createdOn,list]=process.argv.slice(2);
const j=(s)=>{ try { return JSON.parse(s); } catch { return {}; } };
let bad=0; const check=(l,ok,d)=>{ if(!ok) bad++; console.log(`${ok?'ok  ':'FAIL'} ${l}${!ok&&d?' — '+String(d).slice(0,160):''}`); };
check('a new agent does not pin its model', j(created).enforceModel === false, created);
check('PATCH enforceModel true is applied and returned', j(on).enforceModel === true, on);
check('PATCH enforceModel false turns it back off', j(off).enforceModel === false, off);
check('create with enforceModel true is honoured', j(createdOn).enforceModel === true, createdOn);
const listed = (j(list) || []).find?.((a) => a.slug === 'apitest2');
check('the list reports it too', listed?.enforceModel === true, list);
process.exit(bad?1:0);
JS
RC=$?
{ kill -9 "$(cat "$DD/pid")" 2>/dev/null; } 2>/dev/null
echo; if [ $RC = 0 ]; then echo "ALL AGENT API CHECKS PASSED"; else echo "AGENT API CHECKS FAILED"; fi
exit $RC
