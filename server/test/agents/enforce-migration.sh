#!/bin/bash
# `enforce_model` changed meaning: it used to say "beats a difficulty tier" while
# an Agent's own model was used either way; it now says "this Agent supplies the
# model at all". Rows written under the old meaning must be carried to 1, or
# every existing Agent — and every RUNNING session's frozen snapshot — would
# silently switch to the Builder role's model.
set -u
RR="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$RR/../../.." && pwd)"
export PATH="$HOME/.local/node22/bin:$PATH"
D=$(mktemp -d)
cd "$ROOT/server" || exit 1

# 1. a store as it looked BEFORE the change: flag off, one agent, one snapshot
DATA_DIR=$D npx tsx -e "
import { createAgent } from './src/agents/store';
createAgent({ slug: 'legacy', name: 'Legacy', systemPrompt: 'p', provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' });
" >/dev/null 2>&1 || { echo "seed failed"; exit 1; }
node -e "
const D=require('$ROOT/node_modules/better-sqlite3');
const db=new D('$D/tandem.db'); db.pragma('foreign_keys = OFF');
db.prepare(\"INSERT OR REPLACE INTO chat_agent_snapshots (chat_id,profile_id,profile_name,profile_slug,provider,model,effort,enforce_model,system_prompt,profile_updated_at,captured_at) VALUES ('c-live','p1','Legacy','legacy','codex','gpt-5.6-terra','medium',0,'p',0,0)\").run();
db.prepare('UPDATE agent_profiles SET enforce_model = 0').run();
db.prepare('DELETE FROM kv WHERE key = ?').run('agents.enforce_model_is_model_source');
console.log('   before: profiles=' + db.prepare('SELECT enforce_model e FROM agent_profiles LIMIT 1').get().e + ' snapshots=' + db.prepare('SELECT enforce_model e FROM chat_agent_snapshots LIMIT 1').get().e);
"

# 2. open it with the new build: the migration runs at load
DATA_DIR=$D npx tsx -e "
import './src/agents/store';
" >/dev/null 2>&1

node -e "
const D=require('$ROOT/node_modules/better-sqlite3');
const db=new D('$D/tandem.db',{readonly:true});
const p=db.prepare('SELECT enforce_model e FROM agent_profiles LIMIT 1').get().e;
const s=db.prepare('SELECT enforce_model e FROM chat_agent_snapshots LIMIT 1').get().e;
const mark=db.prepare('SELECT value FROM kv WHERE key=?').get('agents.enforce_model_is_model_source');
let bad=0; const check=(l,ok)=>{ if(!ok) bad++; console.log((ok?'ok  ':'FAIL')+' '+l); };
check('an existing Agent keeps running on its own model', p===1);
check('a RUNNING session\'s frozen snapshot keeps running on its own model', s===1);
check('the migration is marked done so it never runs twice', !!mark);
process.exit(bad?1:0);
"
RC=$?

# 3. and it does not re-apply to a row an operator deliberately turned off
node -e "
const D=require('$ROOT/node_modules/better-sqlite3');
const db=new D('$D/tandem.db');
db.prepare('UPDATE agent_profiles SET enforce_model = 0').run();
" 
DATA_DIR=$D npx tsx -e "import './src/agents/store';" >/dev/null 2>&1
node -e "
const D=require('$ROOT/node_modules/better-sqlite3');
const db=new D('$D/tandem.db',{readonly:true});
const p=db.prepare('SELECT enforce_model e FROM agent_profiles LIMIT 1').get().e;
console.log((p===0?'ok  ':'FAIL')+' a deliberate off stays off on the next boot');
process.exit(p===0?0:1);
"
RC2=$?
rm -rf "$D"
echo; if [ $RC = 0 ] && [ $RC2 = 0 ]; then echo "ALL ENFORCE-MIGRATION CHECKS PASSED"; else echo "ENFORCE-MIGRATION CHECKS FAILED"; fi
exit $(( RC + RC2 ))
