import type { AppSettings, Difficulty, Provider } from '../../shared/types';
import { DIFFICULTIES } from '../../shared/types';
import { kvGet, kvSet } from './db';
import { providerOfModel } from './providers/catalog';
import { canonicalProvider } from './providers/ids';

export const DEFAULT_SETTINGS: AppSettings = {
  roles: {
    builder: {
      provider: 'claude-code',
      model: 'claude-opus-5',
      effort: 'high',
      instructions: '',
    },
    // reviews Builder session output — advisory to the Builder, independent
    builder_reviewer: {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions: '',
      enabled: true,
    },
    // independently reviews Director-level decisions — a separate role with
    // separate configuration; it never inherits from the Builder Reviewer
    director_reviewer: {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      instructions: '',
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
  // Difficulty tiers start empty: every tier inherits the role default (or the
  // session's Agent profile), which is exactly what ran before tiers existed.
  // The admin fills in the tiers worth differentiating.
  difficulty: {
    easy: { builder: null, reviewer: null },
    medium: { builder: null, reviewer: null },
    hard: { builder: null, reviewer: null },
    very_hard: { builder: null, reviewer: null },
  },
  orchestration: {
    // an active project with nothing running and nothing scheduled for this
    // long is a stall: the Director is woken with the facts
    stallAfterMinutes: 10,
    // this many consecutive wakes with no progress → pause and ask the user,
    // rather than spending a Director turn every backoff forever
    stallMaxWakes: 5,
  },
  imageGeneration: {
    enabled: true,
    // Codex's built-in image tool runs on the Codex sign-in — nothing to configure
    provider: 'codex',
    model: '',
    credentialId: null,
    quality: 'auto',
  },
  video: {
    engineIntegration: 'animation_engine',
    // animation keyframes and final renders follow the narration's real timing
    timingTools: ['timeline_apply', 'render_video_start'],
    reviewerEngineTools: [
      'engine_capabilities', 'engine_version', 'workspace_list', 'workspace_info', 'scene_list', 'scene_get', 'layer_list',
      'timeline_get', 'asset_list', 'asset_get', 'asset_inspect', 'measure_layout', 'render_preview', 'render_frame',
      'artifact_list', 'render_video_status',
    ],
    paidToolPatterns: [
      'elevenlabs_*generate*', 'elevenlabs_*design_voice*', 'elevenlabs_*transcribe*',
      'elevenlabs_*run_flow*', 'elevenlabs_*edit_image*', '*text_to_speech*',
    ],
    ttsToolPatterns: ['*generate_speech*', '*text_to_speech*'],
    // estimates, not bills: Codex images run on the subscription; the rest are typical list prices
    rates: { imageUsd: { codex: 0, openai: 0.08 }, ttsUsdPer1kChars: 0.3, otherPaidUsd: 0.05 },
  },
};

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
  // a not-yet-migrated store (read before boot migration ran): split in memory
  // the same way, so no reader ever sees one reviewer standing in for the other
  if (stored.roles?.reviewer) {
    if (!stored.roles.builder_reviewer) merged.roles.builder_reviewer = { ...structuredClone(stored.roles.reviewer) };
    if (!stored.roles.director_reviewer) { const { enabled: _e, ...rest } = structuredClone(stored.roles.reviewer) as any; merged.roles.director_reviewer = rest; }
  }
  stripObsolete(merged);
  normalizeProviders(merged);
  return merged;
}

/** the backend each role ran on before roles could choose one */
const LEGACY: Record<'builder' | 'builder_reviewer' | 'director_reviewer' | 'director', Provider> = {
  builder: 'claude-code', builder_reviewer: 'codex', director_reviewer: 'codex', director: 'claude-code',
};

/**
 * One-time split of the generic Reviewer into two independent roles.
 *
 * An installation that predates the split has `roles.reviewer`. Both new roles
 * start from that same configuration — the Director's plan reviews and the
 * sessions' reviews were both running on it — and from then on they are
 * separate settings: changing one never touches the other, and neither reads
 * the other when it is missing (a missing role gets the shipped default and
 * is reported, never the sibling's value). The legacy key is removed once
 * both exist, so nothing can keep reading it.
 */
export function migrateReviewerSplit(): void {
  const stored = kvGet<any>('settings');
  if (!stored?.roles) return;
  const legacy = stored.roles.reviewer;
  let changed = false;
  if (!stored.roles.builder_reviewer) { stored.roles.builder_reviewer = structuredClone(legacy ?? DEFAULT_SETTINGS.roles.builder_reviewer); changed = true; }
  if (!stored.roles.director_reviewer) {
    const { enabled: _enabled, ...rest } = structuredClone(legacy ?? DEFAULT_SETTINGS.roles.director_reviewer) as any;
    stored.roles.director_reviewer = rest; changed = true;
  }
  if (legacy) { delete stored.roles.reviewer; changed = true; }
  if (changed) {
    kvSet('settings', stored);
    console.log(`[tandem] settings: Reviewer split into Builder Reviewer (${stored.roles.builder_reviewer.provider}/${stored.roles.builder_reviewer.model}) `
      + `and Director Reviewer (${stored.roles.director_reviewer.provider}/${stored.roles.director_reviewer.model}); they are independent from here on`);
  }
}
const PROVIDER_DEFAULT_MODEL: Record<Provider, string> = { 'claude-code': 'claude-opus-5', codex: 'gpt-5.6-sol' };

/**
 * Stored role configuration, read back coherently.
 *
 * Every role carries its own provider. An unknown or missing provider becomes
 * the role's historical one — settings written before providers were
 * selectable resolve to exactly what they did before — and a model that
 * plainly belongs to a different backend is replaced by this one's default,
 * so no reader ever sees "Codex, running claude-opus-5". Rejecting such a pair
 * on the way IN is validateRoleConfigs; this is the safety net on the way out.
 */
function normalizeProviders(s: AppSettings): void {
  for (const role of ['builder', 'builder_reviewer', 'director_reviewer'] as const) {
    const r = s.roles[role];
    r.provider = canonicalProvider(r.provider) ?? LEGACY[role];
    const owner = providerOfModel(r.model ?? '');
    if (!r.model?.trim() || (owner && owner !== r.provider)) r.model = PROVIDER_DEFAULT_MODEL[r.provider];
  }
  if (s.roles.director) {
    const d = s.roles.director;
    d.provider = canonicalProvider(d.provider) ?? LEGACY.director;
    const owner = providerOfModel(d.model ?? '');
    if (owner && owner !== d.provider) d.model = '';
  }
  // a tier is either a complete, coherent configuration or nothing at all —
  // never half a tier that would resolve to "Codex, running claude-opus-5"
  for (const level of DIFFICULTIES) {
    const tier = (s.difficulty as any)[level] ?? (s.difficulty[level] = { builder: null, reviewer: null });
    for (const slot of ['builder', 'reviewer'] as const) {
      const t = tier[slot];
      if (!t || typeof t !== 'object') { tier[slot] = null; continue; }
      const provider = canonicalProvider(t.provider);
      const model = typeof t.model === 'string' ? t.model.trim() : '';
      const owner = model ? providerOfModel(model) : null;
      if (!provider || !model || (owner && owner !== provider) || !['low', 'medium', 'high'].includes(t.effort)) { tier[slot] = null; continue; }
      tier[slot] = { provider, model, effort: t.effort };
    }
  }
  const img = s.imageGeneration;
  if (img.provider !== 'codex' && img.provider !== 'openai') img.provider = 'codex';
  img.model = typeof img.model === 'string' ? img.model.trim() : '';
  if (img.provider === 'openai' && !img.model) img.model = 'gpt-image-2';
  // a chat model is not an image model and vice versa: switching provider keeps neither
  if (img.provider === 'codex' && /^(gpt-image|dall-e)/i.test(img.model)) img.model = '';
  if (img.provider === 'openai' && !/^(gpt-image|dall-e)/i.test(img.model)) img.model = 'gpt-image-2';
  if (!['auto', 'low', 'medium', 'high'].includes(img.quality)) img.quality = 'auto';
  img.enabled = img.enabled !== false;
  if (typeof img.credentialId !== 'string' || !img.credentialId) img.credentialId = null;
  const v = s.video;
  v.engineIntegration = typeof v.engineIntegration === 'string' && v.engineIntegration.trim() ? v.engineIntegration.trim() : 'animation_engine';
  const list = (x: unknown, fallback: string[]) => Array.isArray(x) ? x.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 100) : fallback;
  v.timingTools = list(v.timingTools, DEFAULT_SETTINGS.video.timingTools);
  v.reviewerEngineTools = list(v.reviewerEngineTools, DEFAULT_SETTINGS.video.reviewerEngineTools);
  v.paidToolPatterns = list(v.paidToolPatterns, DEFAULT_SETTINGS.video.paidToolPatterns);
  v.ttsToolPatterns = list(v.ttsToolPatterns, DEFAULT_SETTINGS.video.ttsToolPatterns);
  const money = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, 1000) : fallback);
  const r = v.rates ?? structuredClone(DEFAULT_SETTINGS.video.rates);
  v.rates = {
    imageUsd: {
      codex: money(r.imageUsd?.codex, DEFAULT_SETTINGS.video.rates.imageUsd.codex),
      openai: money(r.imageUsd?.openai, DEFAULT_SETTINGS.video.rates.imageUsd.openai),
    },
    ttsUsdPer1kChars: money(r.ttsUsdPer1kChars, DEFAULT_SETTINGS.video.rates.ttsUsdPer1kChars),
    otherPaidUsd: money(r.otherPaidUsd, DEFAULT_SETTINGS.video.rates.otherPaidUsd),
  };
  const o = s.orchestration;
  o.stallAfterMinutes = clamp(o.stallAfterMinutes, 2, 24 * 60);
  o.stallMaxWakes = clamp(o.stallMaxWakes, 1, 50);
}

/**
 * Refuse a role configuration that cannot run: an unregistered provider, or a
 * model that belongs to another backend. Returns the first problem, or null.
 */
export function validateRoleConfigs(patch: Partial<AppSettings>): string | null {
  const roles = patch.roles ?? {};
  for (const role of ['builder', 'builder_reviewer', 'director_reviewer', 'director'] as const) {
    const r = (roles as any)[role] as { provider?: unknown; model?: unknown } | undefined;
    if (!r) continue;
    const p = r.provider === undefined ? null : canonicalProvider(r.provider);
    if (r.provider !== undefined && !p) return `Unknown AI provider "${String(r.provider)}" for the ${role} role.`;
    const provider = p ?? canonicalProvider(getSettings().roles[role]?.provider) ?? LEGACY[role];
    const model = typeof r.model === 'string' ? r.model.trim() : '';
    const owner = model ? providerOfModel(model) : null;
    if (owner && owner !== provider) return `"${model}" is not a model the ${role}'s provider (${provider}) can run.`;
  }
  // difficulty tiers: a configured slot must be a complete, coherent pair
  const tiers = (patch as any).difficulty as Record<string, any> | undefined;
  if (tiers && typeof tiers === 'object') {
    for (const level of Object.keys(tiers)) {
      if (!DIFFICULTIES.includes(level as Difficulty)) return `Unknown difficulty level "${level}".`;
      for (const slot of ['builder', 'reviewer'] as const) {
        const t = tiers[level]?.[slot];
        if (t == null) continue;
        const p = canonicalProvider(t.provider);
        if (!p) return `Unknown AI provider "${String(t.provider)}" for the ${level} ${slot} tier.`;
        const model = typeof t.model === 'string' ? t.model.trim() : '';
        if (!model) return `The ${level} ${slot} tier needs a model (or clear it to inherit).`;
        const owner = providerOfModel(model);
        if (owner && owner !== p) return `"${model}" is not a model the ${level} ${slot} tier's provider (${p}) can run.`;
      }
    }
  }
  return null;
}

/** Configuration for the removed Compactor role no longer affects runtime — drop it. */
function stripObsolete(s: AppSettings): void {
  delete (s.roles as any).compactor;
  delete s.roles.reviewer; // split into builder_reviewer / director_reviewer
  for (const key of Object.keys(s.context)) {
    if (!(key in DEFAULT_SETTINGS.context)) delete (s.context as any)[key];
  }
}

export function putSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = getSettings();
  deepMerge(merged as any, patch as any);
  stripObsolete(merged);
  normalizeProviders(merged);
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
