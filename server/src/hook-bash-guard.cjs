/*
 * PreToolUse guard: stop the model from using its own latency as a timer.
 *
 * A Builder waiting for a background command has no way to yield in print mode:
 * the agent loop only advances when the model emits a tool call, so "waiting"
 * becomes a tool call that does nothing. One audited session issued 385
 * `echo waiting` calls across three turns — each one a full model round trip
 * that re-read a 550k-745k token context from cache, about 60% of that
 * session's entire cache-read volume and 25 minutes of wall clock, to learn
 * nothing. The same session's real waits were defeated upstream: a standalone
 * `sleep` is refused by the CLI, and `sleep N; <read>` and the recommended
 * `until <check>; do sleep N; done` were both moved to the background and
 * returned in under 10ms.
 *
 * It also keeps a long command inside the time the TURN actually has left.
 * The Bash timeout is an environment variable fixed when the CLI starts, so a
 * 15-minute default still applies to a command begun 20 minutes into a
 * 30-minute turn — and Tandem kills the whole invocation at the turn limit,
 * taking the model's chance to report with it. This hook runs per call, so it
 * is the one place that knows how much time is genuinely left: it rewrites the
 * call's own `timeout` down to the remaining budget minus the reporting
 * reserve. That is a rewrite, not a refusal — the command still runs, and if it
 * cannot finish it now fails as a command instead of killing the turn.
 *
 * Three rules, all narrow, all failing open:
 *
 *   A. A command whose ENTIRE body is a no-op — `echo <word>`, `:`, `true` —
 *      is refused. There is no redirection, no pipe, no separator and no
 *      substitution, so it cannot be part of real work.
 *   B. The identical command five times in a row in one session is refused.
 *      That is polling, and by the fifth repeat the answer has not changed.
 *
 * What this is NOT: a cap on spend. Rule B bounds consecutive ACCEPTED
 * identical commands, not model calls. The sixth request was already generated
 * and paid for before the hook saw it, and after a refusal the model is free to
 * retry, vary the command, or poll something else. The real fix for waiting is
 * upstream — a foreground Bash timeout long enough that a finite command simply
 * finishes (see bashTimeoutEnv in engine/claude.ts). This guard is the floor
 * under the pathological case, not the mechanism that makes waiting cheap.
 *
 * Both refusals name the idiom that actually blocks, so the model can carry on
 * instead of guessing. Anything unexpected — bad input, unwritable state dir,
 * an internal error — exits 0 and allows the call: a guard that breaks a
 * Builder run costs far more than the round trips it was there to save.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** identical consecutive calls tolerated before the sixth is refused */
const REPEAT_LIMIT = 5;
/** never hand a command a timeout below this; below it, it may as well fail fast */
const MIN_TIMEOUT_MS = 1_000;

/* A single no-op: one `echo`/`:`/`true`, nothing chained, nothing redirected,
 * no substitution. `echo "$(date)" >> log` and `echo x | tee f` are real work
 * and never match. */
const NOOP = /^(?::|true|echo(?:\s+(?:-n\s+)?(?:"[^"$`]*"|'[^']*'|[\w.:,!?-]+))*)\s*;?\s*$/;

const HOW_TO_WAIT =
  'Wait by blocking in ONE foreground call instead of polling: '
  + '`until grep -q DONE_MARKER /path/to/run.log 2>/dev/null; do sleep 5; done` — '
  + 'start the work as `<cmd> > /path/to/run.log 2>&1; echo "DONE_MARKER rc=$?" >> /path/to/run.log` '
  + 'so the marker carries the real exit code. Read the log once when it returns, and grep it for the '
  + 'first failure rather than tailing the end. If a run is already going, wait for that one — '
  + 'do not start a second copy because output is slow.';

function stateFile(sessionId) {
  const dir = process.env.TANDEM_HOOK_STATE_DIR || os.tmpdir();
  const key = crypto.createHash('sha256').update(String(sessionId || 'nosession')).digest('hex').slice(0, 32);
  return path.join(dir, `tandem-bash-guard-${key}.json`);
}

/** consecutive-repeat count for this command, or 0 when state is unavailable */
function bumpRepeat(sessionId, command) {
  try {
    const file = stateFile(sessionId);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first call */ }
    const same = prev && prev.command === command;
    const next = { command, count: same ? prev.count + 1 : 1 };
    fs.writeFileSync(file, JSON.stringify(next));
    return next.count;
  } catch {
    return 0; // no state, no repeat rule — never a reason to block
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const command = input && input.tool_input && input.tool_input.command;
    if (typeof command !== 'string' || !command.trim()) return process.exit(0);
    const body = command.trim();

    if (NOOP.test(body)) {
      process.stderr.write(
        `Refusing \`${body.slice(0, 60)}\`: it does nothing, and in print mode every tool call is a full model `
        + `round trip that re-reads the whole session context. ${HOW_TO_WAIT}\n`,
      );
      return process.exit(2);
    }

    // Multi-line scripts are a different call every time in practice; the
    // repeat rule is aimed at the short status probe issued over and over.
    if (body.length <= 400 && !body.includes('\n')) {
      const count = bumpRepeat(input.session_id, body);
      if (count > REPEAT_LIMIT) {
        process.stderr.write(
          `Refusing this command: it is the ${count}th identical call in a row, so it is polling and the answer `
          + `has not changed. ${HOW_TO_WAIT}\n`,
        );
        return process.exit(2);
      }
    }
    // ---- C. fit the call inside the time this turn has left
    // Tandem sets the deadline only for turns where it also grants the long
    // foreground budget; when it is absent this does nothing at all.
    const deadline = Number(process.env.TANDEM_TURN_DEADLINE_MS);
    if (Number.isFinite(deadline) && deadline > 0) {
      const reserve = Number(process.env.TANDEM_TURN_RESERVE_MS) || 120_000;
      const budget = deadline - Date.now() - reserve;
      const asked = Number(input.tool_input.timeout);
      const effective = Number.isFinite(asked) && asked > 0
        ? asked
        : Number(process.env.BASH_DEFAULT_TIMEOUT_MS) || 120_000;
      if (effective > budget) {
        const timeout = Math.max(MIN_TIMEOUT_MS, Math.floor(budget));
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { ...input.tool_input, timeout },
          },
        }));
      }
    }
    return process.exit(0);
  } catch {
    return process.exit(0); // fail open, always
  }
});
process.stdin.on('error', () => process.exit(0));
