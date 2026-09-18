/**
 * Builder Agent profiles — persisted configuration, not engine concepts.
 *
 * A profile specializes Builder behavior through three values: a system-prompt
 * OVERLAY, a model and a reasoning effort. Nothing here knows what "ui" or
 * "qa" means: the four initial agents are simply the first four rows, and a new
 * specialist is a new row created through the same Admin API — no enum, no
 * switch, no engine change, no redeploy.
 *
 * Two identities matter and must not be confused:
 *   - `id` is the stable immutable identity used by the Director, by session
 *     snapshots and by every historical reference.
 *   - `slug` is a readable handle for the catalog and UI, and is mutable.
 *
 * Provider is persisted for a future in which Builder execution is genuinely
 * provider-neutral; in V1 the server pins every profile to 'claude-code' (see
 * settings.ts lockProviders for the same rule at the role level).
 */
import { randomUUID } from 'node:crypto';
import type { AgentProfile, AgentSnapshot, Effort, Provider } from '../../../shared/types';
import { EFFORTS, MAX_AGENT_PROMPT_CHARS } from '../../../shared/types';
import { db, kvGet, kvSet } from '../db';
import { SEED_AGENTS } from './seeds';

/** V1: Builder execution is Claude Code only — the server, not the UI, enforces it. */
export const BUILDER_PROVIDER: Provider = 'claude-code';
import { providerOfModel } from '../providers/catalog';
import { PROVIDER_IDS, canonicalProvider } from '../providers/ids';

/**
 * The specialist prompt is delivered as ONE argv element
 * (`--append-system-prompt <text>`), and Linux caps a single argument at
 * MAX_ARG_STRLEN (128 KB). A prompt accepted here but rejected by the kernel
 * at spawn time would be frozen into a session's snapshot and make that
 * session permanently unrunnable, so the limit is enforced at write time with
 * room to spare for the engine's own instructions.
 */
export const MAX_PROMPT_CHARS = MAX_AGENT_PROMPT_CHARS;

db.exec(`
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude-code',
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_slug_active
  ON agent_profiles(slug) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS chat_agent_snapshots (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id),
  profile_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  profile_slug TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  profile_updated_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL
);
`);

function rowToProfile(r: any): AgentProfile {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description ?? '',
    systemPrompt: r.system_prompt, provider: r.provider as Provider,
    model: r.model, effort: r.effort as Effort,
    enabled: !!r.enabled, isDefault: !!r.is_default,
    createdAt: r.created_at, updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null,
  };
}

// ---------------------------------------------------------------- validation

export class AgentError extends Error {}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Model names are FREE TEXT on purpose: providers ship new models constantly,
 * and requiring a code change (or a Tandem release) before an admin can use one
 * would make the agent system data-driven in name only. CLAUDE_MODELS remains
 * the suggestion list in the UI, not an allow-list. Validation is limited to
 * what the runtime actually needs — a single-line, argv-safe, bounded token —
 * so a typo surfaces as the CLI's own "model not found" error rather than being
 * silently swapped for something else.
 */
export function validateModel(model: unknown): string {
  if (model !== undefined && model !== null && typeof model !== 'string') throw new AgentError('Model must be text.');
  const m = String(model ?? '').trim();
  if (!m) throw new AgentError('Model is required.');
  if (m.length > 100) throw new AgentError('Model names are limited to 100 characters.');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(m)) throw new AgentError('A model name cannot contain spaces or control characters.');
  return m;
}

export function validateEffort(effort: unknown): Effort {
  if (effort !== undefined && effort !== null && typeof effort !== 'string') throw new AgentError('Reasoning effort must be text.');
  const e = String(effort ?? '').trim() as Effort;
  if (!EFFORTS.includes(e)) throw new AgentError(`Unsupported reasoning effort "${effort}". Supported: ${EFFORTS.join(', ')}.`);
  return e;
}

function validateProvider(provider: unknown): Provider {
  // absent = the historical default; anything present must be a registered id
  if (provider === undefined || provider === null || provider === '') return BUILDER_PROVIDER;
  const p = canonicalProvider(provider);
  if (!p) throw new AgentError(`Unknown AI provider "${String(provider)}". Registered providers: ${PROVIDER_IDS.join(', ')}.`);
  return p;
}

/** a model that plainly belongs to another backend cannot run on this one */
function validatePair(provider: Provider, model: string): void {
  const owner = providerOfModel(model);
  if (owner && owner !== provider) throw new AgentError(`"${model}" is not a model the ${provider} provider can run.`);
}

function validateSlug(slug: unknown, exceptId?: string): string {
  if (slug !== undefined && slug !== null && typeof slug !== 'string') throw new AgentError('Slug must be text.');
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    throw new AgentError('Slug must be 1–40 characters: lowercase letters, digits and hyphens, starting with a letter or digit.');
  }
  const clash = db.prepare('SELECT id FROM agent_profiles WHERE slug = ? AND archived_at IS NULL AND id != ?')
    .get(s, exceptId ?? '') as any;
  if (clash) throw new AgentError(`Another active agent already uses the slug "${s}".`);
  return s;
}

function requireText(value: unknown, field: string, max: number): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AgentError(`${field} must be text.`);
  }
  const v = String(value ?? '').trim();
  if (!v) throw new AgentError(`${field} is required.`);
  if (v.length > max) throw new AgentError(`${field} is limited to ${max} characters.`);
  return v;
}

// ------------------------------------------------------------------- reading

export function listAgents(opts: { includeArchived?: boolean } = {}): AgentProfile[] {
  const sql = opts.includeArchived
    ? 'SELECT * FROM agent_profiles ORDER BY is_default DESC, enabled DESC, name'
    : 'SELECT * FROM agent_profiles WHERE archived_at IS NULL ORDER BY is_default DESC, enabled DESC, name';
  return (db.prepare(sql).all() as any[]).map(rowToProfile);
}

export function getAgent(id: string): AgentProfile | null {
  const r = db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as any;
  return r ? rowToProfile(r) : null;
}

/** Profiles the Director may choose from: enabled and not archived. */
export function selectableAgents(): AgentProfile[] {
  return (db.prepare('SELECT * FROM agent_profiles WHERE archived_at IS NULL AND enabled = 1 ORDER BY is_default DESC, name').all() as any[])
    .map(rowToProfile);
}

export function defaultAgent(): AgentProfile | null {
  const r = db.prepare('SELECT * FROM agent_profiles WHERE is_default = 1 AND enabled = 1 AND archived_at IS NULL').get() as any;
  return r ? rowToProfile(r) : null;
}

// ------------------------------------------------------------------- writing

export interface AgentInput {
  slug?: string; name?: string; description?: string; systemPrompt?: string;
  provider?: unknown; model?: string; effort?: string; enabled?: boolean; isDefault?: boolean;
}

export function createAgent(input: AgentInput): AgentProfile {
  const now = Date.now();
  const id = `ap_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const row = {
    id,
    slug: validateSlug(input.slug ?? ''),
    name: requireText(input.name, 'Name', 80),
    description: String(input.description ?? '').trim().slice(0, 600),
    systemPrompt: requireText(input.systemPrompt, 'System prompt', MAX_PROMPT_CHARS),
    provider: validateProvider(input.provider),
    model: validateModel(input.model ?? ''),
    effort: validateEffort(input.effort ?? ''),
    enabled: input.enabled !== false,
  };
  validatePair(row.provider, row.model);
  const makeDefault = !!input.isDefault;
  if (makeDefault && !row.enabled) throw new AgentError('The default agent must be enabled.');
  db.transaction(() => {
    db.prepare(`INSERT INTO agent_profiles (id, slug, name, description, system_prompt, provider, model, effort, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(row.id, row.slug, row.name, row.description, row.systemPrompt, row.provider, row.model, row.effort, row.enabled ? 1 : 0, now, now);
    if (makeDefault || !db.prepare('SELECT id FROM agent_profiles WHERE is_default = 1').get()) promoteDefault(id);
  })();
  return getAgent(id)!;
}

export function updateAgent(id: string, input: AgentInput): AgentProfile {
  const current = getAgent(id);
  if (!current) throw new AgentError('Agent profile not found.');
  if (current.archivedAt) throw new AgentError('This agent is archived — restore it before editing.');
  const next = {
    slug: input.slug !== undefined ? validateSlug(input.slug, id) : current.slug,
    name: input.name !== undefined ? requireText(input.name, 'Name', 80) : current.name,
    description: input.description !== undefined ? String(input.description).trim().slice(0, 600) : current.description,
    systemPrompt: input.systemPrompt !== undefined ? requireText(input.systemPrompt, 'System prompt', MAX_PROMPT_CHARS) : current.systemPrompt,
    provider: input.provider !== undefined ? validateProvider(input.provider) : current.provider,
    model: input.model !== undefined ? validateModel(input.model) : current.model,
    effort: input.effort !== undefined ? validateEffort(input.effort) : current.effort,
    enabled: input.enabled !== undefined ? !!input.enabled : current.enabled,
  };
  validatePair(next.provider, next.model);
  const wantsDefault = input.isDefault === true;
  if (current.isDefault && !next.enabled && !wantsDefault) {
    throw new AgentError('This agent is the default — make another enabled agent the default before disabling it.');
  }
  if (wantsDefault && !next.enabled) throw new AgentError('The default agent must be enabled.');
  db.transaction(() => {
    db.prepare(`UPDATE agent_profiles SET slug = ?, name = ?, description = ?, system_prompt = ?, provider = ?, model = ?, effort = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .run(next.slug, next.name, next.description, next.systemPrompt, next.provider, next.model, next.effort, next.enabled ? 1 : 0, Date.now(), id);
    if (wantsDefault) promoteDefault(id);
  })();
  return getAgent(id)!;
}

/** Atomic default transition — exactly one enabled, non-archived default exists. */
export function setDefaultAgent(id: string): AgentProfile {
  const target = getAgent(id);
  if (!target) throw new AgentError('Agent profile not found.');
  if (target.archivedAt) throw new AgentError('An archived agent cannot be the default.');
  if (!target.enabled) throw new AgentError('The default agent must be enabled — enable it first.');
  db.transaction(() => promoteDefault(id))();
  return getAgent(id)!;
}

/** Inside a transaction: clear every other default, set this one. */
function promoteDefault(id: string): void {
  db.prepare('UPDATE agent_profiles SET is_default = 0 WHERE is_default = 1 AND id != ?').run(id);
  db.prepare('UPDATE agent_profiles SET is_default = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Soft delete. Sessions keep their snapshots, so history stays intact and
 * readable; the profile simply leaves the Director's catalog and can no longer
 * be selected. The only restriction is the generic default invariant.
 */
export function archiveAgent(id: string): AgentProfile {
  const target = getAgent(id);
  if (!target) throw new AgentError('Agent profile not found.');
  if (target.archivedAt) return target;
  if (target.isDefault) {
    throw new AgentError('This agent is the current default — make another enabled agent the default before archiving it.');
  }
  db.prepare('UPDATE agent_profiles SET archived_at = ?, enabled = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), id);
  return getAgent(id)!;
}

export function restoreAgent(id: string): AgentProfile {
  const target = getAgent(id);
  if (!target) throw new AgentError('Agent profile not found.');
  if (!target.archivedAt) return target;
  validateSlug(target.slug, id); // the slug may have been taken while archived
  db.prepare('UPDATE agent_profiles SET archived_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id);
  return getAgent(id)!;
}

// --------------------------------------------------------------- resolution

/**
 * Resolve a Director-selected profile for execution. An explicitly supplied id
 * is never silently swapped: an unknown, archived, disabled or misconfigured
 * profile is an error the Director must see. The default is used ONLY when no
 * selection was made at all (a plan that omitted the field, or a pre-Agent
 * session), which is the documented backward-compatible fallback.
 */
export function resolveAgentForLaunch(profileId: string | null | undefined): AgentProfile {
  if (profileId) {
    const p = getAgent(profileId);
    if (!p) throw new AgentError(`Unknown Builder Agent profile "${profileId}" — choose one from the agent catalog.`);
    if (p.archivedAt) throw new AgentError(`Builder Agent "${p.name}" is archived and can no longer be selected.`);
    if (!p.enabled) throw new AgentError(`Builder Agent "${p.name}" is disabled and can no longer be selected.`);
    validateModel(p.model);
    validateEffort(p.effort);
    if (!canonicalProvider(p.provider)) throw new AgentError(`Builder Agent "${p.name}" is configured for an unknown provider "${p.provider}".`);
    validatePair(p.provider, p.model);
    return p;
  }
  const d = defaultAgent();
  if (!d) throw new AgentError('No enabled default Builder Agent exists — set one in Settings → Builder Agents.');
  return d;
}

// ----------------------------------------------------------------- snapshots

/**
 * Capture the immutable execution configuration for a chat, ONCE. Every later
 * Builder turn on that chat (continuation, repair, final repair, review retry,
 * post-restart resume) reads this snapshot — never the mutable profile — so an
 * admin editing the template can never change what a running session executes.
 */
export function captureAgentSnapshot(chatId: string, profile: AgentProfile): AgentSnapshot {
  const existing = getAgentSnapshot(chatId);
  if (existing) return existing;
  const now = Date.now();
  db.prepare(`INSERT INTO chat_agent_snapshots (chat_id, profile_id, profile_name, profile_slug, provider, model, effort, system_prompt, profile_updated_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(chatId, profile.id, profile.name, profile.slug, profile.provider, profile.model, profile.effort, profile.systemPrompt, profile.updatedAt, now);
  return getAgentSnapshot(chatId)!;
}

export function getAgentSnapshot(chatId: string): AgentSnapshot | null {
  const r = db.prepare('SELECT * FROM chat_agent_snapshots WHERE chat_id = ?').get(chatId) as any;
  if (!r) return null;
  return {
    profileId: r.profile_id, profileName: r.profile_name, profileSlug: r.profile_slug,
    provider: r.provider as Provider, model: r.model, effort: r.effort as Effort,
    systemPrompt: r.system_prompt, profileUpdatedAt: r.profile_updated_at, capturedAt: r.captured_at,
  };
}

export function deleteAgentSnapshot(chatId: string): void {
  db.prepare('DELETE FROM chat_agent_snapshots WHERE chat_id = ?').run(chatId);
}

// ------------------------------------------------------------ export / import

export interface AgentsExport {
  app: 'tandem';
  kind: 'agent-profiles';
  version: 1;
  exportedAt: number;
  agents: {
    slug: string; name: string; description: string; systemPrompt: string;
    provider: Provider; model: string; effort: Effort; enabled: boolean; isDefault: boolean;
  }[];
}

/**
 * A portable snapshot. Ids are deliberately omitted: they are THIS instance's
 * identities, and a session snapshot elsewhere must never be re-pointed by an
 * import. Slug is the portable handle.
 */
export function exportAgents(includeArchived = false): AgentsExport {
  return {
    app: 'tandem',
    kind: 'agent-profiles',
    version: 1,
    exportedAt: Date.now(),
    agents: listAgents({ includeArchived }).map((a) => ({
      slug: a.slug, name: a.name, description: a.description, systemPrompt: a.systemPrompt,
      provider: a.provider, model: a.model, effort: a.effort, enabled: a.enabled, isDefault: a.isDefault,
    })),
  };
}

export interface AgentsImportResult {
  created: string[];
  updated: string[];
  skipped: { slug: string; reason: string }[];
  defaultChanged: string | null;
}

/**
 * Import by SLUG: an existing active profile with that slug is updated in
 * place (keeping its id, so history and every session snapshot stay intact),
 * anything else is created. One bad entry is skipped with a reason rather than
 * failing the batch, and the "exactly one enabled default" invariant is
 * re-established through the same transactional path the API uses.
 */
export function importAgents(data: unknown): AgentsImportResult {
  const raw = data && typeof data === 'object' && !Array.isArray(data)
    ? (Array.isArray((data as any).agents) ? (data as any).agents : null)
    : Array.isArray(data) ? data : null;
  if (!raw) throw new Error('Expected a JSON object with an "agents" array (the exported format), or a plain array of agents.');
  if (raw.length > 200) throw new Error('Too many agents in the file (limit 200).');

  const result: AgentsImportResult = { created: [], updated: [], skipped: [], defaultChanged: null };
  let wantsDefault: string | null = null;

  for (const entry of raw as any[]) {
    const slug = String(entry?.slug ?? '').trim().toLowerCase();
    try {
      if (!entry || typeof entry !== 'object') throw new AgentError('Not an object.');
      const input: AgentInput = {
        slug,
        name: entry.name,
        description: entry.description,
        systemPrompt: entry.systemPrompt ?? entry.system_prompt,
        provider: entry.provider,
        model: entry.model,
        effort: entry.effort,
        enabled: entry.enabled !== false,
      };
      const existing = db.prepare('SELECT id FROM agent_profiles WHERE slug = ? AND archived_at IS NULL').get(slug) as any;
      if (existing) {
        updateAgent(existing.id, input);
        result.updated.push(slug);
      } else {
        createAgent(input);
        result.created.push(slug);
      }
      if (entry.isDefault === true || entry.is_default === true) wantsDefault = slug;
    } catch (err) {
      result.skipped.push({ slug: slug || '(no slug)', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (wantsDefault) {
    const row = db.prepare('SELECT id, enabled FROM agent_profiles WHERE slug = ? AND archived_at IS NULL').get(wantsDefault) as any;
    if (row?.enabled) {
      setDefaultAgent(row.id);
      result.defaultChanged = wantsDefault;
    }
  }
  return result;
}

// --------------------------------------------------------------------- seeds

/**
 * Initial data, once per installation. Seeds are NOT a boot-time source of
 * truth: the marker means an admin who edits — or deletes — a seeded agent
 * keeps that decision across restarts instead of having it overwritten.
 */
export function seedAgents(): void {
  if (kvGet<boolean>('agent_profiles_seeded')) return;
  const existing = db.prepare('SELECT COUNT(*) c FROM agent_profiles').get() as any;
  if (existing.c === 0) {
    db.transaction(() => {
      for (const seed of SEED_AGENTS) {
        createAgent({
          slug: seed.slug, name: seed.name, description: seed.description,
          systemPrompt: seed.systemPrompt, provider: BUILDER_PROVIDER,
          model: seed.model, effort: seed.effort, enabled: true, isDefault: seed.isDefault,
        });
      }
    })();
    console.log(`[tandem] seeded ${SEED_AGENTS.length} Builder Agent profiles`);
  }
  kvSet('agent_profiles_seeded', true);
}
