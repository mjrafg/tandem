import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiRole, AiUsage, Effort } from '../../../../shared/types';
import type { RoleExecutionPolicy } from '../types';
import { roleFamily } from '../policies';
import { config, internalBase, shotsDir } from '../../config';
import { addEvent, appendAssistantText, beginAssistantMessage, finishAssistantMessage, updateEvent } from '../../events';
import { catalogForRole, hasIntegrationTools } from '../../integrations/exec';
import { spawnStreaming } from '../../engine/procs';
import { bwrapAvailable, readOnlyJailArgs } from '../../engine/sandbox';
import { servedToolRecord, toolTextEnv } from '../../toolText';
import type { RunHandle } from '../../engine/run';

export interface CodexResult {
  ok: boolean;
  stopped: boolean;
  text: string;
  usage?: AiUsage;
  /** the Codex thread this turn created or continued (`thread.started`) */
  threadId?: string;
  durationMs: number;
  error?: string;
}

/**
 * The Codex permission profile, built per role policy.
 *
 * Base posture for a read-only role: filesystem read-only, network enabled
 * through Codex's sandbox proxy (public internet, DNS, and local services).
 * A read-write role (Builder) additionally gets write access to the project
 * and its working directory.
 *
 * Codex 0.147 auto-denies every MCP tool call in non-interactive `exec` ("user
 * cancelled MCP tool call") under every approval policy, including its own
 * defaults; the only mechanism that permits them is `--approve-for-me`, which
 * escalates approvals and thereby drops Codex's own filesystem restriction.
 * Roles need their tools, so Tandem enforces the read-only boundary itself
 * instead of trusting this profile: a read-only role's codex process tree runs
 * inside a bubblewrap namespace (see readOnlyJailArgs) where the project,
 * Tandem's code, and Tandem's database are bind-mounted read-only. Writes fail
 * with EROFS in the kernel regardless of what Codex or the model decides.
 */
const PERMISSIONS_NAME = 'tandem-role';
function baseProfile(writable: string[]): string {
  return `# Written by Tandem (providers/codex-cli/runTurn.ts) per turn; deleted afterwards.
# Base posture: filesystem read-only, network enabled. Escalations are
# auto-approved (--approve-for-me) so the role can call MCP tools.
approval_policy = "never"
default_permissions = "${PERMISSIONS_NAME}"

[permissions.${PERMISSIONS_NAME}]
filesystem."/" = "read"
${writable.map((d) => `filesystem.${tomlStr(d)} = "write"`).join('\n')}

[permissions.${PERMISSIONS_NAME}.network]
enabled = true
mode = "full"
domains."*" = "allow"
allow_local_binding = true

[features.network_proxy]
enabled = true
`;
}

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
// process tree runs inside the shared bubblewrap jail (./sandbox.ts). Writes
// fail with EROFS at the kernel level, no matter what the model or Codex decides.

/** Write the per-turn profile; returns its name, or null if it cannot be written. */
function writeRoleProfile(role: AiRole, runId: string, writable: string[], blocks: string[]): string | null {
  try {
    const home = codexHomeDir();
    fs.mkdirSync(home, { recursive: true });
    const name = `tandem-${role.replace('_', '-')}-${runId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)}`;
    fs.writeFileSync(path.join(home, `${name}.config.toml`), [baseProfile(writable), ...blocks].join('\n'), { mode: 0o600 });
    return name;
  } catch {
    return null;
  }
}

function removeRoleProfile(name: string | null): void {
  if (!name) return;
  try { fs.rmSync(path.join(codexHomeDir(), `${name}.config.toml`), { force: true }); } catch { /* best effort */ }
}

/**
 * One real Codex CLI turn for any role, sandboxed by the permission profile
 * above and served the tools its role policy allows.
 */
export async function runCodexTurn(h: RunHandle, opts: {
  role: AiRole;
  model: string;
  effort: Effort;
  /** role/system text; Codex exec has no separate system channel, so it leads the prompt */
  systemPrompt: string;
  prompt: string;
  cwd: string;
  /** a Codex thread id to continue (`codex exec resume`) */
  resumeThreadId?: string | null;
  policy: RoleExecutionPolicy;
  emitActivity?: boolean;
  nameSession?: boolean;
  timeoutMs: number;
}): Promise<CodexResult> {
  const emitActivity = opts.emitActivity !== false;
  const readOnly = opts.policy.filesystem === 'read-only';
  const distDir = path.dirname(process.argv[1] ?? '.');
  const workdirScript = path.resolve(distDir, 'mcp-workdir.cjs');
  const browserScript = path.resolve(distDir, 'mcp-browser.cjs');
  const extScript = path.resolve(distDir, 'mcp-integrations.cjs');
  const directorScript = path.resolve(distDir, 'mcp-director.cjs');
  const withWorkdir = opts.policy.workdirTools && fs.existsSync(workdirScript);
  const withBrowser = opts.policy.browserTools && fs.existsSync(browserScript);
  // integration tools the admin has allowed for this role (the gateway
  // executes nothing itself — Tandem's execution layer enforces role access
  // again server-side, so this stays true even if the config were tampered with)
  const family = roleFamily(opts.role);
  const withExt = opts.policy.integrationTools && fs.existsSync(extScript) && hasIntegrationTools(family);
  const withDirector = opts.policy.directorTools && fs.existsSync(directorScript);
  // a Director session's first Builder turn names itself through a workdir tool
  const nameSession = opts.nameSession
    ?? (h.chat.kind === 'pd-session' && opts.role === 'builder' && !opts.resumeThreadId && withWorkdir);

  // Codex does not inherit this process's environment into MCP servers, so
  // every server is told what it needs explicitly (see mcpBlock)
  const serverEnv = {
    TANDEM_INTERNAL_URL: internalBase(),
    TANDEM_CHAT_ID: h.chat.id,
    TANDEM_INTERNAL_TOKEN: config.internalToken,
    TANDEM_SHOTS_DIR: shotsDir,
    // tool servers filter by role FAMILY (see roleFamily); records carry the precise role
    TANDEM_BROWSER_ROLE: family,
    TANDEM_ROLE: family,
      TANDEM_LOGICAL_ROLE: opts.role,
    TANDEM_TOOL_TEXT: toolTextEnv(),
    TANDEM_ATTACHMENTS_DIR: path.join(config.dataDir, 'attachments'),
    ...(nameSession ? { TANDEM_NAME_SESSION: '1' } : {}),
  };
  const blocks: string[] = [];
  if (withWorkdir) blocks.push(mcpBlock('tandem', process.execPath, [workdirScript], serverEnv));
  if (withBrowser) blocks.push(mcpBlock('tandem_browser', process.execPath, [browserScript], serverEnv));
  if (withExt) blocks.push(mcpBlock('tandem_ext', process.execPath, [extScript], serverEnv));
  if (withDirector) blocks.push(mcpBlock('tandem_director', process.execPath, [directorScript], serverEnv));
  const writable = readOnly ? [] : [...new Set([h.project.rootPath, opts.cwd])];
  const profileName = writeRoleProfile(opts.role, h.ctx.runId, writable, blocks);

  // `codex exec [options] [PROMPT]` starts a thread; `codex exec [options]
  // resume <id> [PROMPT]` continues one. The subcommand accepts only a subset
  // of the options (-m, -c, --json, --skip-git-repo-check); `-p`,
  // `--approve-for-me` and `--sandbox` belong to `exec` itself and are
  // rejected AFTER `resume` ("unexpected argument '-p'" — which is how the
  // first resumed Director turn died). Every option therefore goes before the
  // subcommand, where the CLI accepts all of them (verified on 0.155.1).
  const args = ['exec', '--json', '--skip-git-repo-check'];
  // Permission profile + automatic approval. `--approve-for-me` is the only
  // way this Codex version permits MCP tool calls in exec mode (without it the
  // role is served tools it can never call); it cannot be combined with
  // `--sandbox`, so the fallback path stays toolless and as tight as the role
  // allows.
  if (profileName) args.push('-p', profileName, '--approve-for-me');
  else args.push('--sandbox', readOnly ? 'read-only' : 'workspace-write');
  if (opts.model.trim()) args.push('-m', opts.model.trim());
  args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  if (opts.resumeThreadId) args.push('resume', opts.resumeThreadId);

  // Tandem's own read-only enforcement around the whole codex process tree —
  // for read-only roles only; a Builder must be able to write its project.
  const jailed = readOnly && !!profileName && bwrapAvailable();
  const spawnBin = jailed ? 'bwrap' : config.codexBin;
  const spawnArgs = jailed
    ? [...readOnlyJailArgs(h.project.rootPath, opts.cwd), config.codexBin, ...args]
    : args;
  if (readOnly && profileName && !jailed) {
    // honest: tools are on, but the read-only boundary is not OS-enforced here
    h.status(`bubblewrap is unavailable on this host — the ${opts.role} runs with tools but without Tandem's OS-enforced read-only boundary.`);
  }

  const cliShown = `${jailed ? 'bwrap … ' : ''}${config.codexBin} ${args.join(' ')}`;
  const startedAt = Date.now();
  const servedTools = profileName
    ? [
      ...(withWorkdir || withBrowser
        ? await servedToolRecord([...(withWorkdir ? ['tandem'] : []), ...(withBrowser ? ['tandem_browser'] : [])])
        : []),
      ...(withExt ? catalogForRole(family).map((t) => ({ name: t.name, description: t.description })) : []),
    ]
    : []; // fallback path serves no MCP servers at all
  const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
  const aiCall = addEvent(h.chat.id, 'ai_call', {
    role: opts.role,
    provider: 'codex',
    model: opts.model,
    effort: opts.effort,
    status: 'running',
    request: { prompt: fullPrompt },
    cli: { command: cliShown, cwd: opts.cwd, exitCode: null },
    startedAt,
    ...(servedTools.length > 0 ? { tools: servedTools } : {}),
  }, { runId: h.ctx.runId });

  const pendingCommands = new Map<string, { eventId: string; startedAt: number }>();
  let lastText = '';
  let usage: AiUsage | undefined;
  let turnError: string | undefined;
  let threadId: string | undefined;

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
    if (type === 'thread.started' && typeof ev.thread_id === 'string') {
      threadId = ev.thread_id; // the session this turn can be continued from
    } else if (type === 'item.started' && itemType(ev) === 'command_execution') {
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
        // Codex reports a message only once it is complete, so the role's
        // visible reply is one event per message rather than a stream
        if (emitActivity && it.text.trim()) {
          const msg = beginAssistantMessage(h.chat.id, h.ctx.runId);
          appendAssistantText(msg, it.text);
          finishAssistantMessage(msg);
        }
      } else if (kind === 'file_change' && emitActivity && Array.isArray(it.changes)) {
        // Codex reports edits as a batch of paths with a kind; the content of
        // the edit is not in the stream, so the record names the files only
        const files = it.changes
          .filter((c: any) => typeof c?.path === 'string')
          .map((c: any) => ({ path: relPath(opts.cwd, c.path), additions: 0, deletions: 0, diff: `(${fileStatus(String(c.kind ?? ''))} by Codex — content not reported in the stream)` }));
        if (files.length > 0) addEvent(h.chat.id, 'file_change', { files }, { runId: h.ctx.runId });
      }
      // reasoning / todo_list / mcp items: not part of the recorded conversation
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
      TANDEM_BROWSER_ROLE: family,
      TANDEM_ROLE: family,
      TANDEM_LOGICAL_ROLE: opts.role,
      TANDEM_TOOL_TEXT: toolTextEnv(),
    },
    stdinData: fullPrompt,
    timeoutMs: opts.timeoutMs,
    onLine,
  });

  removeRoleProfile(profileName); // the per-turn profile carries the internal token
  const durationMs = Date.now() - startedAt;
  const stopped = h.ctx.stopped;
  let error: string | undefined;
  if (!stopped) {
    if (proc.spawnError) error = `Could not start the Codex CLI (${config.codexBin}): ${proc.spawnError}`;
    else if (proc.timedOut) error = `The Codex CLI call timed out after ${Math.round(opts.timeoutMs / 60000)} minutes.`;
    else if (turnError) error = turnError;
    else if (proc.exitCode !== 0) error = `The Codex CLI exited with code ${proc.exitCode}.${proc.stderrTail ? ` stderr: ${proc.stderrTail.slice(-600)}` : ''}`;
    else if (!lastText.trim()) error = `The Codex CLI produced no ${opts.role.replace('_', ' ')} message.`;
  }
  const ok = !stopped && !error;

  updateEvent(aiCall.id, {
    status: stopped ? 'stopped' : ok ? 'done' : 'failed',
    durationMs,
    response: lastText || usage ? { text: lastText, usage } : undefined,
    ...(threadId ? { sessionId: threadId } : {}),
    cli: { command: cliShown, cwd: opts.cwd, exitCode: proc.exitCode },
    ...(error ? { error } : {}),
  });

  return { ok, stopped, text: lastText, usage, threadId, durationMs, error };
}

function itemType(ev: any): string {
  return String(ev.item?.type ?? ev.item?.item_type ?? '');
}

function relPath(cwd: string, p: string): string {
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function fileStatus(kind: string): 'added' | 'modified' | 'deleted' {
  const k = kind.toLowerCase();
  return k === 'add' || k === 'added' || k === 'create' ? 'added' : k === 'delete' || k === 'deleted' ? 'deleted' : 'modified';
}
