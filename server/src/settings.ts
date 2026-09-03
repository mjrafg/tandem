import type { AppSettings, Effort } from '../../shared/types';
import { kvGet, kvSet } from './db';

export const DEFAULT_SETTINGS: AppSettings = {
  roles: {
    builder: {
      provider: 'claude-code',
      model: 'claude-opus-5',
      effort: 'high',
      instructions: '',
    },
    reviewer: {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions: '',
      enabled: true,
    },
  },
  finalRepairInstructions: '',
  sharedInstructions: '',
  context: {
    // percentages of the provider's reported context window for the session
    warnPct: 70,
    compactPct: 75,
    critPct: 88,
    // A percentage of a window that grew from 200k to 1M silently went inert:
    // 75% of 1M is 750k, and no session ever reached it, so compaction never
    // ran once. Cost is close to linear in context size x request count, so the
    // real ceiling is expressed in TOKENS and whichever limit trips first wins.
    // also handed to the Claude Code CLI as CLAUDE_CODE_AUTO_COMPACT_WINDOW, so
    // the CLI compacts INSIDE a run as it nears this size (it keeps a ~16% buffer)
    compactMaxTokens: 200_000,
    autoCompact: true,
    preserveRecentTokens: 12_000,
  },
};

/**
 * The Project Director's effective model settings. Installs without
 * roles.director follow the Builder's model + effort — but the Director runs
 * on the Claude Code adapter ALWAYS, so a Codex-configured Builder never
 * leaks its model name into the Director: the fallback then uses the stock
 * Claude model instead. Once a Director model is saved, it stands on its own.
 */
export function resolveDirectorRole(s: AppSettings): { model: string; effort: Effort } {
  const d = s.roles.director;
  const b = s.roles.builder;
  const model = d?.model?.trim()
    ? d.model.trim()
    : b.provider === 'claude-code' && b.model.trim() ? b.model : DEFAULT_SETTINGS.roles.builder.model;
  return { model, effort: d?.effort ?? b.effort };
}

// All built-in instruction text lives in prompts.ts (Admin → AI Prompts).

/**
 * One-time upgrade for installations that predate the token ceiling.
 *
 * `autoCompact` used to mean "compact at compactPct% of the window". That was
 * written when windows were 200k, and silently became a 750k trigger when they
 * grew to 1M — past anything a session ever reached, so compaction never ran
 * once and the switch was inert whichever way it was set. It now means "compact
 * at compactMaxTokens, or compactPct%, whichever comes first", which is a
 * different and actually reachable promise.
 *
 * Turning a switch back on that was never doing anything is not overriding a
 * working preference. It happens exactly once, keyed on the absence of the new
 * field, and the admin can turn it straight back off — that choice then sticks,
 * because compactMaxTokens is present from then on.
 */
export function migrateContextDefaults(): void {
  const stored = kvGet<AppSettings>('settings');
  if (!stored?.context || stored.context.compactMaxTokens !== undefined) return;
  const merged = getSettings();
  merged.context.compactMaxTokens = DEFAULT_SETTINGS.context.compactMaxTokens;
  merged.context.autoCompact = true;
  kvSet('settings', merged);
  console.log(`[tandem] context: auto-compact enabled at ${merged.context.compactMaxTokens} tokens `
    + `(the old percentage trigger sat above any reachable context and never fired)`);
}

export function getSettings(): AppSettings {
  const stored = kvGet<AppSettings>('settings');
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // deep-merge over defaults so new fields appear after upgrades
  const merged = structuredClone(DEFAULT_SETTINGS);
  deepMerge(merged as any, stored as any);
  stripObsolete(merged);
  lockProviders(merged);
  return merged;
}

/**
 * TODO(provider-swap): Builder/Reviewer providers are intentionally LOCKED to
 * the only combination the execution layer implements (Builder = Claude Code,
 * Reviewer = Codex). The workflow dispatches to runClaudeTurn/runCodexReview
 * unconditionally, while compaction and the context meter follow this
 * configured provider — so a stored swap produced a split-brain (wrong CLI
 * given the other provider's model, meter/compaction describing a session that
 * doesn't exist). Locking here keeps every reader coherent. Re-enable the
 * selector only once the engine has provider-aware dispatch, session
 * resume/compaction for both providers, per-provider MCP wiring for both
 * roles, and a reviewer-failure policy that doesn't silently skip review.
 * A role whose stored provider was swapped also gets its model reset to the
 * locked provider's default — the old model name belongs to the other CLI.
 */
function lockProviders(s: AppSettings): void {
  if (s.roles.builder.provider !== 'claude-code') {
    s.roles.builder.provider = 'claude-code';
    s.roles.builder.model = DEFAULT_SETTINGS.roles.builder.model;
  }
  if (s.roles.reviewer.provider !== 'codex') {
    s.roles.reviewer.provider = 'codex';
    s.roles.reviewer.model = DEFAULT_SETTINGS.roles.reviewer.model;
  }
}

/** Configuration for the removed Compactor role no longer affects runtime — drop it. */
function stripObsolete(s: AppSettings): void {
  delete (s.roles as any).compactor;
  for (const key of Object.keys(s.context)) {
    if (!(key in DEFAULT_SETTINGS.context)) delete (s.context as any)[key];
  }
}

export function putSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = getSettings();
  deepMerge(merged as any, patch as any);
  stripObsolete(merged);
  lockProviders(merged);
  const c = merged.context;
  c.warnPct = clamp(c.warnPct, 10, 99);
  c.compactPct = clamp(c.compactPct, 10, 99);
  c.critPct = clamp(c.critPct, 10, 99);
  c.preserveRecentTokens = clamp(c.preserveRecentTokens, 0, 200_000);
  c.compactMaxTokens = clamp(c.compactMaxTokens, 50_000, 2_000_000);
  kvSet('settings', merged);
  return merged;
}

function deepMerge(target: Record<string, any>, src: Record<string, any>): void {
  for (const key of Object.keys(src)) {
    const s = src[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && target[key] && typeof target[key] === 'object') {
      deepMerge(target[key], s);
    } else if (s !== undefined) {
      target[key] = s;
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
}
