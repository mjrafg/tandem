import type { Chat, CompactionPayload, CompactOutcome, Provider, ProviderSessionRef } from '../../../shared/types';
import { computeUsage } from '../context';
import { getProject } from '../db';
import { addEvent } from '../events';
import { getSettings } from '../settings';
import { providerLabel, providerShortLabel } from '../providers/executor';
import { providerRegistry } from '../providers/registry';
import { resolveBuilderRole } from '../providers/resolve';
import { storedSessionRef } from '../providers/sessions';
import type { NativeContextReading } from '../providers/types';
import { beginCompaction, endCompaction } from './run';

/**
 * Provider-native context management. Tandem never summarizes conversations
 * itself and never sends them to another model — it asks the provider that
 * OWNS the active session to inspect or compact its own context, through the
 * adapter's declared capabilities. Nothing here knows which backend that is.
 */

export type { NativeContextReading } from '../providers/types';

/**
 * The provider/model that owns a chat's conversation session.
 *
 * A Director session chat is owned by the model its immutable Agent snapshot
 * pins — compacting it with the Builder ROLE model would resume that session
 * under a different model than the one that created it. Chats without a
 * snapshot (ordinary chats) follow the Builder role settings as before.
 */
export function sessionProvider(chatId?: string): { provider: Provider; model: string } {
  const r = resolveBuilderRole(getSettings(), chatId);
  return { provider: r.provider, model: r.model };
}

// ------------------------------------------------------------- native operations

/** Ask the provider for the session's real context state, if it can report one. */
export async function readNativeContext(provider: Provider, ref: ProviderSessionRef, model: string, cwd: string): Promise<NativeContextReading> {
  const adapter = providerRegistry.get(provider);
  if (!adapter.descriptor.capabilities.nativeContextInspection || !adapter.readContext) {
    return { ok: false, error: `${adapter.descriptor.label} has no on-demand context report for a session; context is tracked from per-turn usage instead.` };
  }
  return adapter.readContext(ref, model, cwd);
}

/** Ask the provider to compact its own session, if it can. */
async function runNativeCompact(provider: Provider, ref: ProviderSessionRef, model: string, cwd: string): Promise<{ ok: boolean; error?: string; resultText?: string }> {
  const adapter = providerRegistry.get(provider);
  if (!adapter.descriptor.capabilities.nativeCompaction || !adapter.compactSession) {
    return {
      ok: false,
      error: `${adapter.descriptor.label} exposes no explicit compact operation Tandem can invoke; it manages its own context inside long invocations, and that native behavior needs nothing from Tandem.`,
    };
  }
  return adapter.compactSession(ref, model, cwd);
}

// ------------------------------------------------------------- the operation

/**
 * The full provider-native compaction flow for a chat: read real context,
 * compact natively, read again, record one honest compaction event.
 * On failure: one honest error event, session untouched, nothing simulated.
 */
/**
 * A compaction drives the chat's provider session for minutes and registers no
 * RunCtx, so without this the chat reads as idle throughout and the next turn
 * would resume the SAME session id concurrently. Both workflow call sites
 * launch it from a run's `finally` — after releaseCtx — which is exactly when
 * that race is open. Marking the chat busy makes startRun, startReviewRetry,
 * the sweeper and the manual /compact route all wait, as they already do for a
 * live run. The lock is released on every exit path, including a throw.
 */
export async function performNativeCompaction(
  chat: Chat,
  reason: 'manual' | 'auto',
  override?: { provider: Provider; model: string },
): Promise<CompactOutcome> {
  beginCompaction(chat.id);
  try {
    return await compactInner(chat, reason, override);
  } finally {
    endCompaction(chat.id);
  }
}

async function compactInner(
  chat: Chat,
  reason: 'manual' | 'auto',
  /** compaction target when the chat's conversation is NOT the Builder's —
   * the Project Chat's session belongs to the Director (always claude-code) */
  override?: { provider: Provider; model: string },
): Promise<CompactOutcome> {
  const { provider, model } = override ?? sessionProvider(chat.id);
  const startedAt = Date.now();

  const fail = (error: string): CompactOutcome => {
    addEvent(chat.id, 'error', {
      message: `Native context compaction failed · ${providerShortLabel(provider)}`,
      detail: error,
      source: 'context',
      retryable: true,
    });
    return { ok: false, provider, model, durationMs: Date.now() - startedAt, error };
  };

  const stored = storedSessionRef(chat.id);
  if (!stored) {
    // nothing to compact — no error event for this; the caller shows it inline
    return {
      ok: false, provider, model, durationMs: 0,
      error: 'This chat has no active provider session yet — send a message first.',
    };
  }
  if (stored.provider !== provider) {
    // a session is never driven by a provider that did not create it
    const owner = providerLabel(stored.provider);
    const now = providerLabel(provider);
    return {
      ok: false, provider, model, durationMs: 0,
      error: `The active session was created by ${owner}, but this role's provider is now ${now}. `
        + `A new ${now} session starts with the next message, and context management will follow it.`,
    };
  }
  const project = getProject(chat.projectId);
  if (!project) return fail('The chat\'s project no longer exists.');
  const cwd = project.rootPath;
  const sessionId = stored.id;

  // before: prefer the provider's own reading; fall back to the meter estimate
  const before = await readNativeContext(provider, stored, model, cwd);
  const est = computeUsage(chat);
  const beforeTokens = before.ok ? before.usedTokens : est.usedTokens != null ? est.usedTokens + est.pendingTokens : undefined;
  const windowBefore = before.ok ? before.windowTokens : est.windowTokens ?? undefined;

  const compacted = await runNativeCompact(provider, stored, model, cwd);
  if (!compacted.ok) return fail(compacted.error ?? 'Unknown error.');

  const after = await readNativeContext(provider, stored, model, cwd);
  // A compaction that changed nothing is a failure whatever the CLI said: its
  // summarization is a model call, and under a provider outage it can return
  // success with the session untouched. Recording that as a compaction would
  // anchor the meter at the same size and hide that nothing happened; failing
  // it records the truth and lets the next run's end try again.
  const shrankFrom = before.ok ? before.usedTokens : undefined;
  const shrankTo = after.ok ? after.usedTokens : undefined;
  if (shrankFrom != null && shrankTo != null && shrankTo >= shrankFrom * 0.95) {
    return fail(`The provider accepted /compact but the context did not shrink (${shrankFrom.toLocaleString()} → ${shrankTo.toLocaleString()} tokens) — `
      + 'its summarization call most likely failed (an overload or a limit). It is retried after the next run, or now with /compact.');
  }
  const payload: CompactionPayload = {
    provider,
    model,
    beforeTokens,
    afterTokens: after.ok ? after.usedTokens : undefined,
    windowTokens: after.ok ? after.windowTokens : windowBefore,
    source: before.ok && after.ok ? 'provider' : 'estimated',
    reason,
    sessionId,
    durationMs: Date.now() - startedAt,
  };
  addEvent(chat.id, 'compaction', payload);
  return {
    ok: true, provider, model,
    beforeTokens: payload.beforeTokens, afterTokens: payload.afterTokens,
    windowTokens: payload.windowTokens, source: payload.source,
    durationMs: payload.durationMs!,
  };
}
