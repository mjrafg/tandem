import type { AppSettings } from '../../shared/types';
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
    compactor: {
      provider: 'claude-code',
      model: 'claude-sonnet-5',
      effort: 'low',
      instructions: '',
    },
  },
  finalRepairInstructions: '',
  sharedInstructions: '',
  context: {
    builderLimit: 160_000,
    reviewerLimit: 200_000,
    warnPct: 70,
    compactPct: 75,
    critPct: 88,
    outputReserve: 8_000,
    autoCompact: false,
    autoTargetTokens: 40_000,
    preserveRecentTokens: 12_000,
  },
};

// All built-in instruction text lives in prompts.ts (Admin → AI Prompts).

export function getSettings(): AppSettings {
  const stored = kvGet<AppSettings>('settings');
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // deep-merge over defaults so new fields appear after upgrades
  const merged = structuredClone(DEFAULT_SETTINGS);
  deepMerge(merged as any, stored as any);
  return merged;
}

export function putSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = getSettings();
  deepMerge(merged as any, patch as any);
  const c = merged.context;
  c.builderLimit = clamp(c.builderLimit, 8_000, 2_000_000);
  c.reviewerLimit = clamp(c.reviewerLimit, 8_000, 2_000_000);
  c.warnPct = clamp(c.warnPct, 10, 99);
  c.compactPct = clamp(c.compactPct, 10, 99);
  c.critPct = clamp(c.critPct, 10, 99);
  c.outputReserve = clamp(c.outputReserve, 0, 100_000);
  c.autoTargetTokens = clamp(c.autoTargetTokens, 2_000, 500_000);
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
