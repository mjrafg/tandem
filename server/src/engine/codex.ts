import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiUsage, Effort } from '../../../shared/types';
import { config, internalBase, shotsDir } from '../config';
import { addEvent, updateEvent } from '../events';
import { catalogForRole, hasIntegrationTools } from '../integrations/exec';
import { spawnStreaming } from './procs';
import { servedToolRecord, toolTextEnv } from '../toolText';
import type { RunHandle } from './run';

export interface CodexResult {
  ok: boolean;
  stopped: boolean;
  text: string;
  usage?: AiUsage;
  durationMs: number;
  error?: string;
}

/**
 * The Reviewer's Codex permission profile.
 *
 * Base posture: filesystem read-only, network enabled through Codex's sandbox
 * proxy (public internet, DNS, and local services).
 *
 * Codex 0.147 auto-denies every MCP tool call in non-interactive `exec` ("user
 * cancelled MCP tool call") under every approval policy, including its own
 * defaults; the only mechanism that permits them is `--approve-for-me`, which
 * escalates approvals and thereby drops Codex's own filesystem restriction.
 * The Reviewer needs its tools, so Tandem enforces the read-only boundary
 * itself instead of trusting this profile: the codex process tree runs inside a
 * bubblewrap namespace (see readOnlyJailArgs) where the project, Tandem's code,
 * and Tandem's database are bind-mounted read-only. Writes fail with EROFS in
 * the kernel regardless of what Codex or the model decides.
 */
const PERMISSIONS_NAME = 'tandem-reviewer';
const BASE_PROFILE = `# Written by Tandem (server/src/engine/codex.ts) per review; deleted afterwards.
# Base posture: filesystem read-only, network enabled. Escalations are
# auto-approved (--approve-for-me) so the Reviewer can call MCP tools.
approval_policy = "never"
default_permissions = "${PERMISSIONS_NAME}"

[permissions.${PERMISSIONS_NAME}]
filesystem."/" = "read"

[permissions.${PERMISSIONS_NAME}.network]
enabled = true
mode = "full"
domains."*" = "allow"
allow_local_binding = true

[features.network_proxy]
enabled = true
`;

/** TOML basic string — JSON escaping is a valid subset. */
function tomlStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * An MCP server declaration for the profile file.
 *
 * Codex does NOT inherit this process's environment into MCP servers (verified:
 * a probe server sees the variable as missing when it is only exported by the
 * parent, and sees it when declared here). Tandem's servers need their internal
 * URL/token/chat id at startup, so the values must be declared per server.
 * Keeping them in the profile file — rather than `-c` flags — also keeps the
 * internal token off the command line and out of the recorded transcript.
 */
function mcpBlock(name: string, command: string, args: string[], env: Record<string, string>): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(command)}`,
    `args = ${JSON.stringify(args)}`,
    'tool_timeout_sec = 120',
    `[mcp_servers.${name}.env]`,
    ...Object.entries(env).map(([k, v]) => `${k} = ${tomlStr(v)}`),
    '',
  ].join('\n');
}

function codexHomeDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// ------------------------------------------------- OS-enforced read-only wrap
//
// Codex only permits MCP tool calls when approvals are escalated
// (`--approve-for-me`), which also drops its own filesystem restriction. So
// Tandem enforces the Reviewer's read-only boundary itself: the whole codex
// process tree runs inside a bubblewrap namespace where the project — plus
// Tandem's own code and database — are bind-mounted read-only. Writes fail with
// EROFS at the kernel level, no matter what the model or Codex decides.

let bwrapOk: boolean | null = null;

/** One-time real probe: bwrap present AND usable unprivileged here. */
function bwrapAvailable(): boolean {
  if (bwrapOk !== null) return bwrapOk;
  try {
    const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--ro-bind', '/tmp', '/tmp', '--', 'true'], { timeout: 10_000 });
    bwrapOk = !r.error && r.status === 0;
  } catch {
    bwrapOk = false;
  }
  return bwrapOk;
}

/** bwrap arguments placing the reviewer's process tree in a read-only jail. */
function readOnlyJailArgs(projectPath: string, cwd: string): string[] {
  const args = ['--dev-bind', '/', '/'];
  const ro = (p: string) => {
    if (p && fs.existsSync(p)) args.push('--ro-bind', p, p);
  };
  const rw = (p: string) => {
    if (p && fs.existsSync(p)) args.push('--bind', p, p);
  };
  ro(projectPath);                                    // the work under review
  ro(path.dirname(process.argv[1] ?? ''));            // Tandem's own code
  ro(config.dataDir);                                 // chats, events, credentials
  rw(shotsDir);                                       // browser screenshots stay writable
  rw(path.join(config.dataDir, 'tmp'));
  args.push('--die-with-parent', '--chdir', cwd, '--');
  return args;
}

/** Write the per-run profile; returns its name, or null if it cannot be written. */
function writeReviewerProfile(runId: string, blocks: string[]): string | null {
  try {
    const home = codexHomeDir();
    fs.mkdirSync(home, { recursive: true });
    const name = `tandem-reviewer-${runId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)}`;
    fs.writeFileSync(path.join(home, `${name}.config.toml`), [BASE_PROFILE, ...blocks].join('\n'), { mode: 0o600 });
    return name;
  } catch {
    return null;
  }
}

function removeReviewerProfile(name: string | null): void {
  if (!name) return;
  try { fs.rmSync(path.join(codexHomeDir(), `${name}.config.toml`), { force: true }); } catch { /* best effort */ }
}

/**
 * One real Codex CLI review call, sandboxed by the permission profile above.
 */
export async function runCodexReview(h: RunHandle, opts: {
  model: string;
  effort: Effort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<CodexResult> {
  const distDir = path.dirname(process.argv[1] ?? '.');
  const browserScript = path.resolve(distDir, 'mcp-browser.cjs');
  const extScript = path.resolve(distDir, 'mcp-integrations.cjs');
  // integration tools the admin has allowed for the reviewer role (the gateway
  // executes nothing itself — Tandem's execution layer enforces role access
  // again server-side, so this stays true even if the config were tampered with)
  const serveExt = fs.existsSync(extScript) && hasIntegrationTools('reviewer');

  const blocks: string[] = [];
  if (fs.existsSync(browserScript)) {
    blocks.push(mcpBlock('tandem_browser', process.execPath, [browserScript], {
      TANDEM_INTERNAL_URL: internalBase(),
      TANDEM_CHAT_ID: h.chat.id,
      TANDEM_INTERNAL_TOKEN: config.internalToken,
      TANDEM_SHOTS_DIR: shotsDir,
      TANDEM_BROWSER_ROLE: 'reviewer',
      TANDEM_TOOL_TEXT: toolTextEnv(),
    }));
  }
  if (serveExt) {
    blocks.push(mcpBlock('tandem_ext', process.execPath, [extScript], {
      TANDEM_INTERNAL_URL: internalBase(),
      TANDEM_CHAT_ID: h.chat.id,
      TANDEM_INTERNAL_TOKEN: config.internalToken,
      TANDEM_ROLE: 'reviewer',
    }));
  }
  const profileName = writeReviewerProfile(h.ctx.runId, blocks);

  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
  ];
  // Permission profile + automatic approval. `--approve-for-me` is the only
  // way this Codex version permits MCP tool calls in exec mode (without it the
  // Reviewer is served tools it can never call); it cannot be combined with
  // `--sandbox`, so the fallback path stays strictly read-only and toolless.
  if (profileName) args.push('-p', profileName, '--approve-for-me');
  else args.push('--sandbox', 'read-only');
  if (opts.model.trim()) args.push('-m', opts.model.trim());
  args.push('-c', `model_reasoning_effort="${opts.effort}"`);

  // Tandem's own read-only enforcement around the whole codex process tree.
  const jailed = !!profileName && bwrapAvailable();
  const spawnBin = jailed ? 'bwrap' : config.codexBin;
  const spawnArgs = jailed
    ? [...readOnlyJailArgs(h.project.rootPath, opts.cwd), config.codexBin, ...args]
    : args;
  if (profileName && !jailed) {
    // honest: tools are on, but the read-only boundary is not OS-enforced here
    h.status('bubblewrap is unavailable on this host — the Reviewer runs with tools but without Tandem\'s OS-enforced read-only boundary.');
  }

  const cliShown = `${jailed ? 'bwrap … ' : ''}${config.codexBin} ${args.join(' ')}`;
  const startedAt = Date.now();
  const servedTools = profileName
    ? [
      ...(fs.existsSync(browserScript) ? await servedToolRecord(['tandem_browser']) : []),
      ...(serveExt ? catalogForRole('reviewer').map((t) => ({ name: t.name, description: t.description })) : []),
    ]
    : []; // fallback path serves no MCP servers at all
  const aiCall = addEvent(h.chat.id, 'ai_call', {
    role: 'reviewer',
    provider: 'codex',
    model: opts.model,
    effort: opts.effort,
    status: 'running',
    request: { prompt: opts.prompt },
    cli: { command: cliShown, cwd: opts.cwd, exitCode: null },
    startedAt,
    ...(servedTools.length > 0 ? { tools: servedTools } : {}),
  }, { runId: h.ctx.runId });

  const pendingCommands = new Map<string, { eventId: string; startedAt: number }>();
  let lastText = '';
  let usage: AiUsage | undefined;
  let turnError: string | undefined;

  const commandPayload = (item: any) => ({
    command: String(item.command ?? ''),
    cwd: opts.cwd,
    stdout: String(item.aggregated_output ?? ''),
    stderr: '',
    exitCode: (item.exit_code ?? null) as number | null,
    durationMs: 0,
    status: ((item.exit_code ?? 0) === 0 ? 'done' : 'failed') as 'done' | 'failed',
  });

  const onLine = (line: string) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    const type = ev.type as string | undefined;
    if (type === 'item.started' && itemType(ev) === 'command_execution') {
      const created = addEvent(h.chat.id, 'command', {
        command: String(ev.item.command ?? ''), cwd: opts.cwd, stdout: '', stderr: '', exitCode: null, durationMs: 0, status: 'running',
      }, { runId: h.ctx.runId });
      pendingCommands.set(String(ev.item.id ?? created.id), { eventId: created.id, startedAt: Date.now() });
    } else if (type === 'item.completed') {
      const it = ev.item ?? {};
      const kind = itemType(ev);
      if (kind === 'command_execution') {
        const pending = pendingCommands.get(String(it.id ?? ''));
        if (pending) {
          pendingCommands.delete(String(it.id));
          updateEvent(pending.eventId, {
            stdout: String(it.aggregated_output ?? '').slice(0, 60_000),
            exitCode: it.exit_code ?? null,
            durationMs: Date.now() - pending.startedAt,
            status: (it.exit_code ?? 0) === 0 ? 'done' : 'failed',
          });
        } else {
          addEvent(h.chat.id, 'command', commandPayload(it), { runId: h.ctx.runId });
        }
      } else if (kind === 'agent_message' && typeof it.text === 'string') {
        lastText = it.text;
      }
      // reasoning / todo_list / mcp items: not part of the reviewed record
    } else if (type === 'turn.completed' && ev.usage) {
      usage = {
        inputTokens: ev.usage.input_tokens ?? 0,
        outputTokens: (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0),
      };
    } else if (type === 'turn.failed' || type === 'error') {
      turnError = String(ev.error?.message ?? ev.message ?? 'Codex reported an error');
    }
  };

  const proc = await spawnStreaming({
    ctx: h.ctx,
    bin: spawnBin,
    args: spawnArgs,
    cwd: opts.cwd,
    env: {
      OPENAI_API_KEY: '',
      NO_COLOR: '1',
      // inherited by the tandem_browser MCP stdio server
      TANDEM_INTERNAL_URL: internalBase(),
      TANDEM_CHAT_ID: h.chat.id,
      TANDEM_INTERNAL_TOKEN: config.internalToken,
      TANDEM_SHOTS_DIR: shotsDir,
      TANDEM_BROWSER_ROLE: 'reviewer',
      TANDEM_ROLE: 'reviewer',
      TANDEM_TOOL_TEXT: toolTextEnv(),
    },
    stdinData: opts.prompt,
    timeoutMs: opts.timeoutMs,
    onLine,
  });

  removeReviewerProfile(profileName); // the per-run profile carries the internal token
  const durationMs = Date.now() - startedAt;
  const stopped = h.ctx.stopped;
  let error: string | undefined;
  if (!stopped) {
    if (proc.spawnError) error = `Could not start the Codex CLI (${config.codexBin}): ${proc.spawnError}`;
    else if (proc.timedOut) error = `The Codex CLI call timed out after ${Math.round(opts.timeoutMs / 60000)} minutes.`;
    else if (turnError) error = turnError;
    else if (proc.exitCode !== 0) error = `The Codex CLI exited with code ${proc.exitCode}.${proc.stderrTail ? ` stderr: ${proc.stderrTail.slice(-600)}` : ''}`;
    else if (!lastText.trim()) error = 'The Codex CLI produced no reviewer message.';
  }
  const ok = !stopped && !error;

  updateEvent(aiCall.id, {
    status: stopped ? 'stopped' : ok ? 'done' : 'failed',
    durationMs,
    response: lastText || usage ? { text: lastText, usage } : undefined,
    cli: { command: cliShown, cwd: opts.cwd, exitCode: proc.exitCode },
    ...(error ? { error } : {}),
  });

  return { ok, stopped, text: lastText, usage, durationMs, error };
}

function itemType(ev: any): string {
  return String(ev.item?.type ?? ev.item?.item_type ?? '');
}
