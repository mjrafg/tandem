# Tandem

A chat-first AI coding application. One conversation per project; a **Builder**
(Claude Code CLI) does the work, a **Reviewer** (Codex CLI) independently checks
it, a configurable **Compactor** keeps the context small. Everything the agents
do — commands, file reads, searches, diffs, every AI call with its exact prompt
and response — is visible in the timeline as compact expandable rows.

## Maintainer documentation

The complete technical handbook — architecture, lifecycles, state machines, recovery, security model, maintainer cookbook and code index — is [`TANDEM_TECHNICAL_HANDBOOK.md`](./TANDEM_TECHNICAL_HANDBOOK.md).

## Layout

- `server/` — Node/Fastify backend: auth, SQLite persistence, SSE streaming,
  project import (directory / ZIP / git), context accounting, export, and the
  agent engine (currently a realistic mock; real CLI adapters replace it in
  milestone 2).
- `web/` — React + Vite + Tailwind UI.
- `shared/` — types shared by both.
- `deploy/` — systemd unit + deploy script for the production server.

## Development

```bash
npm install
npm run dev        # server on :7810, web on :5173 (proxies /api)
```

## Production build

```bash
npm run build      # web/dist + server/dist
node server/dist/index.js
```

Configuration via env: `PORT`, `DATA_DIR`, `PROJECTS_DIR`, `WEB_DIST`.
First boot creates the admin user (`TANDEM_EMAIL`); set the password with
`node server/dist/index.js set-password` (reads the new password from stdin).
