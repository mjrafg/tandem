#!/bin/bash
# An agent hands the user a file: the tandem_share_file tool (its own MCP
# server, served to the Builder, the Reviewers and the Director), the route
# behind it, the download, and every way a share must be refused.
# Real isolated Tandem; each role is played by the real MCP share server.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8014}"; B="http://127.0.0.1:$PORT"
mkdir -p "$RR/.work"; DD=$RR/.work/data; PROJ=$RR/.work/proj; OUTSIDE=$RR/.work/outside
rm -rf "$DD" "$PROJ" "$OUTSIDE"; mkdir -p "$DD" "$PROJ/dist" "$PROJ/.git" "$OUTSIDE"
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — ${3:0:300}}"; BAD=$((BAD+1)); fi; }
jget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{console.log("");return}try{const v=eval(process.argv[1]);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$2"; }
is(){ [ "$(jget "$1" "$2")" = true ] && echo 1 || echo 0; }
sha(){ shasum -a 256 "$1" | cut -d' ' -f1; }

# ---- the project the agent worked in
printf '%%PDF-1.4\nquarterly report\n' > "$PROJ/dist/report.pdf"
printf '# notes\n' > "$PROJ/notes.md"
node -e 'require("fs").writeFileSync(process.argv[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64"))' "$PROJ/dist/chart.png"
head -c 4096 /dev/urandom > "$PROJ/dist/voice.mp3"
printf '<script>alert(document.cookie)</script>' > "$PROJ/dist/page.html"
printf '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>' > "$PROJ/dist/logo.svg"
printf 'secret\n' > "$OUTSIDE/secret.txt"
ln -s "$OUTSIDE/secret.txt" "$PROJ/leak.txt"
printf '[core]\n' > "$PROJ/.git/config"
mkdir -p "$PROJ/assets"; printf 'a\n' > "$PROJ/assets/a.txt"
truncate -s 201M "$PROJ/dist/huge.bin"   # sparse: over the limit without writing 201 MB
printf 'Korean content\n' > "$PROJ/dist/보고서.txt"

ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken)
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SRV=$!
for i in $(seq 1 40); do curl -fsS "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
P=$(api -d "{\"dirPath\":\"$PROJ\"}" "$B/api/projects/directory"); PID=$(jget "$P" 'r.id')
C=$(api -d "{\"projectId\":\"$PID\"}" "$B/api/chats"); CHAT=$(jget "$C" 'r.id')
[ -n "$CHAT" ] || { echo "setup failed: $P $C"; kill -9 $SRV; exit 1; }
mcp(){ # ROLE, then JSON-RPC lines on stdin — the real share server, as that role would run it
  ( cat; sleep 3 ) | env TANDEM_INTERNAL_URL="$B/api/internal/workdir" TANDEM_CHAT_ID="$CHAT" TANDEM_INTERNAL_TOKEN=devtoken TANDEM_LOGICAL_ROLE="$1" node "$ROOT/server/src/mcp-share.cjs" 2>/dev/null; }
callshare(){ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"tandem_share_file\",\"arguments\":$2}}" | mcp "$1"; }
share(){ curl -s -H 'content-type: application/json' -d "{\"token\":\"${2:-devtoken}\",\"chatId\":\"$CHAT\",\"path\":$1${3:+,$3}}" "$B/api/internal/share-file"; }
events(){ api "$B/api/chats/$CHAT/events" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).events)))'; }
get(){ curl -s -b "$CJ" -D "$DD/h" -o "$DD/body" "$@"; }
hdr(){ grep -i "^$1:" "$DD/h" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

echo "== the Builder's tool"
TOOLS=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tandem_share_file","arguments":{"path":"dist/report.pdf","note":"The quarterly report"}}}' | mcp builder)
check "the Builder is offered tandem_share_file" "$(printf '%s' "$TOOLS" | grep -q '"name":"tandem_share_file"' && echo 1 || echo 0)"
WD=$( ( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2 ) \
  | env TANDEM_INTERNAL_URL="$B/api/internal/workdir" TANDEM_CHAT_ID="$CHAT" TANDEM_INTERNAL_TOKEN=devtoken node "$ROOT/server/src/mcp-workdir.cjs" 2>/dev/null )
check "   and only from the share server — the Builder is not offered it twice" "$(printf '%s' "$WD" | grep -q 'tandem_share_file' && echo 0 || echo 1)"
check "calling it shares the file and tells the Builder the user has a link" "$(printf '%s' "$TOOLS" | grep -q 'Shared \\"report.pdf\\"' && echo 1 || echo 0)" "$(printf '%s' "$TOOLS" | tail -c 400)"
EV=$(events)
check "the chat shows a download card for it, from the Builder" "$(is "$EV" "r.some(e=>e.kind==='file_output' && e.payload.name==='report.pdf' && e.payload.note==='The quarterly report' && e.payload.path==='dist/report.pdf' && e.payload.by==='builder')")" "$(jget "$EV" 'r.filter(e=>e.kind==="file_output")')"
RID=$(jget "$EV" "r.find(e=>e.kind==='file_output').payload.id")

echo "== a Reviewer and the Director, which cannot write to the project"
RL=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | mcp builder_reviewer)
check "a Reviewer is offered the tool, and told its access is read-only" "$(printf '%s' "$RL" | grep -q 'read-only' && printf '%s' "$RL" | grep -q 'tandem_share_file' && echo 1 || echo 0)"
R=$(callshare builder_reviewer '{"content":"# Review\n\nThe totals are off by one on the last row.\n","name":"review.md","note":"My review notes"}')
check "a Reviewer hands over a report it wrote, as content" "$(printf '%s' "$R" | grep -q 'Shared \\"review.md\\"' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
EV=$(events)
check "   the card says it came from the Reviewer, and names no project path" "$(is "$EV" "r.some(e=>e.kind==='file_output' && e.payload.name==='review.md' && e.payload.by==='builder_reviewer' && e.payload.path==='')")" "$(jget "$EV" 'r.filter(e=>e.kind==="file_output").map(e=>e.payload.name+":"+e.payload.by)')"
REV=$(jget "$EV" "r.find(e=>e.payload&&e.payload.name==='review.md').payload.id")
get "$B/api/deliverables/$REV"
check "   the download is exactly what the Reviewer wrote" "$( [ "$(cat "$DD/body")" = "$(printf '# Review\n\nThe totals are off by one on the last row.\n')" ] && echo 1 || echo 0)" "$(cat "$DD/body")"
check "   typed from its name" "$( [ "$(hdr content-type)" = text/markdown ] && echo 1 || echo 0)" "$(hdr content-type)"
check "   and nothing was written into the project" "$( [ ! -e "$PROJ/review.md" ] && echo 1 || echo 0)"
R=$(callshare builder_reviewer '{"path":"dist/chart.png","note":"The chart that renders wrong"}')
check "a Reviewer can share an existing file it can read, such as a screenshot" "$(printf '%s' "$R" | grep -q 'Shared' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 200)"
R=$(callshare director '{"content":"month,revenue\nJan,1\n","name":"brief.csv"}')
EV=$(events)
check "the Director hands over a file too, credited to the Director" "$(is "$EV" "r.some(e=>e.kind==='file_output' && e.payload.name==='brief.csv' && e.payload.by==='director')")" "$(printf '%s' "$R" | tail -c 200)"
R=$(share 'null' devtoken '"content":"x"')
check "content without a name is refused" "$(is "$R" "r.ok===false && /name/.test(r.error)")" "$R"
R=$(share '"notes.md"' devtoken '"content":"x","name":"a.txt"')
check "a path and content together are refused" "$(is "$R" "r.ok===false && /not both/.test(r.error)")" "$R"
BIG=$(node -e 'console.log(JSON.stringify("x".repeat(5*1024*1024+1)))')
R=$(curl -s -H 'content-type: application/json' --data-binary @- "$B/api/internal/share-file" <<< "{\"token\":\"devtoken\",\"chatId\":\"$CHAT\",\"content\":$BIG,\"name\":\"big.txt\"}")
check "content over 5 MB is refused, with the advice to share a file" "$(is "$R" "r.ok===false && /limit/.test(r.error)")" "$(printf '%s' "$R" | tail -c 200)"
R=$(share 'null' devtoken '"content":"x","name":"y.txt","role":"superuser"')
check "an unknown role in the call is not believed — it is recorded as the Builder" "$(is "$(events)" "r.some(e=>e.kind==='file_output' && e.payload.name==='y.txt' && e.payload.by==='builder')")"

echo "== the download"
get "$B/api/deliverables/$RID"
check "it downloads the exact bytes that were shared" "$( [ "$(sha "$DD/body")" = "$(sha "$PROJ/dist/report.pdf")" ] && echo 1 || echo 0)"
check "   as an attachment with its name" "$( [[ "$(hdr content-disposition)" == 'attachment; filename="report.pdf"'* ]] && echo 1 || echo 0)" "$(hdr content-disposition)"
check "   typed as a PDF, and the browser may not guess otherwise" "$( [ "$(hdr content-type)" = application/pdf ] && [ "$(hdr x-content-type-options)" = nosniff ] && echo 1 || echo 0)" "$(hdr content-type)"
check "   the event's checksum matches the file" "$(is "$EV" "r.find(e=>e.kind==='file_output').payload.sha256==='$(sha "$PROJ/dist/report.pdf")'")"
check "downloading needs you to be signed in" "$(( $(curl -s -o /dev/null -w '%{http_code}' "$B/api/deliverables/$RID") == 401 ))"
check "an unknown or malformed id is not found" "$(( $(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$B/api/deliverables/00000000-0000-0000-0000-000000000000") == 404 && $(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$B/api/deliverables/..%2F..%2Fetc") == 404 ))"

echo "== it is a copy"
ORIG=$(sha "$PROJ/dist/report.pdf")
printf 'changed afterwards\n' > "$PROJ/dist/report.pdf"
get "$B/api/deliverables/$RID"
check "editing the original afterwards does not change what the user was given" "$( [ "$(sha "$DD/body")" = "$ORIG" ] && echo 1 || echo 0)"
rm "$PROJ/dist/report.pdf"
check "   nor does deleting it — the way a finished project's worktree goes" "$(( $(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$B/api/deliverables/$RID") == 200 ))"

echo "== paths"
R=$(share "\"$PROJ/notes.md\"")
check "an absolute path inside the working directory is fine" "$(is "$R" "r.ok===true && r.name==='notes.md'")" "$R"
R=$(share '"dist/보고서.txt"'); KID=$(jget "$R" 'r.id')
get "$B/api/deliverables/$KID"
check "a non-English file name survives into the download (RFC 5987)" "$( [[ "$(hdr content-disposition)" == *"filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt"* ]] && echo 1 || echo 0)" "$(hdr content-disposition)"
R=$(share '"dist/chart.png"' devtoken '"name":"q3-chart.png"')
check "the agent can give the download a different name" "$(is "$R" "r.name==='q3-chart.png'")" "$R"
R=$(share '"dist/chart.png"' devtoken '"name":"../../evil.png"')
check "   but never a path in that name" "$(is "$R" "r.ok===true && r.name==='evil.png'")" "$R"

echo "== refused"
for case in "../../outside/secret.txt|a path climbing out of the project" \
            "$OUTSIDE/secret.txt|an absolute path outside it" \
            "leak.txt|a symlink that points outside it" \
            ".git/config|git's own directory" ; do
  pth=${case%%|*}; why=${case#*|}
  R=$(share "\"$pth\"")
  check "refused: $why" "$(is "$R" 'r.ok===false')" "$R"
done
check "   and the secret never reached the store" "$(grep -rl 'secret' "$DD/deliverables" 2>/dev/null | grep -c . | grep -qx 0 && echo 1 || echo 0)"
R=$(share '"assets"')
check "a folder is refused, with the advice to zip it" "$(is "$R" "r.ok===false && /zip/.test(r.error)")" "$R"
R=$(share '"dist/nope.pdf"')
check "a missing file is refused" "$(is "$R" 'r.ok===false')" "$R"
R=$(share '""')
check "no path is refused" "$(is "$R" 'r.ok===false')" "$R"
R=$(share '"dist/huge.bin"')
check "a file over 200 MB is refused" "$(is "$R" "r.ok===false && /limit/.test(r.error)")" "$R"
R=$(share '"notes.md"' wrong-token)
check "a call without the internal token is refused" "$(is "$R" 'r.ok===false')" "$R"

echo "== what the browser may show"
IMG=$(jget "$(share '"dist/chart.png"')" 'r.id')
get "$B/api/deliverables/$IMG?inline=1"
check "an image previews inline as an image" "$( [ "$(hdr content-type)" = image/png ] && [[ "$(hdr content-disposition)" == inline* ]] && echo 1 || echo 0)" "$(hdr content-type) / $(hdr content-disposition)"
HTML=$(jget "$(share '"dist/page.html"')" 'r.id')
get "$B/api/deliverables/$HTML?inline=1"
check "HTML is never shown inline, even when asked" "$( [[ "$(hdr content-disposition)" == attachment* ]] && [ "$(hdr content-type)" = application/octet-stream ] && echo 1 || echo 0)" "$(hdr content-type) / $(hdr content-disposition)"
check "   and carries a sandbox policy in case anything opens it" "$( [[ "$(hdr content-security-policy)" == *sandbox* ]] && echo 1 || echo 0)"
SVG=$(jget "$(share '"dist/logo.svg"')" 'r.id')
get "$B/api/deliverables/$SVG?inline=1"
check "SVG, which can carry script, is only ever opaque bytes" "$( [ "$(hdr content-type)" = application/octet-stream ] && [[ "$(hdr content-disposition)" == attachment* ]] && echo 1 || echo 0)" "$(hdr content-type)"

echo "== audio and video (Safari needs ranges to play them)"
MP3=$(jget "$(share '"dist/voice.mp3"')" 'r.id')
get -H 'Range: bytes=0-1' "$B/api/deliverables/$MP3?inline=1"
check "a range request gets 206 and exactly those bytes" "$( grep -q '^HTTP/1.1 206' "$DD/h" && [ "$(hdr content-range)" = 'bytes 0-1/4096' ] && [ "$(wc -c < "$DD/body" | tr -d ' ')" = 2 ] && echo 1 || echo 0)" "$(head -1 "$DD/h") $(hdr content-range)"
get -H 'Range: bytes=-3' "$B/api/deliverables/$MP3?inline=1"
check "   a suffix range gets the last bytes" "$( [ "$(hdr content-range)" = 'bytes 4093-4095/4096' ] && [ "$(tail -c 3 "$PROJ/dist/voice.mp3" | shasum | cut -c1-8)" = "$(shasum < "$DD/body" | cut -c1-8)" ] && echo 1 || echo 0)" "$(hdr content-range)"
get -H 'Range: bytes=9999-' "$B/api/deliverables/$MP3?inline=1"
check "   a range past the end is 416" "$(grep -q '^HTTP/1.1 416' "$DD/h" && echo 1 || echo 0)" "$(head -1 "$DD/h")"
check "   and the audio is served as audio" "$(get "$B/api/deliverables/$MP3?inline=1"; [ "$(hdr content-type)" = audio/mpeg ] && echo 1 || echo 0)"

echo "== export"
MD=$(api "$B/api/chats/$CHAT/export?format=markdown" 2>/dev/null)
check "a chat export lists the shared files" "$(printf '%s' "$MD" | grep -q 'Shared file:\*\* report.pdf' && echo 1 || echo 0)" "$(printf '%s' "$MD" | grep -i shared | head -2)"

echo "== a deleted chat takes its files with it"
N=$(ls "$DD/deliverables" | wc -l | tr -d ' ')
curl -s -b "$CJ" -X DELETE "$B/api/chats/$CHAT" >/dev/null
check "its downloads are gone" "$(( $(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' "$B/api/deliverables/$RID") == 404 ))"
check "   and so are the stored copies ($N of them)" "$( [ -z "$(ls -A "$DD/deliverables" 2>/dev/null)" ] && echo 1 || echo 0)" "$(ls "$DD/deliverables" | head -3)"

kill -9 $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo; if [ $BAD = 0 ]; then echo "ALL DELIVERABLE CHECKS PASSED"; else echo "$BAD FAILED"; fi
exit $BAD
