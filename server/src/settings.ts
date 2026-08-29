import type { AppSettings, RoleName } from '../../shared/types';
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
      model: 'gpt-5-codex',
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

/**
 * The concise built-in role instructions. These are the actual strings the
 * engine will hand to each CLI (plus the user's additional instructions), and
 * they are shown verbatim in the Admin prompt preview — no hidden layers.
 */
export const BASE_PROMPTS: Record<RoleName | 'final_repair', string> = {
  builder: [
    'You are the Builder, the coding agent for this project.',
    'Understand the request and decide yourself how to investigate and act: read, search, run commands, edit files, verify.',
    'Do only what the request needs. Report honestly what you did and what you found.',
  ].join('\n'),
  reviewer: [
    'You are the Reviewer. Independently evaluate the current state of the project against the user\'s original request.',
    'You may inspect the project read-only; you must not modify anything.',
    'Reply PASS if the request is correctly and completely implemented with no regressions.',
    'Otherwise list concrete, actionable findings with file evidence. Do not demand unrelated improvements.',
  ].join('\n'),
  compactor: [
    'You are the Compactor. Produce a compact replacement for this conversation\'s context.',
    'Preserve: goals, instructions, decisions, current task state, key discoveries, changed files, test results that still matter, unresolved issues, reviewer findings, constraints, remaining work.',
    'Aggressively drop stale noise and repetition.',
  ].join('\n'),
  final_repair: [
    'This is the final repair round. Address the reviewer\'s remaining findings precisely.',
    'There will be no further review after this — keep the change minimal and safe.',
  ].join('\n'),
};

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

export function composeEffectivePrompt(role: RoleName | 'final_repair', settings: AppSettings): string {
  const parts: string[] = [];
  parts.push(`# Built-in ${role.replace('_', ' ')} instructions\n${BASE_PROMPTS[role]}`);
  if (settings.sharedInstructions.trim()) {
    parts.push(`# Shared instructions (Admin)\n${settings.sharedInstructions.trim()}`);
  }
  const roleCfg = role === 'final_repair' ? null : settings.roles[role];
  const extra = role === 'final_repair' ? settings.finalRepairInstructions : roleCfg?.instructions ?? '';
  if (extra.trim()) {
    parts.push(`# Additional ${role.replace('_', ' ')} instructions (Admin)\n${extra.trim()}`);
  }
  parts.push(
    '# At call time, the application appends\n' +
    '- the project name and working directory\n' +
    '- the active conversation context (or its compacted form)\n' +
    '- the current request (user message, reviewer findings to repair, or content to compact)',
  );
  return parts.join('\n\n');
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
