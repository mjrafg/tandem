# Review-reset reproduction

A scripted Tandem with fake CLIs, used to prove and then verify the fixes in
`engine/reviewLedger.ts`, `engine/workflow.ts` and `director/engine.ts`
(commit "Review budget and original request belong to the task, not the run").

- `fake-claude.cjs` — Builder/Director stand-in: runs shell recipes keyed on prompt
  text; as the Director it replays `dscript.json` against the real
  `tandem_director` MCP tools.
- `fake-codex.cjs` — Reviewer stand-in: FINDINGS for the first `FAKE_FINDINGS_FOR`
  (default 2) session reviews, PASS after; `FAKE_CODEX_QUOTA_ON_CALL=n` refuses
  call n like a usage limit; `FAKE_CODEX_SLEEP_ON_CALL=n` holds call n for 20 s.
- `run.sh SCENARIO` — boots an isolated Tandem (own DATA_DIR, port, git repo),
  drives one Director session through round 1 → repair → round 2 → final repair,
  SIGKILLs the server at the named boundary, restarts it, and judges the result.
- `assert.cjs` — the invariants, read from the database, the Reviewer's verbatim
  prompts and the project's git log (never from UI labels).

Scenarios: `NONE` (control), `AFTER_R1`, `DURING_R2`, `DURING_FINAL`,
`DOUBLE_FINAL`, `QUOTA_R2`, `QUOTA_CRASH_FINAL` (stage it with
`FAKE_FINDINGS_FOR=3 SETTLE=20`), `QUOTA_WAIT_RESTART`.
`RESUME_AFTER_RESTART=1` presses Resume after the restart, as a human would.

Requires `npm run -w server build` first. The fakes are `.cjs` on purpose: `server/package.json` is `"type": "module"`, so an extensionless script would be loaded as ESM. Runs on macOS/Linux with Node 22 on PATH.
