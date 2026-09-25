#!/bin/bash
# The Builder generates an image from a prompt: the tandem_generate_image tool
# (its own MCP server), the route behind it, both providers (Codex's built-in
# image tool, and the OpenAI Images API), saving into the project, the chat
# card, the settings, and every way a generation must be refused.
# Real isolated Tandem; Codex and the Images API are local stand-ins.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8017}"; OPORT=$((PORT+1)); B="http://127.0.0.1:$PORT"
W=$RR/.work; DD=$W/data; PROJ=$W/proj; CH=$W/codex-home
rm -rf "$W"; mkdir -p "$DD" "$PROJ/assets" "$CH"
lsof -ti tcp:$PORT tcp:$OPORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — ${3:0:300}}"; BAD=$((BAD+1)); fi; }
jget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{console.log("");return}try{const v=eval(process.argv[1]);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$2"; }
is(){ [ "$(jget "$1" "$2")" = true ] && echo 1 || echo 0; }
lines(){ [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

printf 'existing\n' > "$PROJ/assets/taken.png"
export FAKE_CODEX_LOG=$W/codex.log FAKE_CODEX_MODE_FILE=$W/codex.mode FAKE_OPENAI_LOG=$W/openai.log FAKE_OPENAI_MODE_FILE=$W/openai.mode
PORT=$OPORT node "$RR/fake-openai.cjs" & OAI=$!

ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken CODEX_HOME="$CH"
     TANDEM_CODEX_BIN="$RR/fake-codex.cjs" TANDEM_OPENAI_BASE_URL="http://127.0.0.1:$OPORT/v1")
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SRV=$!
for i in $(seq 1 40); do curl -fsS "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
P=$(api -d "{\"dirPath\":\"$PROJ\"}" "$B/api/projects/directory"); PID=$(jget "$P" 'r.id')
C=$(api -d "{\"projectId\":\"$PID\"}" "$B/api/chats"); CHAT=$(jget "$C" 'r.id')
[ -n "$CHAT" ] || { echo "setup failed: $P $C"; kill -9 $SRV $OAI; exit 1; }
events(){ api "$B/api/chats/$CHAT/events" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).events)))'; }
# the real image server, started (like the CLI does) in the agent's working directory
mcp(){ ( cat; sleep "${WAIT:-4}" ) | ( cd "$PROJ" && env TANDEM_INTERNAL_URL="$B/api/internal/workdir" TANDEM_CHAT_ID="$CHAT" TANDEM_INTERNAL_TOKEN=devtoken TANDEM_LOGICAL_ROLE="${ROLE:-builder}" node "$ROOT/server/src/mcp-image.cjs" 2>/dev/null ); }
gen(){ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"tandem_generate_image\",\"arguments\":$1}}" | mcp; }
route(){ curl -s -H 'content-type: application/json' -d "$1" "$B/api/internal/generate-image"; }
settings(){ api -X PUT -d "$1" "$B/api/settings"; }

echo "== settings"
S=$(api "$B/api/settings")
check "on by default, on Codex, with Codex's own default model" "$(is "$S" "r.imageGeneration.enabled===true && r.imageGeneration.provider==='codex' && r.imageGeneration.model===''")" "$(jget "$S" 'r.imageGeneration')"
PR=$(api "$B/api/settings/effective-prompt?role=builder")
check "the Builder is told it can generate images" "$(printf '%s' "$PR" | grep -q 'tandem_generate_image' && echo 1 || echo 0)"

echo "== the tool"
L=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | WAIT=1 mcp)
check "the Builder is offered tandem_generate_image, with prompt required" "$(printf '%s' "$L" | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).result.tools[0];console.log(t.name==="tandem_generate_image"&&t.inputSchema.required.includes("prompt")?1:0)})')"

echo "== Codex"
R=$(gen '{"prompt":"A red paper boat on calm blue water, flat illustration","shape":"landscape","save_to":"assets/hero.png","note":"Hero image"}')
check "it generates, and tells the Builder the user can see it and where it was saved" "$(printf '%s' "$R" | grep -q 'Generated \\"hero.png\\"' && printf '%s' "$R" | grep -q 'assets/hero.png' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 400)"
check "   with the image's real size" "$(printf '%s' "$R" | grep -q '1×1 PNG' && echo 1 || echo 0)"
check "the image is saved in the project" "$( [ -s "$PROJ/assets/hero.png" ] && [ "$(head -c 4 "$PROJ/assets/hero.png" | od -An -tx1 | tr -d ' ')" = 89504e47 ] && echo 1 || echo 0)"
EV=$(events)
check "the chat shows it as a generated image from the Builder" "$(is "$EV" "r.some(e=>e.kind==='file_output' && e.payload.name==='hero.png' && e.payload.mime==='image/png' && e.payload.by==='builder' && e.payload.path==='assets/hero.png' && e.payload.generated.provider==='codex' && /paper boat/.test(e.payload.generated.prompt))")" "$(jget "$EV" 'r.filter(e=>e.kind==="file_output").map(e=>e.payload)')"
ID=$(jget "$EV" 'r.find(e=>e.kind==="file_output").payload.id')
check "   and it previews inline as an image" "$( [ "$(curl -s -b "$CJ" -o /dev/null -w '%{content_type}' "$B/api/deliverables/$ID?inline=1")" = image/png ] && echo 1 || echo 0)"
A=$(tail -1 "$FAKE_CODEX_LOG")
check "Codex is run read-only, at low effort, with the prompt and the shape" "$(is "$A" "r.args.includes('read-only') && r.args.includes('model_reasoning_effort=\"low\"') && /paper boat/.test(r.args.at(-1)) && /landscape/.test(r.args.at(-1))")" "$A"
check "   in a scratch directory, never the project" "$(is "$A" "!r.cwd.startsWith('$PROJ')")" "$(jget "$A" 'r.cwd')"
check "   with no -m while the model is Codex's default" "$(is "$A" "!r.args.includes('-m')")"
check "Codex's own copy is cleaned up" "$( [ -z "$(ls -A "$CH/generated_images" 2>/dev/null)" ] && echo 1 || echo 0)" "$(ls "$CH/generated_images")"

settings '{"imageGeneration":{"model":"gpt-5.6-terra"}}' >/dev/null
R=$(gen '{"prompt":"a small green cactus in a terracotta pot"}')
A=$(tail -1 "$FAKE_CODEX_LOG")
check "the model chosen in settings drives Codex" "$(is "$A" "r.args[r.args.indexOf('-m')+1]==='gpt-5.6-terra'")" "$A"
check "without save_to nothing is written to the project, and the name comes from the prompt" "$( [ "$(ls "$PROJ/assets" | sort | tr '\n' ' ')" = 'hero.png taken.png ' ] && printf '%s' "$R" | grep -q 'a-small-green-cactus-in-a.png' && echo 1 || echo 0)" "$(ls "$PROJ/assets") $(printf '%s' "$R" | tail -c 200)"

echo "== refused"
N=$(lines "$FAKE_CODEX_LOG")
R=$(gen '{"prompt":"x","save_to":"assets/taken.png"}')
check "an existing file is never overwritten" "$(printf '%s' "$R" | grep -q 'already exists' && [ "$(cat "$PROJ/assets/taken.png")" = existing ] && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
R=$(gen '{"prompt":"x","save_to":"../escape.png"}')
check "save_to cannot leave the working directory" "$(printf '%s' "$R" | grep -q 'outside' && [ ! -e "$W/escape.png" ] && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
check "   and neither refusal spent a generation" "$(( $(lines "$FAKE_CODEX_LOG") == N ))"
R=$(gen '{"prompt":"   "}')
check "an empty prompt is refused" "$(printf '%s' "$R" | grep -q 'Describe the image' && echo 1 || echo 0)"
for role in builder_reviewer director_reviewer director reviewer; do
  R=$(route "{\"token\":\"devtoken\",\"chatId\":\"$CHAT\",\"role\":\"$role\",\"prompt\":\"x\"}")
  check "the $role cannot generate images, even by calling the route" "$(is "$R" "r.ok===false && /Only the Builder/.test(r.error)")" "$R"
done
R=$(route "{\"token\":\"nope\",\"chatId\":\"$CHAT\",\"role\":\"builder\",\"prompt\":\"x\"}")
check "a call without the internal token is refused" "$(is "$R" 'r.ok===false')"
echo noimage > "$FAKE_CODEX_MODE_FILE"
R=$(gen '{"prompt":"x"}')
check "Codex finishing without an image is an error that says what Codex said" "$(printf '%s' "$R" | grep -q 'without generating an image' && printf '%s' "$R" | grep -q 'cannot generate' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
echo fail > "$FAKE_CODEX_MODE_FILE"
R=$(gen '{"prompt":"x"}')
check "a Codex failure is reported with its reason" "$(printf '%s' "$R" | grep -q 'usage limit' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
rm -f "$FAKE_CODEX_MODE_FILE"

echo "== OpenAI Images API"
S=$(settings '{"imageGeneration":{"provider":"openai","model":""}}')
check "switching to OpenAI picks an image model, not the chat model" "$(is "$S" "r.imageGeneration.model==='gpt-image-2'")" "$(jget "$S" 'r.imageGeneration')"
R=$(gen '{"prompt":"a lighthouse"}')
check "without an API key it says where to choose one" "$(printf '%s' "$R" | grep -q 'Admin → Image generation' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
CRED=$(api -d '{"name":"OpenAI","type":"bearer_token","data":{"token":"sk-test-123"}}' "$B/api/credentials"); CID=$(jget "$CRED" 'r.id')
settings "{\"imageGeneration\":{\"credentialId\":\"$CID\",\"quality\":\"high\"}}" >/dev/null
R=$(gen '{"prompt":"a lighthouse at dusk","shape":"portrait","transparent":true,"name":"lighthouse"}')
check "it generates through the API" "$(printf '%s' "$R" | grep -q 'Generated \\"lighthouse.png\\"' && printf '%s' "$R" | grep -q 'openai/gpt-image-2' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
O=$(tail -1 "$FAKE_OPENAI_LOG")
check "   with the stored key, model, size, quality and transparency" "$(is "$O" "r.url==='/v1/images/generations' && r.auth==='Bearer sk-test-123' && r.body.model==='gpt-image-2' && r.body.size==='1024x1536' && r.body.quality==='high' && r.body.background==='transparent' && r.body.prompt==='a lighthouse at dusk'")" "$O"
check "   and the card names the provider" "$(is "$(events)" "r.some(e=>e.kind==='file_output' && e.payload.name==='lighthouse.png' && e.payload.generated.provider==='openai' && e.payload.generated.model==='gpt-image-2')")"
echo refuse > "$FAKE_OPENAI_MODE_FILE"
R=$(gen '{"prompt":"x"}')
check "an API refusal is passed on with its message" "$(printf '%s' "$R" | grep -q 'safety system' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 300)"
rm -f "$FAKE_OPENAI_MODE_FILE"
S=$(settings '{"imageGeneration":{"provider":"codex"}}')
check "switching back to Codex drops the image model" "$(is "$S" "r.imageGeneration.model===''")" "$(jget "$S" 'r.imageGeneration')"

echo "== switched off"
settings '{"imageGeneration":{"enabled":false}}' >/dev/null
R=$(gen '{"prompt":"x"}')
check "a generation is refused while it is off" "$(printf '%s' "$R" | grep -q 'turned off' && echo 1 || echo 0)" "$(printf '%s' "$R" | tail -c 200)"
PR=$(api "$B/api/settings/effective-prompt?role=builder")
check "   and the Builder is not told about it" "$(printf '%s' "$PR" | grep -q 'tandem_generate_image' && echo 0 || echo 1)"

kill -9 $SRV $OAI 2>/dev/null
echo; [ $BAD -eq 0 ] && echo "ALL IMAGE GENERATION CHECKS PASSED" || { echo "$BAD CHECK(S) FAILED"; tail -20 "$DD/server.log"; exit 1; }
