import type { AiUsage, Effort } from '../../../shared/types';
import { config } from '../config';
import { addEvent, updateEvent } from '../events';
import { spawnStreaming } from './procs';
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
 * One real Codex CLI review call — strictly read-only (`--sandbox read-only`
 * is enforced by Codex at the OS level, which is the hard boundary the product
 * requires; the prompt merely restates it).
 */
export async function runCodexReview(h: RunHandle, opts: {
  model: string;
  effort: Effort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
}): Promise<CodexResult> {
  const args = [
    'exec',
    '--json',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
  ];
  if (opts.model.trim()) args.push('-m', opts.model.trim());
  args.push('-c', `model_reasoning_effort="${opts.effort}"`);

  const cliShown = `${config.codexBin} ${args.join(' ')}`;
  const startedAt = Date.now();
  const aiCall = addEvent(h.chat.id, 'ai_call', {
    role: 'reviewer',
    provider: 'codex',
    model: opts.model,
    effort: opts.effort,
    status: 'running',
    request: { prompt: opts.prompt },
    cli: { command: cliShown, cwd: opts.cwd, exitCode: null },
    startedAt,
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
    env: { OPENAI_API_KEY: '', NO_COLOR: '1' },
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
