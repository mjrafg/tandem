#!/bin/bash
# The repository browser, end to end, on a REAL isolated Tandem. No model is
# called: this exercises only the read-only /repo/* routes against a scripted
# git repository. Work dirs live under ./.work (gitignored).
#
#   run.sh     boots on PORT (default 7979), prints checks, exits 1 on any failure
#
# Covers: the working tree and a branch's tree, file contents (text, binary,
# oversized), branches with ahead/behind and their Tandem chat, the log,
# uncommitted / branch / commit changes (added, modified, renamed, deleted,
# untracked), a non-git project, and the boundaries: .., absolute paths,
# symlinks out of the project, .git, option-looking and range refs, and auth.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"; export RR_ROOT="$ROOT"
DIST="${DIST:-$ROOT/server/dist/index.js}"; PORT="${PORT:-7979}"
mkdir -p "$RR/.work"; DD=$RR/.work/data; PROJ=$RR/.work/proj
PLAIN=$(mktemp -d)/plain   # outside every repository, this checkout included
rm -rf "$DD" "$PROJ"; mkdir -p "$DD" "$PROJ" "$PLAIN"
lsof -ti tcp:$PORT 2>/dev/null | xargs kill -9 2>/dev/null; sleep 0.3

G(){ git -C "$PROJ" -c user.name=t -c user.email=t@t "$@" >/dev/null; }
# ---- the fixture repository
G init -q -b main
printf 'hello\nworld\n' > "$PROJ/README.md"
mkdir -p "$PROJ/src/lib"
printf 'console.log(1)\n' > "$PROJ/src/app.js"
printf 'export const a = 1\n' > "$PROJ/src/lib/util.js"
printf 'gone soon\n' > "$PROJ/old.txt"
printf 'bin\0ary' > "$PROJ/bin.dat"
G add -A; G commit -q -m "first commit"
G checkout -q -b feature
printf 'console.log(2)\n' > "$PROJ/src/app.js"
printf 'export const b = 2\n' > "$PROJ/src/new.js"
G mv src/lib/util.js src/lib/helpers.js
G rm -q old.txt
G add -A; G commit -q -m "feature work"
G checkout -q main
head -c 1500000 /dev/zero | tr '\0' 'x' > "$PROJ/big.txt"; G add big.txt; G commit -q -m "big file"
printf 'hello\nthere\nworld\n' > "$PROJ/README.md"          # unstaged edit
printf 'staged\n' > "$PROJ/staged.txt"; G add staged.txt      # staged new file
printf 'draft\nnotes\n' > "$PROJ/notes.txt"                  # untracked
ln -s /etc "$PROJ/escape"                                      # link out of the project
ln -s src "$PROJ/inside"                                       # link within it
printf 'plain\n' > "$PLAIN/a.txt"

ENV=(DATA_DIR="$DD" PORT=$PORT HOST=127.0.0.1 TANDEM_INTERNAL_TOKEN=devtoken
     TANDEM_CLAUDE_BIN="$ROOT/server/test/review-reset/fake-claude.cjs" TANDEM_CODEX_BIN="$ROOT/server/test/review-reset/fake-codex.cjs")
echo 'testpass123' | env "${ENV[@]}" node "$DIST" set-password >/dev/null 2>&1
env "${ENV[@]}" node "$DIST" >> "$DD/server.log" 2>&1 & SPID=$!
for i in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
CJ="$DD/cj"; B="http://127.0.0.1:$PORT"
curl -s -c "$CJ" -H 'content-type: application/json' -d '{"email":"mjrafg2@gmail.com","password":"testpass123"}' "$B/api/login" >/dev/null

BAD=0; check(){ if [ "$2" = 1 ]; then echo "ok   $1"; else echo "FAIL $1${3:+ — $3}"; BAD=$((BAD+1)); fi; }
api(){ curl -s -b "$CJ" -H 'content-type: application/json' "$@"; }
code(){ curl -s -o /dev/null -w '%{http_code}' -b "$CJ" "$@"; }
# js <json> <expression over r> — prints 1 when the expression is true
js(){ printf '%s' "$1" | node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0,"utf8")); } catch { console.log(0); process.exit(); } try { console.log(eval(process.argv[1]) ? 1 : 0); } catch (e) { console.log(0); }' "$2"; }
enc(){ node -e 'console.log(encodeURIComponent(process.argv[1]))' -- "$1"; }

P=$(api -d "{\"dirPath\":\"$PROJ\"}" "$B/api/projects/directory"); PID=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$P")
N=$(api -d "{\"dirPath\":\"$PLAIN\"}" "$B/api/projects/directory"); NID=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$N")
C=$(api -d "{\"projectId\":\"$PID\"}" "$B/api/chats"); CHAT=$(node -e 'console.log(JSON.parse(process.argv[1]).id||"")' "$C")
[ -n "$PID" ] && [ -n "$CHAT" ] || { echo "setup failed: $P $C"; kill -9 $SPID; exit 1; }
# the chat works on `feature`, as a Tandem working-branch chat would
node -e '
const D=require(process.env.RR_ROOT+"/node_modules/better-sqlite3"); const db=new D(process.argv[1]);
db.prepare("UPDATE chats SET git_state=?, title=? WHERE id=?").run(JSON.stringify({mode:"working-branch",workBranch:"feature",targetBranch:"main",push:"never",repoPath:process.argv[2]}),"Feature chat",process.argv[3]);' "$DD/tandem.db" "$PROJ" "$CHAT"
R="$B/api/projects/$PID/repo"

echo "== tree"
T=$(api "$R/tree")
check "working tree lists files and folders, folders first" "$(js "$T" 'r.isRepo && r.ref===null && r.entries[0].type==="dir" && ["README.md","notes.txt","bin.dat","src"].every(n=>r.entries.some(e=>e.name===n))')" "$T"
check ".git is never listed" "$(js "$T" '!r.entries.some(e=>e.name===".git")')"
check "a link inside the project shows as the folder it points to" "$(js "$T" 'r.entries.find(e=>e.name==="inside").type==="dir"')"
check "a link out of the project shows as an unopenable link" "$(js "$T" 'r.entries.find(e=>e.name==="escape").type==="symlink"')"
check "file sizes are reported" "$(js "$T" 'r.entries.find(e=>e.name==="README.md").size===18')"
T=$(api "$R/tree?path=src")
check "a subfolder lists with project-relative paths" "$(js "$T" 'r.path==="src" && r.entries.some(e=>e.path==="src/lib" && e.type==="dir") && r.entries.some(e=>e.path==="src/app.js")')" "$T"
T=$(api "$R/tree?ref=feature&path=src")
check "a branch's tree shows that branch's files" "$(js "$T" 'r.ref==="feature" && r.entries.some(e=>e.name==="new.js")')" "$T"
T=$(api "$R/tree?ref=feature&path=src/lib")
check "the branch's rename is visible in its tree" "$(js "$T" 'r.entries.some(e=>e.name==="helpers.js") && !r.entries.some(e=>e.name==="util.js")')" "$T"
check "a folder missing on a branch is a 404" "$(( $(code "$R/tree?ref=feature&path=nope") == 404 ))"

echo "== file"
F=$(api "$R/file?path=README.md")
check "working file shows the edit on disk" "$(js "$F" 'r.content==="hello\nthere\nworld\n" && !r.binary && !r.truncated')" "$F"
F=$(api "$R/file?path=README.md&ref=main")
check "the same file on a branch shows the committed version" "$(js "$F" 'r.content==="hello\nworld\n" && r.ref==="main"')" "$F"
F=$(api "$R/file?path=src/new.js&ref=feature")
check "a file that exists only on a branch is readable there" "$(js "$F" 'r.content==="export const b = 2\n"')" "$F"
F=$(api "$R/file?path=bin.dat")
check "a binary file is flagged and its content withheld" "$(js "$F" 'r.binary && r.content===undefined && r.size===7')" "$F"
F=$(api "$R/file?path=big.txt")
check "an oversized file is cut to the cap and says so" "$(js "$F" 'r.truncated && r.size===1500000 && r.content.length===1048576')"
F=$(api "$R/file?path=big.txt&ref=main")
check "an oversized file on a branch is cut the same way" "$(js "$F" 'r.truncated && r.size===1500000 && r.content.length===1048576')"
F=$(api "$R/file?path=inside/app.js")
check "a file through a link inside the project is readable" "$(js "$F" 'r.content==="console.log(1)\n"')" "$F"

echo "== boundaries"
check "'..' out of the project is refused" "$(( $(code "$R/file?path=$(enc '../../../../etc/passwd')") == 400 ))"
check "an absolute path is refused" "$(( $(code "$R/file?path=$(enc /etc/passwd)") == 400 ))"
check "a symlink out of the project is refused" "$(( $(code "$R/file?path=escape/passwd") == 403 ))"
check "listing through a symlink out of the project is refused" "$(( $(code "$R/tree?path=escape") == 403 ))"
check ".git is refused" "$(( $(code "$R/file?path=.git/config") == 403 ))"
check ".git hidden behind ./ is refused" "$(( $(code "$R/file?path=$(enc ./src/../.git/HEAD)") == 403 ))"
check "a ref that looks like an option is refused" "$(( $(code "$R/tree?ref=$(enc '--output=/tmp/pwned')") == 400 ))"
check "a range as a ref is refused" "$(( $(code "$R/tree?ref=$(enc 'main..feature')") == 400 ))"
check "a ref with a colon path is refused" "$(( $(code "$R/file?ref=$(enc 'main:README.md')&path=x") == 400 ))"
check "an unknown ref is a 404" "$(( $(code "$R/tree?ref=nosuch") == 404 ))"
check "no file was written by the option-looking ref" "$( [ ! -e /tmp/pwned ] && echo 1 || echo 0 )"
check "signed-out requests are refused" "$(( $(curl -s -o /dev/null -w '%{http_code}' "$R/tree") == 401 ))"
check "an unknown project is a 404" "$(( $(code "$B/api/projects/nope/repo/tree") == 404 ))"

echo "== branches + log"
BR=$(api "$R/branches")
check "branches list with the checked-out one first" "$(js "$BR" 'r.current==="main" && r.base==="main" && r.branches[0].name==="main" && r.branches[0].current')" "$BR"
check "feature is 1 ahead and 1 behind main" "$(js "$BR" '(b=>b.ahead===1 && b.behind===1)(r.branches.find(b=>b.name==="feature"))')" "$BR"
check "each branch carries its last commit" "$(js "$BR" '(b=>b.subject==="feature work" && b.sha.length>=40 && b.date>0)(r.branches.find(b=>b.name==="feature"))')"
check "the branch links to the Tandem chat working on it" "$(js "$BR" "(b=>b.chatId==='$CHAT' && b.chatTitle==='Feature chat')(r.branches.find(b=>b.name==='feature'))")" "$BR"
L=$(api "$R/log?ref=feature&base=main")
check "log of a branch since its base shows only its own commits" "$(js "$L" 'r.commits.length===1 && r.commits[0].subject==="feature work" && r.base==="main"')" "$L"
L=$(api "$R/log")
check "log with no ref follows HEAD" "$(js "$L" 'r.commits.length===2 && r.commits[0].subject==="big file"')" "$L"

echo "== changes"
W=$(api "$R/changes")
check "uncommitted: the unstaged edit, with its line counts" "$(js "$W" '(f=>f && f.status==="modified" && f.additions===1 && f.deletions===0 && f.diff.includes("+there"))(r.files.find(f=>f.path==="README.md"))')" "$W"
check "uncommitted: the staged new file" "$(js "$W" '(f=>f && f.status==="added")(r.files.find(f=>f.path==="staged.txt"))')"
check "uncommitted: the untracked file, with a diff of its content" "$(js "$W" '(f=>f && f.status==="untracked" && f.additions===2 && f.diff.includes("+notes"))(r.files.find(f=>f.path==="notes.txt"))')"
check "uncommitted: totals add up" "$(js "$W" 'r.additions===r.files.reduce((n,f)=>n+f.additions,0) && r.scope==="working" && r.base==="HEAD"')"
X=$(api "$R/changes?scope=branch&ref=feature")
check "branch vs base: modified, added, renamed and deleted files" "$(js "$X" 'const s=Object.fromEntries(r.files.map(f=>[f.path,f.status])); s["src/app.js"]==="modified" && s["src/new.js"]==="added" && s["src/lib/helpers.js"]==="renamed" && s["old.txt"]==="deleted" && r.base==="main" && r.head==="feature"')" "$X"
check "branch vs base: the rename names where it came from" "$(js "$X" 'r.files.find(f=>f.path==="src/lib/helpers.js").oldPath==="src/lib/util.js"')"
check "branch vs base: the base's own later commits are not counted" "$(js "$X" '!r.files.some(f=>f.path==="big.txt")')"
K=$(api "$R/changes?scope=commit&ref=feature")
check "one commit: exactly what it changed" "$(js "$K" 'r.files.length===4 && r.scope==="commit"')" "$K"
K=$(api "$R/changes?scope=commit&ref=$(git -C "$PROJ" rev-list --max-parents=0 HEAD)")
check "the first commit diffs against nothing" "$(js "$K" 'r.base===null && r.files.every(f=>f.status==="added") && r.files.some(f=>f.path==="bin.dat" && f.binary)')" "$K"
check "changes of an unknown branch is a 404" "$(( $(code "$R/changes?scope=branch&ref=nosuch") == 404 ))"

echo "== a project that is not a git repository"
NR="$B/api/projects/$NID/repo"
T=$(api "$NR/tree")
check "its files are still browsable" "$(js "$T" '!r.isRepo && r.entries.some(e=>e.name==="a.txt")')" "$T"
check "branches say it is not a repository" "$(js "$(api "$NR/branches")" '!r.isRepo && r.branches.length===0')"
check "changes say it is not a repository" "$(js "$(api "$NR/changes")" '!r.isRepo && r.files.length===0')"

echo "== read-only"
check "browsing left the repository's status unchanged" "$( [ "$(git -C "$PROJ" status --porcelain | sort | tr '\n' ' ')" = "$(printf ' M README.md\n?? escape\n?? inside\n?? notes.txt\nA  staged.txt\n' | sort | tr '\n' ' ')" ] && echo 1 || echo 0 )" "$(git -C "$PROJ" status --porcelain | tr '\n' ' ')"

kill -9 $SPID 2>/dev/null; wait $SPID 2>/dev/null
echo; if [ $BAD = 0 ]; then echo "ALL BROWSE CHECKS PASSED"; else echo "$BAD FAILED"; fi
exit $BAD
