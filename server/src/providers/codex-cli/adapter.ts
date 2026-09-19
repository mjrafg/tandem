/**
 * Codex CLI as a provider.
 *
 * Everything Codex-specific is behind this file: the JSONL event stream, the
 * `exec resume` session mechanics, the per-turn permission profile and MCP
 * declarations (all in runTurn.ts), and the CLI's failure wording (errors.ts).
 * The rest of Tandem sees a ProviderAdapter.
 *
 * Declared honestly: the installed Codex CLI (0.147) has no on-demand context
 * report and no explicit compact operation reachable through `codex exec`
 * (slash commands are TUI-only; sent through exec they reach the model as
 * plain text). Codex compacts its own context automatically inside long
 * invocations, which needs nothing from Tandem — so those two capabilities
 * are absent, and Tandem's context management says so instead of pretending.
 */
import { execFile } from 'node:child_process';
import type { ProviderDescriptor, ProviderHealth } from '../../../../shared/types';
import { config } from '../../config';
import { checkStatus } from '../../providerAuth';
import { CODEX_MODELS } from '../catalog';
import type { ProviderAdapter, ProviderTurnRequest, ProviderTurnResult } from '../types';
import { classifyCodexFailure } from './errors';
import { runCodexTurn } from './runTurn';

export const codexDescriptor: ProviderDescriptor = {
  id: 'codex',
  label: 'Codex CLI',
  shortLabel: 'Codex',
  transport: 'cli',
  models: CODEX_MODELS,
  defaultModel: 'gpt-5.6-sol',
  capabilities: {
    resumableSessions: true,
    // a message arrives whole once it is complete; nothing is streamed mid-message
    streaming: false,
    nativeContextInspection: false,
    nativeCompaction: false,
    mcp: true,
    commandExecutionEvents: true,
    // edits are reported as paths only; content is not in the stream
    fileOperationEvents: true,
    browserTools: true,
  },
  roles: ['builder', 'final_repair', 'builder_reviewer', 'director_reviewer', 'director', 'arbiter'],
};

async function runTurn(req: ProviderTurnRequest): Promise<ProviderTurnResult> {
  const r = await runCodexTurn(req.handle, {
    role: req.role,
    model: req.model,
    effort: req.effort,
    systemPrompt: req.systemPrompt,
    prompt: req.userPrompt,
    cwd: req.cwd,
    resumeThreadId: req.session?.id ?? null,
    policy: req.policy,
    emitActivity: req.emitActivity,
    nameSession: req.nameSession,
    timeoutMs: req.timeoutMs,
  });
  return {
    status: r.stopped ? 'stopped' : r.ok ? 'completed' : 'failed',
    answer: r.text,
    ...(r.threadId ? { session: { provider: 'codex' as const, role: req.role, id: r.threadId } } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    durationMs: r.durationMs,
    ...(!r.ok && !r.stopped ? { failure: classifyCodexFailure(r.error) } : {}),
  };
}

/** Installed and signed in? Reads `codex login status`; spends nothing. */
async function health(): Promise<ProviderHealth> {
  const version = await new Promise<string | null>((resolve) => {
    execFile(config.codexBin, ['--version'], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
  if (version === null) return { provider: 'codex', configured: false, detail: `The Codex CLI (${config.codexBin}) could not be started.` };
  const st = await checkStatus('codex');
  return { provider: 'codex', configured: true, version, authenticated: st.loggedIn, detail: st.detail };
}

export const codexCliAdapter: ProviderAdapter = {
  descriptor: codexDescriptor,
  runTurn,
  health,
};
