import type { AppSettings, DirectorRoleConfig } from '../../shared/types';
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
    autoCompact: false,
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
export function resolveDirectorRole(s: AppSettings): DirectorRoleConfig {
  const d = s.roles.director;
  const b = s.roles.builder;
  const model = d?.model?.trim()
    ? d.model.trim()
    : b.provider === 'claude-code' && b.model.trim() ? b.model : DEFAULT_SETTINGS.roles.builder.model;
  return { model, effort: d?.effort ?? b.effort };
}

// All built-in instruction text lives in prompts.ts (Admin → AI Prompts).

export function getSettings(): AppSettings {
  const stored = kvGet<AppSettings>('settings');
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // deep-merge over defaults so new fields appear after upgrades
  const merged = structuredClone(DEFAULT_SETTINGS);
  deepMerge(merged as any, stored as any);
  stripObsolete(merged);
  return merged;
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
  const c = merged.context;
  c.warnPct = clamp(c.warnPct, 10, 99);
  c.compactPct = clamp(c.compactPct, 10, 99);
  c.critPct = clamp(c.critPct, 10, 99);
  c.preserveRecentTokens = clamp(c.preserveRecentTokens, 0, 200_000);
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
