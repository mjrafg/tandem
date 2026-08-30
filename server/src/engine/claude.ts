import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiUsage, ChangedFile, ChatEvent, Effort } from '../../../shared/types';
import { config, internalBase, shotsDir } from '../config';
import {
  addEvent, appendAssistantText, beginAssistantMessage, finishAssistantMessage, updateEvent,
} from '../events';
import { spawnStreaming } from './procs';
import { recordModelWindow } from '../context';
import { catalogForRole, hasIntegrationTools } from '../integrations/exec';
import { servedToolRecord, toolTextEnv } from '../toolText';
import type { RunHandle } from './run';

export interface ClaudeTurnResult {
  ok: boolean;
  stopped: boolean;
  resultText: string;
  usage?: AiUsage;
  sessionId?: string;
  actualModel?: string;
  durationMs: number;
  numTurns?: number;
  error?: string;
}

const EFFORT_THINKING: Record<Effort, string> = { low: '', medium: '12000', high: '30000' };

/**
 * One real Claude Code CLI invocation. The CLI is the agent: it decides which
 * tools to use; this adapter only records what actually happens and enforces
 * process-level boundaries (timeout, stop, environment).
 */
export async function runClaudeTurn(h: RunHandle, opts: {
  role: 'builder' | 'final_repair' | 'director';
  model: string;
  effort: Effort;
  systemAppendix: string;
  message: string;
  cwd: string;
  resumeSessionId?: string | null;
  withTandemTools?: boolean;
  /** the Project Director's orchestration tool server (instead of the builder tool set) */
  withDirectorTools?: boolean;
  emitActivity?: boolean;
  timeoutMs: number;
}): Promise<ClaudeTurnResult> {
  const emitActivity = opts.emitActivity !== false;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', opts.model,
    '--permission-mode', 'bypassPermissions',
  ];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  args.push('--append-system-prompt', opts.systemAppendix);

  let mcpConfigFile: string | null = null;
  if (opts.withTandemTools) {
    const distDir = path.dirname(process.argv[1] ?? '.');
    const workdirScript = path.resolve(distDir, 'mcp-workdir.cjs');
    const browserScript = path.resolve(distDir, 'mcp-browser.cjs');
    const extScript = path.resolve(distDir, 'mcp-integrations.cjs');
    const mcpServers: Record<string, unknown> = {};
    // Tandem env (chat id, internal token, shots dir) is inherited from this
    // process's environment by the stdio servers.
    if (fs.existsSync(workdirScript)) {
      mcpServers.tandem = { type: 'stdio', command: process.execPath, args: [workdirScript] };
    }
    if (fs.existsSync(browserScript)) {
      mcpServers.tandem_browser = { type: 'stdio', command: process.execPath, args: [browserScript] };
    }
    // Admin-configured integration tools, served through the gateway (the
    // gateway loads the role-filtered catalog fresh on every invocation, so
    // new integrations become available without any Tandem restart)
    if (fs.existsSync(extScript) && hasIntegrationTools(opts.role)) {
      mcpServers.tandem_ext = { type: 'stdio', command: process.execPath, args: [extScript] };
    }
    if (Object.keys(mcpServers).length > 0) {
      mcpConfigFile = path.join(config.dataDir, 'tmp', `mcp-${randomUUID()}.json`);
      fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers }));
      args.push('--mcp-config', mcpConfigFile, '--strict-mcp-config');
    }
  } else if (opts.withDirectorTools) {
    const directorScript = path.resolve(path.dirname(process.argv[1] ?? '.'), 'mcp-director.cjs');
    if (fs.existsSync(directorScript)) {
      mcpConfigFile = path.join(config.dataDir, 'tmp', `mcp-${randomUUID()}.json`);
      fs.writeFileSync(mcpConfigFile, JSON.stringify({
        mcpServers: { tandem_director: { type: 'stdio', command: process.execPath, args: [directorScript] } },
      }));
      args.push('--mcp-config', mcpConfigFile, '--strict-mcp-config');
    }
  }

  const cliShown = `${config.claudeBin} ${args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ')}`;
  const startedAt = Date.now();
  const servedTools = opts.withTandemTools
    ? [
      ...await servedToolRecord(['tandem', 'tandem_browser']),
      ...catalogForRole(opts.role).map((t) => ({ name: t.name, description: t.description })),
    ]
    : [];
  const aiCall = addEvent(h.chat.id, 'ai_call', {
    role: opts.role,
    provider: 'claude-code',
    model: opts.model,
    effort: opts.effort,
    status: 'running',
    request: { prompt: `[system additions]\n${opts.systemAppendix}\n\n[message]\n${opts.message}`, system: undefined },
    cli: { command: cliShown, cwd: opts.cwd, exitCode: null },
    startedAt,
    ...(servedTools.length > 0 ? { tools: servedTools } : {}),
  }, { runId: h.ctx.runId });

  // --- stream state
  const pendingTools = new Map<string, { eventId: string; kind: string; startedAt: number }>();
  let currentText: ChatEvent | null = null;
  let partialsSeen = false;
  let streamedChars = 0;
  let sessionId: string | undefined;
  let actualModel: string | undefined;
  let resultText = '';
  let usage: AiUsage | undefined;
  let numTurns: number | undefined;
  let resultError: string | undefined;
  let sawResult = false;

  const finishText = () => {
    if (currentText) {
      finishAssistantMessage(currentText);
      currentText = null;
    }
  };

  const onLine = (line: string) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    switch (ev.type) {
      case 'system': {
        if (ev.subtype === 'init') {
          sessionId = ev.session_id;
          actualModel = ev.model;
          if (actualModel && actualModel !== opts.model) updateEvent(aiCall.id, { model: actualModel });
        } else if (ev.subtype === 'compact_boundary') {
          // the CLI compacted the session's context on its own mid-run —
          // record the provider's action, never treat it as an error
          const meta = ev.compact_metadata ?? {};
          addEvent(h.chat.id, 'compaction', {
            provider: 'claude-code',
            model: actualModel ?? opts.model,
            reason: meta.trigger === 'manual' ? 'manual' : 'provider-auto',
            source: 'provider',
            ...(typeof meta.pre_tokens === 'number' ? { beforeTokens: meta.pre_tokens } : {}),
            ...(sessionId ? { sessionId } : {}),
          }, { runId: h.ctx.runId });
        }
        break;
      }
      case 'stream_event': {
        if (!emitActivity) break;
        if (ev.parent_tool_use_id) break; // subagent internals
        const se = ev.event;
        if (!se) break;
        if (se.type === 'content_block_start' && se.content_block?.type === 'text') {
          partialsSeen = true;
          finishText();
          currentText = beginAssistantMessage(h.chat.id, h.ctx.runId);
        } else if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && currentText) {
          streamedChars += se.delta.text.length;
          appendAssistantText(currentText, se.delta.text);
        } else if (se.type === 'content_block_stop') {
          finishText();
        }
        break;
      }
      case 'assistant': {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            if (!emitActivity) continue;
            const mapped = mapToolUse(h, opts.cwd, block.name, block.input ?? {});
            if (mapped) pendingTools.set(block.id, { ...mapped, startedAt: Date.now() });
          } else if (block.type === 'text' && emitActivity && !partialsSeen && block.text?.trim()) {
            const msg = beginAssistantMessage(h.chat.id, h.ctx.runId);
            appendAssistantText(msg, block.text);
            finishAssistantMessage(msg);
            streamedChars += block.text.length;
          }
        }
        break;
      }
      case 'user': {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const pending = pendingTools.get(block.tool_use_id);
          if (!pending) continue;
          pendingTools.delete(block.tool_use_id);
          resolveToolResult(pending, block);
        }
        break;
      }
      case 'result': {
        sawResult = true;
        resultText = typeof ev.result === 'string' ? ev.result : '';
        numTurns = ev.num_turns;
        if (ev.usage) {
          usage = {
            inputTokens: (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0),
            outputTokens: ev.usage.output_tokens ?? 0,
          };
          // the FINAL turn's tokens describe the session's current context size;
          // the cumulative numbers above describe what the call consumed
          const iters = Array.isArray(ev.usage.iterations) ? ev.usage.iterations.filter((i: any) => i && (i.input_tokens != null || i.cache_read_input_tokens != null)) : [];
          const last = iters[iters.length - 1];
          if (last) {
            usage.contextTokens = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0)
              + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
          }
          // provider-reported context window of the model that served the call
          const mu = ev.modelUsage;
          if (mu && typeof mu === 'object') {
            const entry = (actualModel && mu[actualModel]) || Object.values(mu)[0];
            const win = (entry as any)?.contextWindow;
            if (typeof win === 'number' && win > 0) {
              usage.contextWindow = win;
              recordModelWindow('claude-code', actualModel ?? opts.model, win);
            }
          }
        }
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
          resultError = ev.subtype === 'error_max_turns'
            ? 'The call hit its turn limit.'
            : `CLI reported ${ev.subtype ?? 'an error'}${resultText ? `: ${resultText.slice(0, 400)}` : ''}`;
        }
        break;
      }
      default:
        break; // rate_limit_event, api_retry etc. — irrelevant to the record
    }
  };

  const proc = await spawnStreaming({
    ctx: h.ctx,
    bin: config.claudeBin,
    args,
    cwd: opts.cwd,
    env: {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ...(EFFORT_THINKING[opts.effort] ? { MAX_THINKING_TOKENS: EFFORT_THINKING[opts.effort] } : {}),
      // inherited by the tandem MCP stdio servers (workdir + browser)
      TANDEM_INTERNAL_URL: internalBase(),
      TANDEM_CHAT_ID: h.chat.id,
      TANDEM_INTERNAL_TOKEN: config.internalToken,
      TANDEM_SHOTS_DIR: shotsDir,
      TANDEM_BROWSER_ROLE: opts.role,
      TANDEM_ROLE: opts.role,
      TANDEM_TOOL_TEXT: toolTextEnv(),
    },
    stdinData: opts.message,
    timeoutMs: opts.timeoutMs,
    onLine,
  });

  finishText();
  if (mcpConfigFile) fs.rmSync(mcpConfigFile, { force: true });
  const durationMs = Date.now() - startedAt;

  const stopped = h.ctx.stopped;
  let error: string | undefined;
  if (!stopped) {
    if (proc.spawnError) error = `Could not start the Claude Code CLI (${config.claudeBin}): ${proc.spawnError}`;
    else if (proc.timedOut) error = `The Claude Code CLI call timed out after ${Math.round(opts.timeoutMs / 60000)} minutes.`;
    else if (resultError) error = resultError;
    else if (!sawResult) error = `The Claude Code CLI exited (code ${proc.exitCode}) without a result.${proc.stderrTail ? ` stderr: ${proc.stderrTail.slice(-600)}` : ''}`;
  }
  const ok = !stopped && !error;

  updateEvent(aiCall.id, {
    status: stopped ? 'stopped' : ok ? 'done' : 'failed',
    durationMs,
    response: resultText || usage ? { text: resultText, usage } : undefined,
    cli: { command: cliShown, cwd: opts.cwd, exitCode: proc.exitCode },
    ...(error ? { error } : {}),
  });

  // guarantee a visible reply even if no text streamed
  if (ok && emitActivity && streamedChars === 0 && resultText.trim()) {
    const msg = beginAssistantMessage(h.chat.id, h.ctx.runId);
    appendAssistantText(msg, resultText);
    finishAssistantMessage(msg);
  }

  return { ok, stopped, resultText, usage, sessionId, actualModel, durationMs, numTurns, error };
}

// ---------------------------------------------------------------- tool mapping

function relPath(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || !p) return String(p ?? '');
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function mapToolUse(h: RunHandle, cwd: string, name: string, input: any): { eventId: string; kind: string } | null {
  const emit = <K extends 'command' | 'file_read' | 'search' | 'file_change' | 'status'>(kind: K, payload: any) =>
    ({ eventId: addEvent(h.chat.id, kind, payload, { runId: h.ctx.runId }).id, kind });

  switch (name) {
    case 'Bash':
      return emit('command', {
        command: String(input.command ?? ''), cwd, stdout: '', stderr: '', exitCode: null, durationMs: 0, status: 'running',
      });
    case 'Read':
      return emit('file_read', { path: relPath(cwd, input.file_path) });
    case 'Grep':
      return emit('search', { query: String(input.pattern ?? ''), tool: 'grep', matches: [] });
    case 'Glob':
      return emit('search', { query: String(input.pattern ?? ''), tool: 'glob', matches: [] });
    case 'WebSearch':
      return emit('search', { query: String(input.query ?? ''), tool: 'web search', matches: [] });
    case 'WebFetch':
      return emit('search', { query: String(input.url ?? ''), tool: 'web fetch', matches: [] });
    case 'Edit':
      return emit('file_change', { files: [editToChangedFile(cwd, input)] });
    case 'MultiEdit': {
      const files = Array.isArray(input.edits)
        ? input.edits.map((e: any) => editToChangedFile(cwd, { file_path: input.file_path, ...e }))
        : [editToChangedFile(cwd, input)];
      return emit('file_change', { files });
    }
    case 'Write':
      return emit('file_change', { files: [writeToChangedFile(cwd, input)] });
    case 'NotebookEdit':
      return emit('file_change', {
        files: [{ path: relPath(cwd, input.notebook_path), additions: 0, deletions: 0, diff: '(notebook cell edit)' }],
      });
    case 'Task':
      return emit('status', { text: `Subagent (${input.subagent_type ?? 'agent'}): ${input.description ?? input.prompt?.slice(0, 80) ?? ''}` });
    case 'TodoWrite':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
    case 'ToolSearch': // CLI-internal plumbing for loading deferred tools
      return null;
    default:
      // tandem MCP tools (workdir, browser) record their own effects via the
      // internal endpoint — mapping them here would duplicate events
      if (name.startsWith('mcp__tandem')) return null;
      return emit('status', { text: `Used tool ${name}` });
  }
}

function capLines(s: string, max: number): string {
  const lines = s.split('\n');
  if (lines.length <= max) return s;
  return [...lines.slice(0, max), `… (${lines.length - max} more lines)`].join('\n');
}

function editToChangedFile(cwd: string, input: any): ChangedFile {
  const oldS = String(input.old_string ?? '');
  const newS = String(input.new_string ?? '');
  const rel = relPath(cwd, input.file_path);
  const oldLines = oldS ? oldS.split('\n') : [];
  const newLines = newS ? newS.split('\n') : [];
  const diff = [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ edit${input.replace_all ? ' (replace all)' : ''} @@`,
    ...capLines(oldLines.map((l) => `-${l}`).join('\n'), 120).split('\n'),
    ...capLines(newLines.map((l) => `+${l}`).join('\n'), 120).split('\n'),
  ].filter((l) => l !== '').join('\n');
  return { path: rel, additions: newLines.length, deletions: oldLines.length, diff };
}

function writeToChangedFile(cwd: string, input: any): ChangedFile {
  const rel = relPath(cwd, input.file_path);
  const content = String(input.content ?? '');
  const lines = content.split('\n');
  const diff = [
    `--- /dev/null`,
    `+++ b/${rel}`,
    `@@ new file (${lines.length} lines) @@`,
    capLines(lines.map((l) => `+${l}`).join('\n'), 200),
  ].join('\n');
  return { path: rel, additions: lines.length, deletions: 0, diff };
}

// ---------------------------------------------------------------- tool results

function resolveToolResult(pending: { eventId: string; kind: string; startedAt: number }, block: any): void {
  const durationMs = Date.now() - pending.startedAt;
  const text = extractResultText(block);
  if (pending.kind === 'command') {
    let exitCode = block.is_error ? 1 : 0;
    const m = text.match(/exit(?: code)?[:\s]+(\d+)/i);
    if (m) exitCode = Number(m[1]);
    updateEvent(pending.eventId, {
      stdout: midTruncate(text, 60_000),
      exitCode,
      durationMs,
      status: block.is_error ? 'failed' : 'done',
    });
  } else if (pending.kind === 'file_read') {
    const lines = text ? text.split('\n').length : undefined;
    if (lines) updateEvent(pending.eventId, { lines });
  } else if (pending.kind === 'search') {
    const matches: { path: string; line: number; preview: string }[] = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^(.{1,300}?):(\d+)[:-](.*)$/);
      if (m) matches.push({ path: m[1], line: Number(m[2]), preview: m[3].trim().slice(0, 160) });
      else if (/^\/[^\s:]+$/.test(line.trim())) matches.push({ path: line.trim(), line: 0, preview: '' });
      if (matches.length >= 20) break;
    }
    if (matches.length > 0) updateEvent(pending.eventId, { matches });
  }
}

function extractResultText(block: any): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x?.type === 'text' ? x.text : '')).join('\n');
  return '';
}

function midTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max / 2)}\n… [truncated ${s.length - max} chars] …\n${s.slice(-max / 2)}`;
}
