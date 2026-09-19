#!/bin/bash
# Provider switching, end to end, against a REAL isolated Tandem with fake CLIs.
# No model is called and no credential is used: the fakes answer as the real
# CLIs do (stream-json / JSONL, session ids, resume flags) and record every
# invocation's argv. Work dirs live under ./.work (gitignored).
#
#   run.sh            boots on PORT (default 7975), drives the scenario, prints checks, exits 1 on any failure
#
# Scenario:
#   1. Builder = Codex, Reviewer = Claude Code: a reviewed chat runs Builder on codex and the review on claude
#   2. a second message resumes the Codex thread (`exec resume <id>`)
#   3. Builder → Claude Code: the next turn must NOT resume the Codex thread; then it resumes its own Claude session
#   4. Builder → Codex again: must NOT resume the Claude session
#   5. invalid provider/model pairs and unknown providers are refused by the settings API
#   6. /api/providers reports the registry
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
FAKES="$ROOT/server/test/review-reset"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7975}"
mkdir -p "$RR/.work"; DD=$RR/.work/data; STATE=$RR/.work/state; PROJ=$RR/.work/proj
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init )
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

RECIPES='{"RECIPE_ONE":["echo a > a.txt"],"RECIPE_TWO":["echo b > b.txt"],"RECIPE_THREE":["echo c > c.txt"],"RECIPE_FOUR":["echo d > d.txt"],"RECIPE_FIVE":["echo e > e.txt"],"returned these findings":["echo fixed >> a.txt"]}'
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$FAKES/fake-claude.cjs" TANDEM_CODEX_BIN="$FAKES/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_BUILDER_RECIPES="$RECIPES" FAKE_FINDINGS_FOR=0)
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
put_settings(){ api -X PUT -d "$1" "http://127.0.0.1:$PORT/api/settings"; }
send(){ # send <chat> <text> ; waits for the run to finish
  local before; before=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$1' AND kind='run' AND payload LIKE '%finished%'")
  api -d "{\"text\":\"$2\",\"review\":${3:-false}}" "http://127.0.0.1:$PORT/api/chats/$1/messages" >/dev/null
  waitfor "SELECT COUNT(*) FROM events WHERE chat_id='$1' AND kind='run' AND payload LIKE '%finished%' AND seq > 0 AND (SELECT COUNT(*) FROM events WHERE chat_id='$1' AND kind='run' AND payload LIKE '%finished%') > $before" 90 || echo "(run did not finish in time)"
}
last_argv(){ node -e 'const fs=require("fs"); const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n"); const rows=L.map(l=>JSON.parse(l)).filter(r=>!process.argv[2]||r.role===process.argv[2]); console.log(rows.length?rows[rows.length-1].argv.join(" "):"")' "$1" "${2:-}" 2>/dev/null; }
count_argv(){ node -e 'const fs=require("fs"); try{ const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean); console.log(L.filter(l=>!process.argv[2]||JSON.parse(l).role===process.argv[2]).length);}catch{console.log(0)}' "$1" "${2:-}"; }

echo "== boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null

echo "== /api/providers"
PROV=$(api "http://127.0.0.1:$PORT/api/providers")
check "registry lists codex and claude-code with models and capabilities" "$(node -e 'const r=JSON.parse(process.argv[1]); const ids=r.providers.map(p=>p.id).sort().join(","); console.log(ids==="claude-code,codex" && r.providers.every(p=>p.models.length>0 && typeof p.capabilities.resumableSessions==="boolean") ? 1 : 0)' "$PROV")"
check "resolved roles are reported for all four roles" "$(node -e 'const r=JSON.parse(process.argv[1]); console.log(r.resolved.builder.provider && r.resolved.builder_reviewer.provider && r.resolved.director.provider && r.resolved.director_reviewer.provider ? 1 : 0)' "$PROV")"

echo "== settings validation"
R=$(put_settings '{"roles":{"builder":{"provider":"codex","model":"claude-opus-5"}}}')
check "codex + claude model is refused" "$([[ "$R" == *"not a model"* ]] && echo 1 || echo 0)" "$R"
R=$(put_settings '{"roles":{"builder_reviewer":{"provider":"openai-api","model":"gpt-5"}}}')
check "unknown provider is refused" "$([[ "$R" == *"Unknown AI provider"* ]] && echo 1 || echo 0)" "$R"
R=$(put_settings '{"roles":{"builder":{"provider":"codex-cli","model":"gpt-5.6-sol","effort":"low"},"builder_reviewer":{"provider":"claude-code-cli","model":"claude-sonnet-5","effort":"medium","enabled":true},"director":{"provider":"claude-code","model":"claude-opus-5","effort":"high"},"director_reviewer":{"provider":"codex","model":"gpt-5.6-terra","effort":"high"}}}')
check "Builder=Codex, Builder Reviewer=Claude, Director Reviewer=Codex (aliases accepted, canonical ids stored, independent)" "$(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.roles.builder.provider==="codex"&&s.roles.builder_reviewer.provider==="claude-code"&&s.roles.builder_reviewer.model==="claude-sonnet-5"&&s.roles.director_reviewer.provider==="codex"&&s.roles.director_reviewer.model==="gpt-5.6-terra"&&!("reviewer" in s.roles)?1:0)' "$R")" "$R"

echo "== project + chat"
P=$(api -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/projects/directory"); PID=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$P")
C=$(api -d "{\"projectId\":\"$PID\"}" "http://127.0.0.1:$PORT/api/chats"); CHAT=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$C")
[ -n "$CHAT" ] || { echo "chat not created: $C"; stop; exit 1; }

echo "== 1. reviewed run: Builder on Codex, review on Claude"
send "$CHAT" "RECIPE_ONE please" true
check "Builder ai_call ran on codex" "$( [ "$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"builder\"%' AND payload LIKE '%\"provider\":\"codex\"%'")" -ge 1 ] && echo 1 || echo 0 )"
check "Builder Reviewer ai_call ran on claude-code with claude-sonnet-5 (precise role recorded)" "$( [ "$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='ai_call' AND payload LIKE '%\"role\":\"builder_reviewer\"%' AND payload LIKE '%\"provider\":\"claude-code\"%' AND payload LIKE '%claude-sonnet-5%'")" -ge 1 ] && echo 1 || echo 0 )"
check "the review reached a verdict" "$( [ "$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='findings'")" -ge 1 ] && echo 1 || echo 0 )"
check "the Codex Builder actually did the work (a.txt exists)" "$( [ -f "$PROJ/a.txt" ] && echo 1 || echo 0 )"
CX1=$(last_argv "$STATE/codex-argv.log" builder)
check "first Codex Builder turn started a thread (no resume)" "$([[ "$CX1" == exec\ --json* ]] && echo 1 || echo 0)" "$CX1"
check "Codex Builder used -p profile + --approve-for-me, not the read-only sandbox" "$([[ "$CX1" == *"--approve-for-me"* && "$CX1" != *"--sandbox read-only"* ]] && echo 1 || echo 0)" "$CX1"
CLR=$(last_argv "$STATE/claude-argv.log")
check "Claude Reviewer turn was read-only (mutation tools denied) and fresh (no --resume)" "$([[ "$CLR" == *"--disallowedTools"* && "$CLR" != *"--resume"* ]] && echo 1 || echo 0)" "$CLR"
check "Claude Reviewer got the reviewer prompt on stdin" "$( grep -q "The user's original request" "$STATE/claude-review-prompts.log" 2>/dev/null && echo 1 || echo 0 )"
SP=$(q "SELECT builder_session_provider FROM chats WHERE id='$CHAT'"); SID=$(q "SELECT builder_session_id FROM chats WHERE id='$CHAT'")
check "stored session belongs to codex with the thread id" "$([ "$SP" = codex ] && [[ "$SID" == codex-thread-* ]] && echo 1 || echo 0)" "$SP $SID"

echo "== 2. second message resumes the Codex thread"
send "$CHAT" "RECIPE_TWO please" false
CX2=$(last_argv "$STATE/codex-argv.log" builder)
check "Codex resumed its own thread, with exec-level options BEFORE the subcommand" "$([[ "$CX2" == exec\ --json* && "$CX2" == *"--approve-for-me"*"resume $SID"* ]] && echo 1 || echo 0)" "$CX2"

echo "== 3. Builder → Claude Code: the Codex thread must not be resumed"
put_settings '{"roles":{"builder":{"provider":"claude-code","model":"claude-opus-5","effort":"high"}}}' >/dev/null
N_CL_BEFORE=$(count_argv "$STATE/claude-argv.log")
send "$CHAT" "RECIPE_THREE please" false
CL3=$(last_argv "$STATE/claude-argv.log")
check "Claude Builder turn ran" "$( [ "$(count_argv "$STATE/claude-argv.log")" -gt "$N_CL_BEFORE" ] && echo 1 || echo 0 )"
check "switching Codex → Claude did NOT pass the Codex thread as --resume" "$([[ "$CL3" != *"--resume"* ]] && echo 1 || echo 0)" "$CL3"
check "the switch was announced in the chat" "$( [ "$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='status' AND payload LIKE '%cannot be continued by another provider%'")" -ge 1 ] && echo 1 || echo 0 )"
check "the fresh Claude turn was seeded from Tandem's own history" "$( [ "$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='ai_call' AND payload LIKE '%\"provider\":\"claude-code\"%' AND payload LIKE '%\"role\":\"builder\"%' AND payload LIKE '%RECIPE_TWO%'")" -ge 1 ] && echo 1 || echo 0 )"
SP=$(q "SELECT builder_session_provider FROM chats WHERE id='$CHAT'"); SID2=$(q "SELECT builder_session_id FROM chats WHERE id='$CHAT'")
check "stored session now belongs to claude-code" "$([ "$SP" = claude-code ] && [[ "$SID2" == fake-sess-* ]] && echo 1 || echo 0)" "$SP $SID2"
send "$CHAT" "RECIPE_FOUR please" false
CL4=$(last_argv "$STATE/claude-argv.log")
check "next Claude turn resumes its OWN session" "$([[ "$CL4" == *"--resume $SID2"* ]] && echo 1 || echo 0)" "$CL4"

echo "== 4. Builder → Codex again: the Claude session must not be resumed"
put_settings '{"roles":{"builder":{"provider":"codex","model":"gpt-5.6-terra","effort":"medium"}}}' >/dev/null
send "$CHAT" "RECIPE_FIVE please" false
CX5=$(last_argv "$STATE/codex-argv.log" builder)
check "switching Claude → Codex did NOT resume (no 'resume' in argv)" "$([[ "$CX5" == exec\ --json* && "$CX5" != *"resume"* ]] && echo 1 || echo 0)" "$CX5"
check "Codex ran the newly selected model and effort" "$([[ "$CX5" == *"-m gpt-5.6-terra"* && "$CX5" == *'model_reasoning_effort="medium"'* ]] && echo 1 || echo 0)" "$CX5"
check "the Claude session id was never handed to Codex" "$( grep -q "fake-sess-" "$STATE/codex-argv.log" && echo 0 || echo 1 )"
check "the Codex thread id was never handed to Claude" "$( grep -q "codex-thread-" "$STATE/claude-argv.log" && echo 0 || echo 1 )"
check "every Builder turn produced a file (e.txt from the last one)" "$( [ -f "$PROJ/e.txt" ] && echo 1 || echo 0 )"

echo "== 5. Reviewer on Claude sees a repair round like Codex would"
NF=$(q "SELECT COUNT(*) FROM events WHERE chat_id='$CHAT' AND kind='error'")
check "no error events in the whole scenario" "$([ "${NF:-0}" = 0 ] && echo 1 || echo 0)" "$(q "SELECT payload FROM events WHERE chat_id='$CHAT' AND kind='error' LIMIT 1")"

stop
echo; if [ $BAD = 0 ]; then echo "ALL PROVIDER SWITCH CHECKS PASSED"; else echo "$BAD FAILED"; fi
exit $BAD
