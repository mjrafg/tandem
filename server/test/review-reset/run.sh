#!/bin/bash
# Deterministic reproduction of the review-budget reset and the restart-during-review-wait pause.
# Overridable: DIST PORT LABEL FAKE_FINDINGS_FOR FAKE_CODEX_CRASH_ON_CALL NO_GIT SETTLE RESUME_AFTER_RESTART. Work dirs live under ./.work (gitignored).
#   run.sh SCENARIO   where SCENARIO ∈ NONE | AFTER_R1 | DURING_R2 | DURING_FINAL | DOUBLE_FINAL | QUOTA_R2 | QUOTA_CRASH_FINAL | QUOTA_WAIT_RESTART
#                                     | OVERLOAD_BUILDER (Builder call 1 refused with a 529) | OVERLOAD_DIRECTOR (Director turn 1 refused with a 529)
# Each scenario boots an isolated Tandem with fake CLIs, drives ONE Director session through
# Round 1 (FINDINGS) → repair → Round 2 (FINDINGS) → final repair, kills the server at the
# named boundary, restarts it, lets auto-resume + the scripted Director resume the session,
# and leaves the database + the Reviewer's prompts for assert2.cjs to judge.
set -u
SCENARIO="${1:-NONE}"
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"; mkdir -p "$RR/.work"
DIST="${DIST:-$ROOT/server/dist/index.js}"
LABEL="${LABEL:-$SCENARIO}"; PORT="${PORT:-7971}"
DD=$RR/.work/data-$LABEL; STATE=$RR/.work/state-$LABEL; PROJ=$RR/.work/proj-$LABEL
rm -rf "$DD" "$STATE" "$PROJ"; mkdir -p "$DD" "$STATE" "$PROJ"
if [ "${NO_GIT:-}" = 1 ]; then
  # A project with no repository of its own must not sit INSIDE one: git
  # searches upward, so Tandem would adopt the enclosing checkout — during
  # development of this flag it did exactly that to the Tandem repo itself,
  # creating a branch and committing the working tree. Move it out of the tree.
  PROJ=$(mktemp -d "${TMPDIR:-/tmp}/tandem-rr-nogit-XXXXXX")
  echo "== NO_GIT: workspace has no repository, and lives outside any ($PROJ)"
  if git -C "$PROJ" rev-parse --git-dir >/dev/null 2>&1; then
    echo "refusing to run: $PROJ is still inside a git repository"; exit 1
  fi
else
( cd "$PROJ" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init ); fi
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

# recipes: first marker found in the prompt wins (object order)
RECIPES='{"Final repair round":["sleep 25","echo c > a.txt"],
          "returned these findings":["sleep 8","echo b > a.txt"],
          "Continue exactly where you left off":["sleep 12","echo d > d.txt"],
          "RECIPE_BUILD":["echo a > a.txt"]}'
SLEEP_ON=""; [ "$SCENARIO" = DURING_R2 ] && SLEEP_ON=2
QUOTA_ON=""; case "$SCENARIO" in QUOTA_R2|QUOTA_CRASH_FINAL|QUOTA_WAIT_RESTART) QUOTA_ON=2 ;; esac
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_REVIEW_SWEEP_MS=2000
     TANDEM_CLAUDE_BIN="$RR/fake-claude.cjs" TANDEM_CODEX_BIN="$RR/fake-codex.cjs"
     FAKE_STATE_DIR="$STATE" FAKE_DIRECTOR_SCRIPT="$RR/dscript.json" FAKE_BUILDER_RECIPES="$RECIPES"
     FAKE_CODEX_SLEEP_ON_CALL="$SLEEP_ON" FAKE_CODEX_QUOTA_ON_CALL="$QUOTA_ON" FAKE_FINDINGS_FOR="${FAKE_FINDINGS_FOR:-2}"
     FAKE_CODEX_CRASH_ON_CALL="${FAKE_CODEX_CRASH_ON_CALL:-}"
     FAKE_CLAUDE_FAIL_ON_CALL="$([ "$SCENARIO" = OVERLOAD_BUILDER ] && echo 1)" FAKE_DIRECTOR_FAIL_ON_TURN="$([ "$SCENARIO" = OVERLOAD_DIRECTOR ] && echo 1)")
boot(){ env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & echo $! > "$DD/pid"
        for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "boot failed"; exit 1; }
stop(){ kill -9 "$(cat "$DD/pid")" 2>/dev/null; sleep 1; }
q(){ node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3");
const db=new D(process.argv[1],{readonly:true});
const sql=process.argv[2]; try{ const r=db.prepare(sql).get(); console.log(r?Object.values(r)[0]:""); }catch(e){ console.log(""); }' "$DD/tandem.db" "$1"; }
waitfor(){ # waitfor "<sql returning a truthy scalar>" <seconds>
  for i in $(seq 1 "$2"); do v=$(q "$1"); [ -n "$v" ] && [ "$v" != "0" ] && return 0; sleep 1; done; return 1; }

echo "== [$SCENARIO] boot"
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
boot
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "http://127.0.0.1:$PORT/api/login" >/dev/null
RUN=$(curl -s -b "$CJ" -H 'content-type: application/json' -d "{\"dirPath\":\"$PROJ\"}" "http://127.0.0.1:$PORT/api/project-runs")
PCHAT=$(node -e 'try { const r=JSON.parse(process.argv[1]); console.log(r.chat.id) } catch { console.log("") }' "$RUN")
[ -n "$PCHAT" ] || { echo "project run not created: ${RUN:0:300}"; stop; exit 1; }
echo "== project chat $PCHAT — kicking the Director"
KICK=$(curl -s -b "$CJ" -H 'content-type: application/json' -d '{"text":"Build the RR demo project."}' "http://127.0.0.1:$PORT/api/chats/$PCHAT/messages")
echo "== kick response: ${KICK:0:200}"

# a refused provider call leaves a persisted wake; press the Retry button the way an operator would
expedite(){ echo "== waiting for the persisted wake"; waitfor "SELECT COUNT(*) FROM pending_wakes" 60 || { echo "no wake was persisted"; stop; exit 1; }
            q "SELECT reason || ' @ ' || datetime(retry_at/1000,'unixepoch') FROM pending_wakes" | sed 's/^/== wake: /'
            sleep 2; RUNID=$(q "SELECT id FROM project_runs"); curl -s -b "$CJ" -X POST "http://127.0.0.1:$PORT/api/project-runs/$RUNID/retry-reviews" | head -c 120; echo; }
[ "$SCENARIO" = OVERLOAD_DIRECTOR ] && expedite
SESS="SELECT chat_id FROM pd_sessions WHERE key='S1.1' AND chat_id IS NOT NULL"
waitfor "$SESS" 60 || { echo "session never launched"; stop; exit 1; }
SCHAT=$(q "$SESS"); echo "== session chat $SCHAT"
F1="SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='findings' AND payload LIKE '%\"round\":1%'"
F2="SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='findings' AND payload LIKE '%\"round\":2%'"
R2START="SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='status' AND payload LIKE '%repaired result%'"
DONE="SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='run' AND payload LIKE '%\"phase\":\"finished\"%'"

crash_at(){ echo "== waiting for boundary: $1"; waitfor "$2" 150 || { echo "boundary never reached"; stop; exit 1; }
            sleep "${3:-1}"; echo "== CRASH (SIGKILL) at $1"; stop; }
case "$SCENARIO" in
  AFTER_R1)     crash_at "verdict r1 persisted, before repair" "$F1" 0 ;;
  DURING_R2)    crash_at "reviewer round 2 in flight"          "$R2START" 3 ;;
  DURING_FINAL) crash_at "final repair in flight (after r2)"   "$F2" 3 ;;
  DOUBLE_FINAL) crash_at "final repair in flight (after r2)"   "$F2" 3 ;;
  QUOTA_R2) echo "== no crash: round 2 is refused by a usage limit, the wait must persist and retry at round 2" ;;
  OVERLOAD_BUILDER) echo "== no crash: the Builder's first call is refused with a 529; the session must pause and a wake must persist"; expedite ;;
  OVERLOAD_DIRECTOR) ;;
  QUOTA_WAIT_RESTART) crash_at "review wait recorded, retry not yet due" "SELECT COUNT(*) FROM pending_reviews WHERE chat_id='$SCHAT'" 2 ;;
  QUOTA_CRASH_FINAL) crash_at "retry path: final repair in flight (after the retried r2)" "$F2" 3 ;;
  NONE) ;;
esac
# only a crashed server is restarted (QUOTA_R2 never crashes; a second boot on a live port is a zombie)
if [ "$SCENARIO" != NONE ] && [ "$SCENARIO" != QUOTA_R2 ] && [ "$SCENARIO" != OVERLOAD_BUILDER ] && [ "$SCENARIO" != OVERLOAD_DIRECTOR ]; then
  echo "== restart #1"; boot
  if [ "$SCENARIO" = DOUBLE_FINAL ]; then
    # crash again while the CONTINUATION builder is working (its recipe sleeps 12s)
    CONT="SELECT COUNT(*) FROM events WHERE chat_id='$SCHAT' AND kind='user_message' AND payload LIKE '%interrupted%'"
    crash_at "continuation builder in flight" "$CONT" 4
    echo "== restart #2"; boot
  fi
fi
if [ "${RESUME_AFTER_RESTART:-}" = 1 ]; then
  # what a human does with a project the restart left PAUSED: press Resume
  sleep 8; RUNID=$(q "SELECT id FROM project_runs"); ST=$(q "SELECT state FROM project_runs")
  echo "== run state after restart: $ST — pressing Resume"
  curl -s -b "$CJ" -X POST "http://127.0.0.1:$PORT/api/project-runs/$RUNID/resume" | head -c 200; echo
fi
echo "== waiting for the session to finish"
waitfor "SELECT COUNT(*) FROM pd_sessions WHERE key='S1.1' AND status IN ('completed','failed','needs_attention','abandoned')" 240 || echo "== session did not reach a terminal status in time"
sleep "${SETTLE:-3}"; stop
node "$RR/assert.cjs" "$DD/tandem.db" "$STATE" "$SCENARIO" "$SCHAT" "$PROJ"
