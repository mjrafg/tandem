/**
 * Role configuration → provider, model, effort.
 *
 * Every role resolves the same way and resolves independently. The Director
 * does not inherit the Builder's provider, the Reviewer does not inherit
 * anyone's, and nothing infers a provider from a model name — a chain like
 * that is exactly what made "change the Builder to Codex" quietly move the
 * orchestrator too.
 */
import type { AppSettings, Difficulty, Effort, ModelSource, Provider } from '../../../shared/types';
import { builderExecFor } from '../agents/exec';
import { getReviewerSnapshot } from '../agents/store';
import { DIFFICULTY_ROUTING_ENABLED } from '../../../shared/features';
import { asDifficulty, db } from '../db';
import { providerOfModel } from './catalog';
import { canonicalProvider, providerRegistry } from './registry';

export interface ResolvedRole {
  provider: Provider;
  model: string;
  effort: Effort;
  /** the specialist overlay from a session's Agent snapshot, when it has one */
  agentPrompt?: string;
  /** the session's difficulty at resolution time, when it has one */
  difficulty?: Difficulty;
  /** which configuration decided the model */
  source: ModelSource;
}

/**
 * The CURRENT difficulty of the session a chat belongs to, or null for a chat
 * that is not a Director session (ordinary chats have no difficulty and run on
 * the role defaults). Read at every resolution, never cached: the Director may
 * change it while the session is running, and the next request must follow.
 */
export function sessionDifficulty(chatId: string | undefined): Difficulty | null {
  // Archived: no difficulty is consulted, so no tier can be selected and no new
  // record is attributed to one. Values already stored stay exactly as they are
  // (see shared/features.ts).
  if (!DIFFICULTY_ROUTING_ENABLED) return null;
  if (!chatId) return null;
  // a Director-owned session: the Director's judgement on the session row
  try {
    const r = db.prepare('SELECT difficulty FROM pd_sessions WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1').get(chatId) as { difficulty?: string } | undefined;
    const d = asDifficulty(r?.difficulty);
    if (d) return d;
  } catch {
    /* the table is created by the Director store; before it exists there are no sessions */
  }
  // a standalone chat: whatever the user picked in the Composer, if anything
  const c = db.prepare('SELECT difficulty FROM chats WHERE id = ?').get(chatId) as { difficulty?: string } | undefined;
  return asDifficulty(c?.difficulty);
}

/** the configured tier for a role at a difficulty, or null when the tier inherits */
function tierFor(settings: AppSettings, difficulty: Difficulty | null, slot: 'builder' | 'reviewer') {
  if (!difficulty) return null;
  const t = settings.difficulty?.[difficulty]?.[slot];
  return t && t.model ? t : null;
}

/** The provider Tandem used before roles could choose one. */
export const LEGACY_PROVIDER: Record<'builder' | 'builder_reviewer' | 'director_reviewer' | 'director', Provider> = {
  builder: 'claude-code',
  builder_reviewer: 'codex',
  director_reviewer: 'codex',
  director: 'claude-code',
};

function fallbackModel(provider: Provider): string {
  return providerRegistry.get(provider).descriptor.defaultModel;
}

/**
 * A stored configuration read back safely: an unknown provider becomes the
 * role's historical one rather than a crash, and a model that plainly belongs
 * to a different backend is replaced by this one's default. Settings written
 * before providers were selectable resolve to exactly what they did before.
 */
function coerce(
  role: 'builder' | 'builder_reviewer' | 'director_reviewer' | 'director',
  provider: unknown,
  model: unknown,
  effort: Effort,
  source: ModelSource = 'role',
): ResolvedRole {
  const resolved = canonicalProvider(provider) ?? LEGACY_PROVIDER[role];
  const p = providerRegistry.has(resolved) ? resolved : LEGACY_PROVIDER[role];
  const wanted = typeof model === 'string' ? model.trim() : '';
  const belongsTo = providerOfModel(wanted);
  const m = wanted && (belongsTo === null || belongsTo === p) ? wanted : fallbackModel(p);
  return { provider: p, model: m, effort, source };
}

/**
 * The Builder for a chat, resolved for THIS request.
 *
/**
 * Precedence: an Agent that PINS its model (enforceModel) → the session's
 * difficulty tier, when one is configured → the Builder role default.
 *
 * An Agent that does not pin its model contributes its instructions only, and
 * the model comes from the ordinary configuration. That is what makes the
 * Builder role setting reach project sessions at all: without it every session
 * carries an Agent, and an Agent always won.
 *
 * The specialist PROMPT overlay always comes from the snapshot — that is the
 * session's identity. The MODEL follows the latest applicable configuration, so
 * for a session whose Agent does not pin one, changing the Builder role reaches
 * the very next request, even mid-session.
 */
export function resolveBuilderRole(settings: AppSettings, chatId?: string): ResolvedRole {
  // a snapshot only counts as an Agent when the chat has one; without it
  // builderExecFor echoes the role values, and the source is the role
  const exec = chatId ? builderExecFor(chatId, settings) : null;
  const agent = exec?.agentName ? exec : null;
  // only an Agent that pins its model decides the model; the rest is ordinary
  const pinned = agent?.enforceModel ? agent : null;
  const difficulty = sessionDifficulty(chatId);
  const tier = pinned ? null : tierFor(settings, difficulty, 'builder');
  const b = settings.roles.builder;
  const base = pinned
    ? coerce('builder', pinned.provider ?? b.provider, pinned.model ?? b.model, pinned.effort ?? b.effort, 'agent')
    : tier
      ? coerce('builder', tier.provider, tier.model, tier.effort, 'difficulty')
      : coerce('builder', b.provider, b.model, b.effort, 'role');
  return {
    ...base,
    ...(agent?.agentPrompt ? { agentPrompt: agent.agentPrompt } : {}),
    ...(difficulty ? { difficulty } : {}),
  };
}

/**
 * The Builder Reviewer: reviews session output, runs the two-round loop.
 * Follows the session's difficulty tier when one is configured, else the role.
 */
export function resolveBuilderReviewerRole(settings: AppSettings, chatId?: string): ResolvedRole {
  const difficulty = sessionDifficulty(chatId);
  // a session's Reviewer Agent: its prompt always, its model only when it pins one
  const agent = chatId ? getReviewerSnapshot(chatId) : null;
  const pinned = agent?.enforceModel ? agent : null;
  const tier = pinned ? null : tierFor(settings, difficulty, 'reviewer');
  const r = settings.roles.builder_reviewer;
  const base = pinned
    ? coerce('builder_reviewer', pinned.provider, pinned.model, pinned.effort, 'agent')
    : tier
      ? coerce('builder_reviewer', tier.provider, tier.model, tier.effort, 'difficulty')
      : coerce('builder_reviewer', r.provider, r.model, r.effort, 'role');
  return { ...base, ...(agent ? { agentPrompt: agent.systemPrompt } : {}), ...(difficulty ? { difficulty } : {}) };
}

/**
 * The Director Reviewer: independently reviews Director-level decisions.
 *
 * Strict on purpose. A misconfigured Director Reviewer is reported as exactly
 * that — it never quietly runs on the Builder Reviewer's configuration (the
 * roles are independent) and never quietly runs on a default the operator did
 * not choose. The caller records the problem and the Director learns the
 * review did not happen.
 */
export function resolveDirectorReviewerRole(settings: AppSettings): { ok: true; role: ResolvedRole } | { ok: false; error: string } {
  const r = settings.roles.director_reviewer;
  if (!r) return { ok: false, error: 'No Director Reviewer is configured (Settings → Roles → Director Reviewer).' };
  const v = validateProviderModel(r.provider, r.model);
  if (!v.ok) return { ok: false, error: `Director Reviewer configuration problem: ${v.error}` };
  return { ok: true, role: { provider: v.provider, model: v.model, effort: r.effort, source: 'role' } };
}

/**
 * The Director's own configuration.
 *
 * An empty model still follows the Builder's — but only when both roles run on
 * the same backend, because a model name is meaningless to another one. With
 * different backends the Director uses its provider's default instead.
 */
export function resolveDirectorRoleConfig(settings: AppSettings): ResolvedRole {
  const d = settings.roles.director;
  const b = settings.roles.builder;
  const provider = canonicalProvider(d?.provider) ?? LEGACY_PROVIDER.director;
  const inherited = canonicalProvider(b.provider) === provider ? b.model : '';
  return coerce('director', provider, d?.model?.trim() || inherited, d?.effort ?? b.effort);
}

/**
 * Is this provider/model pair acceptable to store?
 *
 * Refuses an unregistered provider, and a model that belongs to a different
 * registered provider. It does not refuse an unfamiliar name: the catalog lists
 * the models Tandem knows about, and models ship faster than catalogs.
 */
export function validateProviderModel(provider: unknown, model: unknown): { ok: true; provider: Provider; model: string } | { ok: false; error: string } {
  const p = canonicalProvider(provider);
  if (!p || !providerRegistry.has(p)) {
    return { ok: false, error: `Unknown AI provider "${String(provider)}". Registered: ${providerRegistry.ids().join(', ')}.` };
  }
  const m = typeof model === 'string' ? model.trim() : '';
  if (!m) return { ok: false, error: 'A model is required.' };
  const owner = providerOfModel(m);
  if (owner && owner !== p) {
    const here = providerRegistry.get(p).descriptor.label;
    const there = providerRegistry.get(owner).descriptor.label;
    return { ok: false, error: `"${m}" is a ${there} model; ${here} cannot run it.` };
  }
  return { ok: true, provider: p, model: m };
}
