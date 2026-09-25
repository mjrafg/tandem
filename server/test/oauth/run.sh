#!/bin/bash
# OAuth sign-in for remote MCP servers, end to end, against a real isolated
# Tandem and a strict fake provider (fake-oauth.cjs). The "browser" is curl:
# it follows the provider's redirect back to Tandem exactly as a user would.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-8011}"; FPORT="${FPORT:-8012}"
B="http://127.0.0.1:$PORT"; FB="http://127.0.0.1:$FPORT"
mkdir -p "$RR/.work"; DD=$RR/.work/data; rm -rf "$DD"; mkdir -p "$DD"
for p in $PORT $FPORT; do lsof -ti tcp:$p 2>/dev/null | xargs kill -9 2>/dev/null; done; sleep 0.3

BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — ${3:0:300}}"; BAD=$((BAD+1)); fi; }
# jget JSON EXPR — evaluate EXPR with r = the parsed JSON; prints '' on any failure
jget(){ printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{console.log("");return}try{const v=eval(process.argv[1]);console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):String(v))}catch{console.log("")}})' "$2"; }
is(){ [ "$(jget "$1" "$2")" = true ] && echo 1 || echo 0; }

node "$RR/fake-oauth.cjs" "$FPORT" & FAKE=$!
ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken TANDEM_PUBLIC_URL="$B")
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SRV=$!
for i in $(seq 1 40); do curl -fsS "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
fake(){ curl -s -X POST "$FB$1" >/dev/null; }
state(){ curl -s "$FB/_state"; }
mk(){ api -d "{\"name\":\"$1\",\"type\":\"mcp\",\"config\":{\"transport\":\"http\",\"url\":\"$FB/r/$2/mcp\"}${3:+,\"credentialId\":\"$3\"}}" "$B/api/integrations"; }
integ(){ api "$B/api/integrations" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(JSON.stringify(a.find(i=>i.id===process.argv[1])||{}))})' "$1"; }
start(){ local body="${2:-}"; [ -n "$body" ] || body="{}"; api -d "$body" "$B/api/integrations/$1/oauth/start"; }
# the browser: go to the provider, come back where it sends us
toProvider(){ curl -s -o /dev/null -w '%{redirect_url}' "$1"; }
back(){ curl -s -o /dev/null -b "$CJ" -w '%{redirect_url}' "$1"; }
signin(){ local A U; A=$(start "$1" "${2:-}"); U=$(toProvider "$(jget "$A" 'r.authorizeUrl')"); back "$U"; }
call(){ curl -s -H 'content-type: application/json' -d "{\"token\":\"devtoken\",\"role\":\"builder\",\"tool\":\"$1\",\"args\":{\"text\":\"$2\"}}" "$B/api/internal/integration-call"; }

echo "== Tandem's client metadata document (the ElevenLabs way to identify it)"
DOC=$(curl -s "$B/oauth/client-metadata.json")
check "it is public: served without signing in" "$(is "$DOC" "r.client_id==='$B/oauth/client-metadata.json'")" "$DOC"
check "it lists Tandem's callback as the only redirect" "$(is "$DOC" "JSON.stringify(r.redirect_uris)===JSON.stringify(['$B/api/integrations/oauth/callback'])")" "$DOC"
check "it is a public client: no secret, PKCE instead" "$(is "$DOC" "r.token_endpoint_auth_method==='none'")"

echo "== before signing in"
V=$(mk Voice cimd); VID=$(jget "$V" 'r.id'); VSLUG=$(jget "$V" 'r.slug')
T=$(api -d "{}" "$B/api/integrations/$VID/test")
check "the connection test recognises an OAuth challenge instead of showing a bare 401" "$(is "$T" 'r.ok===false && r.oauthRequired===true')" "$T"
check "the integration says it needs a sign-in" "$(is "$(integ "$VID")" 'r.oauth.required===true && r.oauth.signedIn===false')" "$(integ "$VID")"

echo "== signing in"
A=$(start "$VID")
AU=$(jget "$A" 'r.authorizeUrl')
check "the browser is sent to the provider's authorize endpoint" "$(is "$A" "r.authorizeUrl.startsWith('$FB/as/cimd/authorize?')")" "$A"
check "   with PKCE S256" "$(is "$A" "new URL(r.authorizeUrl).searchParams.get('code_challenge_method')==='S256' && new URL(r.authorizeUrl).searchParams.get('code_challenge').length===43")"
check "   binding the token to this one server (resource indicator)" "$(is "$A" "new URL(r.authorizeUrl).searchParams.get('resource')==='$FB/r/cimd/mcp'")"
check "   identifying Tandem by its metadata document URL" "$(is "$A" "new URL(r.authorizeUrl).searchParams.get('client_id')==='$B/oauth/client-metadata.json'")"
check "   asking for the scopes the server named" "$(is "$A" "new URL(r.authorizeUrl).searchParams.get('scope')==='tts voices'")"
CB=$(toProvider "$AU")
check "the provider fetched Tandem's document and accepted the redirect" "$(is "$(state)" "r.cimdFetched.length===1 && r.cimdFetched[0].status===200")" "$(state)"
check "the callback refuses a request that is not signed in to Tandem" "$(( $(curl -s -o /dev/null -w '%{http_code}' "$CB") == 401 ))"
L=$(back "$CB")
check "the callback completes and returns to Integrations, reporting the tools" "$( [[ "$L" == *"/settings/integrations?"*"oauth=connected"*"tools=1"* ]] && echo 1 || echo 0)" "$L"
I=$(integ "$VID")
check "the integration is signed in, identified by the metadata document" "$(is "$I" "r.oauth.signedIn===true && r.oauth.clientSource==='metadata_document' && r.oauth.issuer==='$FB/as/cimd'")" "$I"
check "its tools were discovered straight away" "$(is "$I" "r.tools.some(t=>t.name==='speak') && r.lastTestOk===true")"
check "the token request proved the PKCE verifier and named the resource" "$(is "$(state)" "r.token.some(t=>t.grant_type==='authorization_code' && t.hasVerifier && t.resource==='$FB/r/cimd/mcp')")"
check "no token ever appears in the integrations API" "$( api "$B/api/integrations" | grep -qE '"(at|rt)_[0-9a-f]{24}' && echo 0 || echo 1)"
check "   nor in the credentials API" "$( api "$B/api/credentials" | grep -qE '"(at|rt)_[0-9a-f]{24}' && echo 0 || echo 1)"
check "the same callback cannot be used twice" "$( [[ "$(back "$CB")" == *"oauth_error="* ]] && echo 1 || echo 0)"

echo "== an agent using the tools"
R=$(call "${VSLUG}_speak" hello)
check "a tool call carries the sign-in and works" "$(is "$R" "r.ok===true && r.result.includes('spoke: hello')")" "$R"

echo "== tokens running out"
fake "/_ctl/revoke-access?mode=cimd"
R=$(call "${VSLUG}_speak" again)
check "a rejected token is renewed with the refresh token and the call succeeds" "$(is "$R" "r.ok===true && r.result.includes('spoke: again')")" "$R"
check "   exactly one refresh" "$(is "$(state)" 'r.refreshes.cimd===1')" "$(jget "$(state)" 'r.refreshes')"
fake "/_ctl/revoke-access?mode=cimd"
PIDS=(); for i in 1 2 3 4 5 6; do call "${VSLUG}_speak" "p$i" > "$DD/par$i.json" & PIDS+=($!); done; wait "${PIDS[@]}"
OKS=0; for i in 1 2 3 4 5 6; do [ "$(is "$(cat "$DD/par$i.json")" 'r.ok===true')" = 1 ] && OKS=$((OKS+1)); done
check "six calls rejected at the same moment all succeed" "$(( OKS == 6 ))" "$OKS/6"
check "   and cost a single refresh, so a rotating refresh token is never spent twice" "$(is "$(state)" 'r.refreshes.cimd===2')" "$(jget "$(state)" 'r.refreshes')"
fake "/_ctl/expires?s=30"; fake "/_ctl/revoke-access?mode=cimd"; call "${VSLUG}_speak" short >/dev/null
BEFORE=$(jget "$(state)" 'r.refreshes.cimd')
R=$(call "${VSLUG}_speak" early)
check "a token about to expire is refreshed before use, not after a failure" "$(is "$(state)" "r.refreshes.cimd===$BEFORE+1")" "before=$BEFORE $(jget "$(state)" 'r.refreshes')"
check "   and the call succeeds" "$(is "$R" 'r.ok===true')" "$R"
fake "/_ctl/expires?s=3600"
fake "/_ctl/revoke-refresh?mode=cimd"; fake "/_ctl/revoke-access?mode=cimd"
R=$(call "${VSLUG}_speak" gone)
check "when the provider withdraws the sign-in, the call fails" "$(is "$R" 'r.ok===false')" "$R"
check "   and the integration asks for a sign-in again" "$(is "$(integ "$VID")" 'r.oauth.required===true && r.oauth.signedIn===false')" "$(integ "$VID")"

echo "== signing in again, then out"
L=$(signin "$VID")
check "signing in again works" "$( [[ "$L" == *"oauth=connected"* ]] && echo 1 || echo 0)" "$L"
check "   and reuses the same credential rather than piling up new ones" "$(is "$(api "$B/api/credentials")" "r.filter(c=>c.type==='oauth').length===1")"
D=$(api -d "{}" "$B/api/integrations/$VID/oauth/disconnect")
check "signing out clears the sign-in" "$(is "$D" 'r.oauth.signedIn===false && r.oauth.required===true')" "$D"
check "   and tells the provider to revoke both tokens" "$(is "$(state)" "['refresh_token','access_token'].every(h=>r.revoked.some(x=>x.mode==='cimd' && x.hint===h && x.known))")" "$(jget "$(state)" 'r.revoked')"

echo "== tampered and stale callbacks"
A=$(start "$VID"); CB=$(toProvider "$(jget "$A" 'r.authorizeUrl')")
EVIL=$(node -e 'const u=new URL(process.argv[1]);u.searchParams.set("iss","https://evil.example");console.log(u.href)' "$CB")
L=$(back "$EVIL")
check "a response claiming another authorization server is rejected (mix-up defence)" "$( [[ "$L" == *"oauth_error="*"different+authorization+server"* ]] && echo 1 || echo 0)" "$L"
L=$(back "$B/api/integrations/oauth/callback?code=x&state=forged")
check "an unknown state is rejected" "$( [[ "$L" == *"oauth_error="* ]] && echo 1 || echo 0)" "$L"

echo "== dynamic client registration"
G=$(mk Reg dcr); GID=$(jget "$G" 'r.id')
L=$(signin "$GID")
check "a server with a registration endpoint registers Tandem and signs in" "$( [[ "$L" == *"oauth=connected"* ]] && echo 1 || echo 0)" "$L"
check "   it registered a public client with Tandem's callback" "$(is "$(state)" "r.registered.length===1 && r.registered[0].request.redirect_uris[0]==='$B/api/integrations/oauth/callback' && r.registered[0].request.token_endpoint_auth_method==='none'")" "$(jget "$(state)" 'r.registered')"
check "   the integration records how it was identified" "$(is "$(integ "$GID")" "r.oauth.clientSource==='dynamic' && r.oauth.signedIn===true")"
signin "$GID" >/dev/null
check "signing in again reuses that registration instead of registering again" "$(is "$(state)" 'r.registered.length===1')" "$(jget "$(state)" 'r.registered.length')"

echo "== a provider that needs a client id"
H=$(mk Hand manual); HID=$(jget "$H" 'r.id')
S=$(start "$HID")
check "without a client id it says so, and names the redirect to register" "$(is "$S" "r.needsClient===true && r.redirectUri==='$B/api/integrations/oauth/callback'")" "$S"
L=$(signin "$HID" '{"clientId":"manual-client"}')
check "with the client id the operator registered, it signs in" "$( [[ "$L" == *"oauth=connected"* ]] && echo 1 || echo 0)" "$L"
check "   recorded as a manual client" "$(is "$(integ "$HID")" "r.oauth.clientSource==='manual'")"

echo "== a server that claims to be something else"
O=$(mk Odd mismatch); OID=$(jget "$O" 'r.id')
S=$(start "$OID")
check "a server whose metadata names another resource is refused" "$(is "$S" "typeof r.error==='string' && r.canonicalUrl==='$FB/r/elsewhere/mcp'")" "$S"
check "   before the browser is ever sent anywhere" "$(is "$(state)" "!r.authorize.some(a=>a.mode==='mismatch')")"

echo "== the situation that started this: an API key pasted as a bearer token"
K=$(api -d '{"name":"Pasted key","type":"bearer_token","data":{"token":"sk_not_an_oauth_token"}}' "$B/api/credentials"); KID=$(jget "$K" 'r.id')
P=$(mk Pasted cimd "$KID"); PID=$(jget "$P" 'r.id')
T=$(api -d "{}" "$B/api/integrations/$PID/test")
check "the server's OAuth challenge is recognised even with a key attached" "$(is "$T" 'r.oauthRequired===true')" "$T"
L=$(signin "$PID")
check "signing in replaces the key with an OAuth sign-in" "$( [[ "$L" == *"oauth=connected"* ]] && echo 1 || echo 0)" "$L"
check "   the integration now uses the new sign-in" "$(is "$(integ "$PID")" "r.oauth.signedIn===true && r.credentialId!=='$KID'")"
check "   and the pasted key is left for you to delete, not destroyed" "$(is "$(api "$B/api/credentials")" "r.some(c=>c.id==='$KID')")"

echo "== an ordinary bearer-token server is unaffected"
SK=$(api -d '{"name":"Static key","type":"bearer_token","data":{"token":"static-secret"}}' "$B/api/credentials"); SKID=$(jget "$SK" 'r.id')
ST=$(mk Plain static "$SKID"); STID=$(jget "$ST" 'r.id'); STSLUG=$(jget "$ST" 'r.slug')
T=$(api -d "{}" "$B/api/integrations/$STID/test")
check "a server with a fixed key still connects" "$(is "$T" 'r.ok===true')" "$T"
api -d "{}" "$B/api/integrations/$STID/refresh-tools" >/dev/null
R=$(call "${STSLUG}_speak" plain)
check "   and its tools still work" "$(is "$R" "r.ok===true && r.result.includes('spoke: plain')")" "$R"
check "   and it is not mistaken for an OAuth server" "$(is "$(integ "$STID")" '!r.oauth')" "$(integ "$STID")"
WK=$(api -d '{"name":"Wrong key","type":"bearer_token","data":{"token":"not-the-key"}}' "$B/api/credentials"); WKID=$(jget "$WK" 'r.id')
W=$(mk Wrong static "$WKID"); WID=$(jget "$W" 'r.id')
T=$(api -d "{}" "$B/api/integrations/$WID/test")
check "a wrong key is reported as a rejected key, with the server's own words" "$(is "$T" "r.ok===false && !r.oauthRequired && r.detail.includes('401') && r.detail.includes('invalid api key')")" "$T"
check "   not as a request to sign in" "$(is "$(integ "$WID")" '!r.oauth')" "$(integ "$WID")"

kill -9 $SRV $FAKE 2>/dev/null; wait 2>/dev/null
echo; if [ $BAD = 0 ]; then echo "ALL OAUTH CHECKS PASSED"; else echo "$BAD FAILED"; fi
exit $BAD
