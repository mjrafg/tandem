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
 * IMPORTANT — this base is NOT an OS-enforced boundary any more. Codex 0.147
 * auto-denies every MCP tool call in non-interactive `exec` ("user cancelled
 * MCP tool call") under every approval policy, including its own defaults; the
 * only mechanism that permits them is `--approve-for-me`, which routes
 * approvals through automatic review and escalates to a workspace-write
 * sandbox. Tandem is configured (by explicit operator choice) to give the
 * Reviewer real tools, so the Reviewer CAN write to the project. What still
 * constrains it: the instruction-level "inspect, do not modify" rule in the
 * Reviewer prompt, and Tandem's own per-tool role permissions, which are
 * enforced server-side in the integration execution layer.
 */
const REVIEWER_PROFILE_NAME = 'tandem-reviewer';
const REVIEWER_PROFILE = `# Written by Tandem (server/src/engine/codex.ts); regenerated before each review.
# Base posture: filesystem read-only, network enabled. Escalations are
# auto-approved (--approve-for-me) so the Reviewer can call MCP tools.
approval_policy = "never"
default_permissions = "${REVIEWER_PROFILE_NAME}"

[permissions.${REVIEWER_PROFILE_NAME}]
filesystem."/" = "read"

[permissions.${REVIEWER_PROFILE_NAME}.network]
enabled = true
mode = "full"
domains."*" = "allow"
allow_local_binding = true

[features.network_proxy]
enabled = true
`;

function ensureReviewerProfile(): boolean {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, `${REVIEWER_PROFILE_NAME}.config.toml`);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== REVIEWER_PROFILE) {
      fs.writeFileSync(file, REVIEWER_PROFILE);
    }
    return true;
  } catch {
    return false;
  }
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
  const haveProfile = ensureReviewerProfile();
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
  ];
  // Permission profile + automatic approval. `--approve-for-me` is the only
  // way this Codex version permits MCP tool calls in exec mode (without it the
  // Reviewer is served tools it can never call); it cannot be combined with
  // `--sandbox`, so the legacy fallback stays strictly read-only and toolless.
  if (haveProfile) args.push('-p', REVIEWER_PROFILE_NAME, '--approve-for-me');
  else args.push('--sandbox', 'read-only');
  if (opts.model.trim()) args.push('-m', opts.model.trim());
  args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  // the internal browser tool (MCP servers run outside the shell sandbox; the
  // browser writes only screenshots into Tandem's shots dir — the Reviewer's
  // project access stays read-only)
  const browserScript = path.resolve(path.dirname(process.argv[1] ?? '.'), 'mcp-browser.cjs');
  if (fs.existsSync(browserScript)) {
    args.push(
      '-c', `mcp_servers.tandem_browser.command="${process.execPath}"`,
      '-c', `mcp_servers.tandem_browser.args=["${browserScript}"]`,
      '-c', 'mcp_servers.tandem_browser.tool_timeout_sec=120',
    );
  }
  // integration tools the admin has allowed for the reviewer role (the gateway
  // executes nothing itself — Tandem's execution layer enforces role access
  // again server-side, so this stays true even if the flag were tampered with)
  const extScript = path.resolve(path.dirname(process.argv[1] ?? '.'), 'mcp-integrations.cjs');
  const serveExt = fs.existsSync(extScript) && hasIntegrationTools('reviewer');
  if (serveExt) {
    args.push(
      '-c', `mcp_servers.tandem_ext.command="${process.execPath}"`,
      '-c', `mcp_servers.tandem_ext.args=["${extScript}"]`,
      '-c', 'mcp_servers.tandem_ext.tool_timeout_sec=120',
    );
  }

  const cliShown = `${config.codexBin} ${args.join(' ')}`;
  const startedAt = Date.now();
  const servedTools = [
    ...(fs.existsSync(browserScript) ? await servedToolRecord(['tandem_browser']) : []),
    ...(serveExt ? catalogForRole('reviewer').map((t) => ({ name: t.name, description: t.description })) : []),
  ];
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
    bin: config.codexBin,
    args,
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
