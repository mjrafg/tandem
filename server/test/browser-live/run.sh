#!/bin/bash
# The live browser view, end to end, on a REAL isolated Tandem with a REAL
# Chromium. No model is called: the "agent" is driven through the same internal
# route the MCP browser proxy uses, and a small local site is the page under
# test. Work dirs live under ./.work (gitignored).
#
#   run.sh     boots on PORT (default 7981), prints checks, exits 1 on any failure
#
# Needs Playwright's Chromium (the server's own browser dependency).
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7981}"; SITE_PORT="${SITE_PORT:-7982}"
W="$RR/.work"; DD=$W/data; PROJ=$W/proj
rm -rf "$W"; mkdir -p "$DD" "$PROJ"
for p in $PORT $SITE_PORT; do lsof -ti tcp:$p 2>/dev/null | xargs -r kill -9 2>/dev/null; done; sleep 0.3
git -C "$PROJ" init -q

# ---- the site under test: a button and an input at fixed positions, and a second page
node -e '
const http = require("http");
const one = `<!doctype html><title>One</title><body style="margin:0">
<button id="b" style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="document.title=\"clicked\"">Press</button>
<input id="i" style="position:absolute;left:20px;top:120px;width:300px;height:40px">
<div style="height:3000px"></div></body>`;
http.createServer((q, r) => {
  r.writeHead(200, { "content-type": "text/html" });
  r.end(q.url === "/two" ? "<!doctype html><title>Two</title><h1>Page two</h1>" : one);
}).listen(Number(process.argv[1]), "127.0.0.1");' "$SITE_PORT" & SITE=$!
SITE_URL="http://127.0.0.1:$SITE_PORT"

ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken
     TANDEM_CLAUDE_BIN="$ROOT/server/test/review-reset/fake-claude.cjs" TANDEM_CODEX_BIN="$ROOT/server/test/review-reset/fake-codex.cjs")
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SPID=$!
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"; B="http://127.0.0.1:$PORT"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null
COOKIE=$(awk '$6=="tandem_sid"{print $6"="$7}' "$CJ")

BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — $3}"; BAD=$((BAD+1)); fi; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
js(){ printf '%s' "$1" | node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0,"utf8")); } catch { console.log(0); process.exit(); } try { console.log(eval(process.argv[1]) ? 1 : 0); } catch (e) { console.log(0); }' "$2"; }
# agent <tool> <args-json> [role] — one browser tool call, as the MCP proxy makes it
agent(){ curl -s -H 'content-type: application/json' -d "{\"token\":\"devtoken\",\"chatId\":\"$CHAT\",\"role\":\"${3:-builder}\",\"tool\":\"$1\",\"args\":$2}" "$B/api/internal/browser"; }
input(){ api -d "$1" "$B/api/chats/$CHAT/browser/input"; }
# reader <role> <outfile> — records the live stream: one JSON line per event, frames abbreviated
reader(){ node -e '
const http = require("http"); const fs = require("fs");
const [url, cookie, out] = process.argv.slice(1);
http.get(url, { headers: { cookie } }, (res) => {
  let buf = "";
  res.setEncoding("utf8");
  res.on("data", (c) => {
    buf += c; let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = (block.match(/^event: (.*)$/m) || [])[1]; const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data);
      const rec = ev === "frame" ? { head: d.data.slice(0, 4), len: d.data.length, width: d.width, height: d.height } : d;
      fs.appendFileSync(out, JSON.stringify({ at: Date.now(), event: ev, data: rec }) + "\n");
    }
  });
});' "$B/api/chats/$CHAT/browser/live?role=$1" "$COOKIE" "$2" >/dev/null 2>&1 & echo $!; }
# lines <file> — the recorded events as a JSON array
lines(){ node -e 'const fs=require("fs"); try { console.log(JSON.stringify(fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse))); } catch { console.log("[]"); }' "$1"; }
# waitlog <file> <expression over the array r> <seconds>
waitlog(){ for i in $(seq 1 $(( $3 * 5 ))); do [ "$(js "$(lines "$1")" "$2")" = 1 ] && return 0; sleep 0.2; done; return 1; }
ok(){ "$@" && echo 1 || echo 0; }

P=$(api -d "{\"dirPath\":\"$PROJ\"}" "$B/api/projects/directory"); PID=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$P")
C=$(api -d "{\"projectId\":\"$PID\"}" "$B/api/chats"); CHAT=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$C")
[ -n "$CHAT" ] || { echo "setup failed: $C"; kill -9 $SPID $SITE; exit 1; }

echo "== watching before any browser exists"
L1="$W/builder.jsonl"; R1=$(reader builder "$L1")
check "the stream says no browser is open, and watching opens none" "$(ok waitlog "$L1" 'r.some(e=>e.event==="state" && e.data.running===false)' 5)" "$(lines "$L1")"

echo "== the agent opens a page"
A=$(agent browser_navigate "{\"url\":\"$SITE_URL/\"}")
check "the agent's navigation worked" "$(js "$A" '!r.isError')" "$A"
check "the stream reports the open page and its address" "$(ok waitlog "$L1" "r.some(e=>e.event==='state' && e.data.running && e.data.url==='$SITE_URL/' && e.data.title==='One')" 8)" "$(lines "$L1" | tail -c 600)"
check "real frames of the page arrive: JPEG, at the page's size" "$(ok waitlog "$L1" 'r.some(e=>e.event==="frame" && e.data.head==="/9j/" && e.data.len>1000 && e.data.width===1280 && e.data.height===800)' 8)"

echo "== busy while the agent acts"
agent browser_wait '{"seconds":2}' >/dev/null
check "the stream shows the agent busy, then idle" "$(ok waitlog "$L1" 'r.some((e,i)=>e.event==="state" && e.data.busy && r.slice(i+1).some(x=>x.event==="state" && !x.data.busy))' 5)"

echo "== the user acts"
R=$(input '{"role":"builder","action":"click","x":120,"y":50}')
check "a click from the live view is accepted" "$(js "$R" 'r.ok')" "$R"
E=$(agent browser_evaluate '{"code":"document.title"}')
check "the click landed on the button in the agent's page" "$(js "$E" 'r.content[0].text.includes("clicked")')" "$E"
check "the agent is told the user clicked, on its next call" "$(js "$E" 'r.content[0].text.includes("the user acted in this browser") && r.content[0].text.includes("clicked at (120, 50)")')" "$E"
E=$(agent browser_evaluate '{"code":"1+1"}')
check "the agent is told only once" "$(js "$E" '!r.content[0].text.includes("the user acted")')" "$E"
input '{"role":"builder","action":"click","x":170,"y":140}' >/dev/null
R=$(input '{"role":"builder","action":"text","text":"hello secret"}')
check "typing is accepted" "$(js "$R" 'r.ok')" "$R"
E=$(agent browser_evaluate '{"code":"document.getElementById(\"i\").value"}')
check "the typed text reached the focused input" "$(js "$E" 'r.content[0].text.includes("hello secret")')" "$E"
check "the agent learns something was typed, never what" "$(js "$E" '(n=>n.includes("typed 12 characters") && !n.includes("hello secret"))(r.content[0].text.slice(r.content[0].text.indexOf("(note:")))')" "$E"
R=$(input '{"role":"builder","action":"key","key":"Enter"}')
check "a named key is accepted" "$(js "$R" 'r.ok')" "$R"
check "an unsupported key is refused" "$(( $(code -b "$CJ" -H 'content-type: application/json' -d '{"role":"builder","action":"key","key":"F13"}' "$B/api/chats/$CHAT/browser/input") == 400 ))"
R=$(input '{"role":"builder","action":"wheel","x":200,"y":200,"dx":0,"dy":800}')
# A wheel is dispatched, then applied by Chromium's compositor a few frames
# later — Playwright's mouse.wheel returns before the page has moved. The
# route deliberately does not wait for that: the panel sends a wheel batch
# every 140 ms while the user scrolls, and settling each one would back the
# input queue up behind the gesture. So poll, as any real observer would.
SCROLLED=0
for i in $(seq 1 30); do
  E=$(agent browser_evaluate '{"code":"window.scrollY"}')
  [ "$(js "$E" 'Number(r.content[0].text.match(/\d+/)[0])>0')" = 1 ] && { SCROLLED=1; break; }
  sleep 0.1
done
check "scrolling moves the agent's page" "$SCROLLED" "$E"

echo "== the user navigates"
R=$(input "{\"role\":\"builder\",\"action\":\"navigate\",\"url\":\"$SITE_URL/two\"}")
check "navigating is accepted" "$(js "$R" 'r.ok')" "$R"
check "the stream follows to the new page" "$(ok waitlog "$L1" "r.some(e=>e.event==='state' && e.data.url==='$SITE_URL/two' && e.data.title==='Two')" 8)"
input '{"role":"builder","action":"back"}' >/dev/null
check "back returns to the first page" "$(ok waitlog "$L1" "r.filter(e=>e.event==='state').pop()?.data.url==='$SITE_URL/'" 8)"
check "a javascript: address is refused" "$(( $(code -b "$CJ" -H 'content-type: application/json' -d '{"role":"builder","action":"navigate","url":"javascript:alert(1)"}' "$B/api/chats/$CHAT/browser/input") == 400 ))"
check "a file: address is refused" "$(( $(code -b "$CJ" -H 'content-type: application/json' -d '{"role":"builder","action":"navigate","url":"file:///etc/passwd"}' "$B/api/chats/$CHAT/browser/input") == 400 ))"

echo "== the user's input waits for the agent's action"
agent browser_wait '{"seconds":3}' >/dev/null & AW=$!
sleep 0.5
T0=$(date +%s%N); input '{"role":"builder","action":"click","x":5,"y":5}' >/dev/null; T1=$(date +%s%N)
wait $AW
check "a click during an agent action ran after it, not in the middle" "$(( (T1 - T0) / 1000000 >= 2000 ))" "$(( (T1 - T0) / 1000000 ))ms"

echo "== the Reviewer's browser is separate"
check "acting in a Reviewer browser that is not open is refused" "$(( $(code -b "$CJ" -H 'content-type: application/json' -d '{"role":"reviewer","action":"click","x":1,"y":1}' "$B/api/chats/$CHAT/browser/input") == 409 ))"
L2="$W/reviewer.jsonl"; R2=$(reader reviewer "$L2")
check "the Reviewer's stream says it has no browser while the Builder has one" "$(ok waitlog "$L2" 'r.some(e=>e.event==="state" && e.data.running===false)' 5)"
R=$(input '{"role":"reviewer","action":"start"}')
check "the user can open the Reviewer's browser" "$(js "$R" 'r.ok')" "$R"
check "the Reviewer's stream then shows its own blank page" "$(ok waitlog "$L2" 'r.some(e=>e.event==="state" && e.data.running && e.data.url==="about:blank")' 8)"
E=$(agent browser_evaluate '{"code":"location.href"}' reviewer)
check "the Reviewer agent sees its own page, not the Builder's" "$(js "$E" 'r.content[0].text.includes("about:blank")')" "$E"

echo "== boundaries"
check "watching needs a signed-in user" "$(( $(code --max-time 3 "$B/api/chats/$CHAT/browser/live?role=builder") == 401 ))"
check "acting needs a signed-in user" "$(( $(code -H 'content-type: application/json' -d '{"role":"builder","action":"reload"}' "$B/api/chats/$CHAT/browser/input") == 401 ))"
check "an unknown role is refused" "$(( $(code -b "$CJ" --max-time 3 "$B/api/chats/$CHAT/browser/live?role=director") == 400 ))"
check "an unknown chat is a 404" "$(( $(code -b "$CJ" --max-time 3 "$B/api/chats/nope/browser/live?role=builder") == 404 ))"

echo "== the agent closes its browser"
agent browser_kill '{}' >/dev/null
check "the stream says the browser closed" "$(ok waitlog "$L1" 'r.filter(e=>e.event==="state").pop()?.data.running===false' 8)"

kill $R1 $R2 2>/dev/null
kill -9 $SPID $SITE 2>/dev/null; wait $SPID $SITE 2>/dev/null
echo; if [ $BAD = 0 ]; then echo "ALL BROWSER LIVE CHECKS PASSED"; else echo "$BAD FAILED"; fi
exit $BAD
