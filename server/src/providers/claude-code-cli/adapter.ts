/**
 * Claude Code CLI as a provider.
 *
 * Everything Claude-specific is behind this file: stream-json parsing, the
 * `--resume` session mechanics, hooks, MCP config files, the OAuth token and
 * thinking-budget environment (all in runTurn.ts), `/context` and `/compact`
 * (context.ts), and the CLI's failure wording (errors.ts). The rest of Tandem
 * sees a ProviderAdapter.
 */
import { execFile } from 'node:child_process';
import type { ProviderDescriptor, ProviderHealth } from '../../../../shared/types';
import { config } from '../../config';
import { checkStatus } from '../../providerAuth';
import { CLAUDE_CODE_MODELS } from '../catalog';
import type { ProviderAdapter, ProviderTurnRequest, ProviderTurnResult } from '../types';
import { compactClaudeSession, readClaudeContext } from './context';
import { classifyClaudeFailure } from './errors';
import { runClaudeTurn } from './runTurn';

export const claudeCodeDescriptor: ProviderDescriptor = {
  id: 'claude-code',
  label: 'Claude Code CLI',
  shortLabel: 'Claude',
  transport: 'cli',
  models: CLAUDE_CODE_MODELS,
  defaultModel: 'claude-opus-5',
  capabilities: {
    resumableSessions: true,
    streaming: true,
    nativeContextInspection: true,
    nativeCompaction: true,
    mcp: true,
    commandExecutionEvents: true,
    fileOperationEvents: true,
    browserTools: true,
  },
  roles: ['builder', 'final_repair', 'builder_reviewer', 'director_reviewer', 'director', 'arbiter'],
};

async function runTurn(req: ProviderTurnRequest): Promise<ProviderTurnResult> {
  const r = await runClaudeTurn(req.handle, {
    role: req.role,
    model: req.model,
    effort: req.effort,
    systemAppendix: req.systemPrompt,
    message: req.userPrompt,
    cwd: req.cwd,
    resumeSessionId: req.session?.id ?? null,
    policy: req.policy,
    emitActivity: req.emitActivity,
    nameSession: req.nameSession,
    difficulty: req.difficulty,
    modelSource: req.modelSource,
    timeoutMs: req.timeoutMs,
  });
  return {
    status: r.stopped ? 'stopped' : r.ok ? 'completed' : 'failed',
    answer: r.resultText,
    ...(r.sessionId ? { session: { provider: 'claude-code' as const, role: req.role, id: r.sessionId } } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.actualModel ? { actualModel: r.actualModel } : {}),
    durationMs: r.durationMs,
    ...(!r.ok && !r.stopped ? { failure: classifyClaudeFailure(r.error) } : {}),
  };
}

/** Installed and signed in? Reads the CLI's own status; spends nothing. */
async function health(): Promise<ProviderHealth> {
  const version = await new Promise<string | null>((resolve) => {
    execFile(config.claudeBin, ['--version'], { timeout: 15_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
  if (version === null) return { provider: 'claude-code', configured: false, detail: `The Claude Code CLI (${config.claudeBin}) could not be started.` };
  const st = await checkStatus('claude');
  return { provider: 'claude-code', configured: true, version, authenticated: st.loggedIn, detail: st.detail };
}

export const claudeCodeCliAdapter: ProviderAdapter = {
  descriptor: claudeCodeDescriptor,
  runTurn,
  health,
  readContext: (session, model, cwd) => readClaudeContext(session.id, model, cwd),
  compactSession: (session, model, cwd) => compactClaudeSession(session.id, model, cwd),
};
