#!/bin/bash
# Video production on Tandem: channels and their versions, video projects
# pinned to a version, the production invariants (no paid work before the
# user approves, budget, idempotency, narration before timing, no reference
# asset in the engine), approvals only the user can decide, promotion, the
# reviewer's read-only engine access, and the video agents.
# Real isolated Tandem; the real tool servers; Codex and the MCP integrations
# are local stand-ins.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8031}"; B="http://127.0.0.1:$PORT"
W=$RR/.work; DD=$W/data; DEV=$W/dev; CH=$W/codex-home; ENG=$W/engine
rm -rf "$W"; mkdir -p "$DD" "$DEV" "$CH" "$ENG/ws1/inbox"
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

# passes when every word of $2 is 1 (several conditions may be given at once)
BAD=0; check(){ local v; local ok=1; [ -n "$2" ] || ok=0; for v in $2; do [ "$v" = 1 ] || ok=0; done
  if [ $ok = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — ${3:0:400}}"; BAD=$((BAD+1)); fi; }
not(){ [ "$1" = 1 ] && echo 0 || echo 1; }
jget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{console.log("");return}try{const v=eval(process.argv[1]);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$2"; }
is(){ [ "$(jget "$1" "$2")" = true ] && echo 1 || echo 0; }
has(){ printf '%s' "$1" | grep -q -- "$2" && echo 1 || echo 0; }
lines(){ [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

export FAKE_CODEX_LOG=$W/codex.log FAKE_CODEX_MODE_FILE=$W/codex.mode
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken CODEX_HOME="$CH" TANDEM_CODEX_BIN="$ROOT/server/test/image-gen/fake-codex.cjs" PROJECTS_DIR="$W/projects")
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SRV=$!
for i in $(seq 1 40); do curl -fsS "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
internal(){ curl -s -H 'content-type: application/json' -d "$2" "$B/api/internal/$1"; }

# the two stand-in integrations: a Video Engine and a paid TTS tool
ENGLOG=$W/engine.log LABSLOG=$W/labs.log
I1=$(api -d "{\"name\":\"animation engine\",\"type\":\"mcp\",\"config\":{\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"$RR/fake-mcp.cjs\"],\"env\":{\"FAKE_KIND\":\"engine\",\"FAKE_LOG\":\"$ENGLOG\",\"VIDEO_ENGINE_ROOT\":\"$ENG\"}}}" "$B/api/integrations")
api -d '{}' "$B/api/integrations/$(jget "$I1" 'r.id')/refresh-tools" >/dev/null
I2=$(api -d "{\"name\":\"ElevenLabs\",\"type\":\"mcp\",\"config\":{\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"$RR/fake-mcp.cjs\"],\"env\":{\"FAKE_KIND\":\"labs\",\"FAKE_LOG\":\"$LABSLOG\"}}}" "$B/api/integrations")
api -d '{}' "$B/api/integrations/$(jget "$I2" 'r.id')/refresh-tools" >/dev/null
check "setup: the stand-in engine is the Video Engine integration" "$( [ "$(jget "$I1" 'r.slug')" = animation_engine ] && echo 1 || echo 0)" "$I1"

# a standalone chat for developing the channel
P=$(api -d "{\"dirPath\":\"$DEV\"}" "$B/api/projects/directory"); C0=$(jget "$(api -d "{\"projectId\":\"$(jget "$P" 'r.id')\"}" "$B/api/chats")" 'r.id')
# the real channel tool server, as ROLE would run it in chat $1
ch(){ local chat=$1 role=$2 tool=$3 args=$4
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
  | ( cat; sleep 1.5 ) | ( cd "$DEV" && env TANDEM_INTERNAL_URL="$B/api/internal/workdir" TANDEM_CHAT_ID="$chat" TANDEM_INTERNAL_TOKEN=devtoken TANDEM_LOGICAL_ROLE="$role" node "$ROOT/server/src/mcp-channel.cjs" 2>/dev/null ) | tail -1 \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result;console.log((r.isError?"ERROR: ":"")+r.content[0].text)}catch{console.log("NO REPLY "+s)}})'; }
tools(){ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ( cat; sleep 1 ) \
  | env TANDEM_LOGICAL_ROLE="$1" node "$ROOT/server/src/mcp-channel.cjs" 2>/dev/null | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.tools.map(t=>t.name).join(",")))'; }
img(){ curl -s -H 'content-type: application/json' -d "$2" "$B/api/internal/generate-image" | sed "s/^/$1 /"; }
call(){ internal integration-call "{\"token\":\"devtoken\",\"chatId\":\"$1\",\"role\":\"$2\",\"tool\":\"$3\",\"args\":$4}"; }

echo "== the video agents"
AG=$(api "$B/api/agents")
check "Storyteller, Visual Director and Video Producer are Builder agents" "$(is "$AG" "['storyteller','visual-director','video-producer'].every(s=>r.some(a=>a.slug===s&&a.kind==='builder'))")"
check "Video Reviewer is a Reviewer agent" "$(is "$AG" "r.some(a=>a.slug==='video-reviewer'&&a.kind==='reviewer')")"
VR=$(jget "$AG" "r.find(a=>a.slug==='video-reviewer').id"); ST=$(jget "$AG" "r.find(a=>a.slug==='storyteller').id")
R=$(api -d '{}' "$B/api/agents/$VR/default")
check "a Reviewer agent can never be the default" "$(has "$R" 'must be a Builder Agent')" "$R"

echo "== tools per role"
check "a Builder may create and change channels, add and promote assets" "$(has "$(tools builder)" 'channel_update,asset_search,asset_add,asset_promote')" "$(tools builder)"
check "a Reviewer only reads" "$( [ "$(tools builder_reviewer)" = 'channel_list,channel_get,asset_search,video_status' ] && echo 1 || echo 0)" "$(tools builder_reviewer)"
check "only the Director asks for approval or a channel upgrade" "$(has "$(tools director)" 'video_request_production_approval') $(not "$(has "$(tools builder)" 'video_request_production_approval')")" "$(tools director)"

echo "== a channel, created in chat"
R=$(ch $C0 builder channel_update '{"create":{"name":"What If","description":"Mysterious cinematic what-if videos."},"style_bible":{"summary":"Painterly 2D, dark teal and amber, fog, low-key light.","sections":{"Palette":"teal #0e3b43, amber #e0a458","Lighting":"low-key, one warm practical"}},"entities":[{"type":"character","name":"Pip","summary":"a small copper robot explorer","description":"Round copper head, one teal eye, red scarf."}],"note":"founding identity"}')
check "created at version 1 with its Style Bible and first character" "$(has "$R" 'at version 1') $(has "$R" 'char-pip')" "$R"
CHID=$(api "$B/api/channels" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')
R=$(ch $C0 builder_reviewer channel_update '{"channel":"What If","description":"x"}')
check "a Reviewer cannot change a channel, even by calling the tool" "$(has "$R" 'ERROR')" "$R"
R=$(ch $C0 builder channel_update '{"channel":"What If","expected_version":7,"description":"x"}')
check "a stale expected_version is refused instead of overwriting" "$(has "$R" 'changed since version 7')" "$R"
R=$(img C0 "{\"token\":\"devtoken\",\"chatId\":\"$C0\",\"role\":\"builder\",\"prompt\":\"Pip, front view\",\"register\":{\"kind\":\"reference\",\"entity_id\":\"char-pip\",\"channel\":\"What If\",\"attributes\":{\"view\":\"front\"}}}")
REF=$(jget "${R#C0 }" 'r.assetId')
check "a generated reference joins the channel during channel development" "$(is "${R#C0 }" "r.assetScope==='channel' && r.assetKind==='reference'")" "$R"
S=$(ch $C0 builder asset_search '{"channel":"What If","entity_id":"char-pip"}')
check "asset_search finds it, with a small preview and no engine path (it is a reference)" "$(has "$S" "$REF") $(has "$S" 'preview') $(not "$(has "$S" 'engine_import')")" "$S"
check "   and the channel is now at version 2" "$(is "$(api "$B/api/channels/$CHID")" "r.channel.headVersion===2 && r.version.content.assetIds.includes('$REF')")"

echo "== video projects are pinned"
VA=$(api -d "{\"channelId\":\"$CHID\"}" "$B/api/video-projects"); RA=$(jget "$VA" 'r.run.id'); CA=$(jget "$VA" 'r.chat.id')
check "New Video opens a normal Project Chat pinned to the latest version" "$(is "$VA" "r.chat.kind==='project' && r.video.channelVersion===2 && r.run.video.channelVersion===2")" "$VA"
ch $C0 builder channel_update '{"channel":"What If","style_bible":{"summary":"Painterly 2D, now with rain."}}' >/dev/null
VB=$(api -d "{\"channelId\":\"$CHID\"}" "$B/api/video-projects"); RB=$(jget "$VB" 'r.run.id'); CB=$(jget "$VB" 'r.chat.id')
check "after the channel changes, a new video is pinned to version 3" "$(is "$VB" "r.video.channelVersion===3")" "$(jget "$VB" 'r.video')"
G=$(ch $CA director channel_get '{}')
check "video A still reads version 2 — the old Style Bible, and knows 3 exists" "$(has "$G" '"version": 2') $(not "$(has "$G" 'now with rain')") $(has "$G" '"latest_version": 3')" "$G"
R=$(ch $CA director video_upgrade_channel '{"reason":"use the rain look"}')
check "upgrading asks the user; nothing moves yet" "$(has "$R" 'Asked the user') $(is "$(api "$B/api/video-projects/$RA")" 'r.video.channelVersion===2')" "$R"
UP=$(jget "$(api "$B/api/video-projects/$RA")" "r.approvals.find(a=>a.kind==='channel_upgrade').id")
R=$(curl -s -H 'content-type: application/json' -d '{"decision":"approve"}' "$B/api/approvals/$UP/decide")
check "an approval cannot be decided without signing in" "$(has "$R" 'error')" "$R"
api -d '{"decision":"approve"}' "$B/api/approvals/$UP/decide" >/dev/null
check "   the user approves → video A is on version 3" "$(is "$(api "$B/api/video-projects/$RA")" 'r.video.channelVersion===3')"

echo "== nothing paid before the user approves"
N=$(lines "$FAKE_CODEX_LOG")
R=$(img A "{\"token\":\"devtoken\",\"chatId\":\"$CA\",\"role\":\"builder\",\"prompt\":\"Pip walking\",\"reference_asset_ids\":[\"$REF\"]}")
check "image generation is refused while planning" "$(has "$R" 'blocked in this video project') $(( $(lines "$FAKE_CODEX_LOG") == N ))" "$R"
R=$(call $CA builder elevenlabs_creative_generate_speech '{"text":"Hello there."}')
check "a paid TTS tool is refused while planning, and never reaches the provider" "$(has "$R" 'blocked in this video project') $( [ "$(lines "$LABSLOG")" = 0 ] && echo 1 || echo 0)" "$R"
R=$(call $CA builder animation_engine_scene_create '{"workspaceId":"ws1","sceneId":"s1"}')
check "free engine work (scene setup) is allowed" "$(is "$R" 'r.ok===true')" "$R"
R=$(call $CA builder animation_engine_timeline_apply '{"workspaceId":"ws1","sceneId":"s1","operations":[]}')
check "animation timing waits for the narration" "$(has "$R" 'Visual timing waits for the narration')" "$R"
R=$(ch $CA builder video_request_production_approval '{"summary":"x"}')
check "a Builder cannot request production approval" "$(has "$R" 'ERROR')" "$R"
R=$(ch $CA director video_request_production_approval "{\"summary\":\"Pip explores a what-if.\",\"narration_seconds\":60,\"reused_assets\":[\"$REF\"],\"new_images\":[{\"purpose\":\"Pip walking\",\"entity_id\":\"char-pip\"},{\"purpose\":\"observatory\"}],\"tts_characters\":1000}")
check "the Director asks; Tandem prices the counts (2 Codex images + 1,000 characters = \$0.30)" "$(has "$R" '\$0.30')" "$R"
V=$(api "$B/api/video-projects/$RA")
check "   the project waits for approval, with a card in its Project Chat" "$(is "$V" "r.video.phase==='awaiting_approval' && r.approvals.some(a=>a.kind==='production')")"
EV=$(api "$B/api/chats/$CA/events")
check "   the card shows the cost breakdown" "$(is "$EV" "r.events.some(e=>e.kind==='approval'&&e.payload.status==='pending'&&e.payload.detail.totalUsd===0.3&&e.payload.detail.lines.length===4)")"
R=$(ch $CA director video_request_production_approval '{"summary":"again"}')
check "   a second request while one is waiting is refused" "$(has "$R" 'already waiting')" "$R"
PA=$(jget "$V" "r.approvals.find(a=>a.kind==='production').id")
api -d '{"decision":"approve"}' "$B/api/approvals/$PA/decide" >/dev/null
check "the user approves → producing, budget \$0.30" "$(is "$(api "$B/api/video-projects/$RA")" "r.video.phase==='approved' && r.video.budgetUsd===0.3")"
R=$(api -d '{"decision":"approve"}' "$B/api/approvals/$PA/decide")
check "   a decision cannot be made twice" "$(has "$R" 'already approved')" "$R"

echo "== producing, within budget, never paying twice"
R=$(img A "{\"token\":\"devtoken\",\"chatId\":\"$CA\",\"role\":\"builder\",\"prompt\":\"Pip walking\",\"reference_asset_ids\":[\"$REF\"],\"register\":{\"kind\":\"production\",\"entity_id\":\"char-pip\",\"name\":\"Pip walking\",\"attributes\":{\"engineReady\":true,\"transparent\":true}}}")
PROD=$(jget "${R#A }" 'r.assetId')
check "after approval the image is generated, as a PROJECT production asset" "$(is "${R#A }" "r.assetScope==='project' && r.assetKind==='production'")" "$R"
A=$(tail -1 "$FAKE_CODEX_LOG")
check "   Codex got the reference image, with -- ending the image list" "$(is "$A" "r.args.includes('-i') && r.args[r.args.indexOf('-i')+2]==='--' && /REFERENCE/.test(r.args.at(-1))")" "$A"
N=$(lines "$FAKE_CODEX_LOG")
R=$(img A "{\"token\":\"devtoken\",\"chatId\":\"$CA\",\"role\":\"builder\",\"prompt\":\"Pip walking\",\"reference_asset_ids\":[\"$REF\"],\"register\":{\"kind\":\"production\",\"entity_id\":\"char-pip\",\"name\":\"Pip walking\",\"attributes\":{\"engineReady\":true,\"transparent\":true}}}")
check "the identical request is answered from the earlier result — Codex not called again" "$(is "${R#A }" "r.reused===true && r.assetId==='$PROD'") $(( $(lines "$FAKE_CODEX_LOG") == N ))" "$R"
R=$(call $CA builder elevenlabs_creative_generate_speech '{"text":"Hello there, explorer."}')
check "narration is generated after approval" "$(is "$R" 'r.ok===true') $( [ "$(lines "$LABSLOG")" = 1 ] && echo 1 || echo 0)" "$R"
R=$(call $CA builder elevenlabs_creative_generate_speech '{"text":"Hello there, explorer."}')
check "   the identical TTS call is not paid twice" "$(has "$R" 'already ran in this project') $( [ "$(lines "$LABSLOG")" = 1 ] && echo 1 || echo 0)" "$R"
LONG=$(node -e 'console.log("a".repeat(2000))')
R=$(call $CA builder elevenlabs_creative_generate_speech "{\"text\":\"$LONG\"}")
check "a call that would exceed the approved budget is refused, pointing to a new approval" "$(has "$R" 'exceed the approved budget')" "$R"
V=$(api "$B/api/video-projects/$RA")
check "costs are recorded by category" "$(is "$V" "r.costs.some(c=>c.category==='images') && r.costs.some(c=>c.category==='narration') && r.video.spentUsd>0")" "$(jget "$V" 'r.costs')"

echo "== narration before timing"
printf 'RIFF....WAVEfmt ' > "$DEV/narration.wav"
R=$(ch $CA builder asset_add '{"assets":[{"path":"narration.wav","kind":"production","name":"Narration","attributes":{"type":"narration"}}]}')
NAR=$(printf '%s' "$R" | grep -o 'ast_[0-9a-f]*' | head -1)
R=$(ch $CA builder video_lock_narration "{\"asset_id\":\"$NAR\",\"duration_seconds\":58.4,\"segments\":[{\"id\":\"1\",\"text\":\"Hello\",\"start\":0,\"end\":2.1}]}")
check "the narration is locked with its real timing" "$(has "$R" 'Narration locked')" "$R"
R=$(call $CA builder animation_engine_timeline_apply '{"workspaceId":"ws1","sceneId":"s1","operations":[]}')
check "   and now animation timing is allowed" "$(is "$R" 'r.ok===true')" "$R"

echo "== the engine only gets production assets"
REFFILE=$(node -e "const D=require('$ROOT/node_modules/better-sqlite3');console.log(new D('$DD/tandem.db',{readonly:true}).prepare('SELECT file FROM media_assets WHERE id=?').get('$REF').file)")
PRODFILE=$(node -e "const D=require('$ROOT/node_modules/better-sqlite3');console.log(new D('$DD/tandem.db',{readonly:true}).prepare('SELECT file FROM media_assets WHERE id=?').get('$PROD').file)")
R=$(call $CA builder animation_engine_asset_import "{\"workspaceId\":\"ws1\",\"source\":{\"library\":\"tandem\",\"path\":\"$REFFILE\"}}")
check "a reference asset is refused by library path" "$(has "$R" 'not a production asset')" "$R"
B64=$(base64 < "$DD/media/reference/$REFFILE" | tr -d '\n')
R=$(call $CA builder animation_engine_asset_import "{\"workspaceId\":\"ws1\",\"source\":{\"base64\":\"$B64\",\"filename\":\"pip.png\"}}")
check "   and refused when smuggled in as base64 bytes" "$(has "$R" 'REFERENCE asset')" "$R"
cp "$DD/media/reference/$REFFILE" "$ENG/ws1/inbox/pip.png"
R=$(call $CA builder animation_engine_asset_import '{"workspaceId":"ws1","source":{"inbox":"pip.png"}}')
check "   and refused when copied into the engine's inbox" "$(has "$R" 'REFERENCE asset')" "$R"
R=$(call $CA builder animation_engine_asset_import "{\"workspaceId\":\"ws1\",\"source\":{\"library\":\"tandem\",\"path\":\"$PRODFILE\"}}")
check "a production asset of this project imports" "$(is "$R" 'r.ok===true')" "$R"
check "   the engine was started with Tandem's production library" "$(has "$(tail -1 "$ENGLOG")" "tandem=$DD/media/production")" "$(tail -1 "$ENGLOG")"
R=$(call $CB builder animation_engine_asset_import "{\"workspaceId\":\"ws1\",\"source\":{\"library\":\"tandem\",\"path\":\"$PRODFILE\"}}")
check "another video cannot import that project-only asset" "$(has "$R" 'not part of this video project')" "$R"

echo "== promotion"
S=$(ch $CB builder asset_search '{"entity_id":"char-pip"}')
check "an unpromoted project asset does not appear in another video" "$( [ -n "$PROD" ] && echo 1 || echo 0) $(not "$(has "$S" "$PROD")")" "$S"
R=$(ch $CA builder asset_promote "{\"asset_id\":\"$PROD\",\"reason\":\"Pip walk cycle is reusable\"}")
check "promotion asks the user" "$(has "$R" 'Asked the user')" "$R"
check "   and the channel is unchanged until they decide" "$(is "$(api "$B/api/channels/$CHID")" "!r.version.content.assetIds.includes('$PROD')")"
PR=$(jget "$(api "$B/api/video-projects/$RA")" "r.approvals.find(a=>a.kind==='promotion').id")
api -d '{"decision":"approve"}' "$B/api/approvals/$PR/decide" >/dev/null
HEAD=$(jget "$(api "$B/api/channels/$CHID")" 'r.channel.headVersion')
check "approved → the channel's next version includes it" "$(is "$(api "$B/api/channels/$CHID")" "r.version.content.assetIds.includes('$PROD')")"
VC=$(api -d "{\"channelId\":\"$CHID\"}" "$B/api/video-projects"); CC=$(jget "$VC" 'r.chat.id')
S=$(ch $CC builder asset_search '{"entity_id":"char-pip","kind":"production"}')
check "a video created afterwards finds the promoted asset" "$(has "$S" "$PROD")" "$S"
S=$(ch $CB builder asset_search '{"entity_id":"char-pip"}')
check "   the video pinned to the earlier version still does not" "$(not "$(has "$S" "$PROD")")" "$S"

echo "== the reviewer inspects the engine read-only"
R=$(call $CA builder_reviewer animation_engine_scene_get '{"workspaceId":"ws1","sceneId":"s1"}')
check "a Reviewer may read a scene" "$(is "$R" 'r.ok===true')" "$R"
R=$(call $CA builder_reviewer animation_engine_layer_add '{"workspaceId":"ws1","sceneId":"s1"}')
check "   but not change one" "$(has "$R" 'not permitted')" "$R"

echo "== the Director assigns video agents"
D(){ internal director "{\"token\":\"devtoken\",\"chatId\":\"$CA\",\"op\":\"$1\",\"args\":$2}"; }
D set_plan '{"summary":"s","milestones":[{"key":"M1","name":"Story","goal":"g","acceptance":"a"}]}' >/dev/null
R=$(D plan_sessions "{\"milestone\":\"M1\",\"reasoning\":\"r\",\"sessions\":[{\"key\":\"S1\",\"name\":\"Script\",\"purpose\":\"p\",\"prompt\":\"write\",\"agent_profile_id\":\"$ST\",\"reviewer_profile_id\":\"$ST\"}]}")
check "a Builder agent is refused as a session's Reviewer agent" "$(has "$R" 'is a Builder Agent')" "$R"
R=$(D plan_sessions "{\"milestone\":\"M1\",\"reasoning\":\"r\",\"sessions\":[{\"key\":\"S1\",\"name\":\"Script\",\"purpose\":\"p\",\"prompt\":\"write\",\"agent_profile_id\":\"$ST\",\"reviewer_profile_id\":\"$VR\"}]}")
check "Storyteller with the Video Reviewer is a valid session plan" "$(is "$R" 'r.ok!==false')" "$R"
check "   and the plan records both" "$(is "$(api "$B/api/project-runs/$RA")" "r.run.milestones[0].sessions[0].agentProfileId==='$ST' && r.run.milestones[0].sessions[0].reviewerProfileId==='$VR'")"

kill -9 $SRV 2>/dev/null
echo; [ $BAD -eq 0 ] && echo "ALL VIDEO CHECKS PASSED" || { echo "$BAD CHECK(S) FAILED"; tail -20 "$DD/server.log"; exit 1; }
