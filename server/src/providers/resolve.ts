/**
 * Role configuration → provider, model, effort.
 *
 * Every role resolves the same way and resolves independently. The Director
 * does not inherit the Builder's provider, the Reviewer does not inherit
 * anyone's, and nothing infers a provider from a model name — a chain like
 * that is exactly what made "change the Builder to Codex" quietly move the
 * orchestrator too.
 */
import type { AppSettings, Effort, Provider } from '../../../shared/types';
import { builderExecFor } from '../agents/exec';
import { providerOfModel } from './catalog';
import { canonicalProvider, providerRegistry } from './registry';

export interface ResolvedRole {
  provider: Provider;
  model: string;
  effort: Effort;
  /** the specialist overlay from a session's Agent snapshot, when it has one */
  agentPrompt?: string;
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
): ResolvedRole {
  const resolved = canonicalProvider(provider) ?? LEGACY_PROVIDER[role];
  const p = providerRegistry.has(resolved) ? resolved : LEGACY_PROVIDER[role];
  const wanted = typeof model === 'string' ? model.trim() : '';
  const belongsTo = providerOfModel(wanted);
  const m = wanted && (belongsTo === null || belongsTo === p) ? wanted : fallbackModel(p);
  return { provider: p, model: m, effort };
}

export function resolveBuilderRole(settings: AppSettings, chatId?: string): ResolvedRole {
  // a Director session runs on its immutable Agent snapshot — the profile row
  // may change mid-session, what the session executes with may not
  const agent = chatId ? builderExecFor(chatId, settings) : null;
  const b = settings.roles.builder;
  return {
    ...coerce('builder', agent?.provider ?? b.provider, agent?.model ?? b.model, agent?.effort ?? b.effort),
    ...(agent?.agentPrompt ? { agentPrompt: agent.agentPrompt } : {}),
  };
}

/** The Builder Reviewer: reviews session output, runs the two-round loop. */
export function resolveBuilderReviewerRole(settings: AppSettings): ResolvedRole {
  const r = settings.roles.builder_reviewer;
  return coerce('builder_reviewer', r.provider, r.model, r.effort);
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
  return { ok: true, role: { provider: v.provider, model: v.model, effort: r.effort } };
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
