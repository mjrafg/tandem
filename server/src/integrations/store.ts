import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IntegrationOAuthStatus,
  CredentialMeta, CredentialType, Integration, IntegrationTool, IntegrationToolSpec, IntegrationType, RoleName,
} from '../../../shared/types';
import { config } from '../config';
import { db } from '../db';

/**
 * Persistence for the no-code integration system. Credential secret material
 * is encrypted at rest (AES-256-GCM, key file owned by the service user) and
 * is NEVER returned by any API — the execution layer decrypts it in-process
 * at call time only.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  credential_id TEXT,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_test_at INTEGER,
  last_test_ok INTEGER,
  last_test_error TEXT
);
CREATE TABLE IF NOT EXISTS integration_tools (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  default_description TEXT NOT NULL DEFAULT '',
  params_schema TEXT NOT NULL,
  spec TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  roles TEXT NOT NULL DEFAULT '["builder"]',
  missing INTEGER NOT NULL DEFAULT 0
);
`);

// ---------------------------------------------------------------- encryption

function secretKey(): Buffer {
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

export function encryptSecret(obj: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(blob: string): Record<string, string> {
  const [iv, tag, ct] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}

// ---------------------------------------------------------------- credentials

const CRED_FIELDS: Record<CredentialType, string[]> = {
  bearer_token: ['token'],
  api_key_header: ['header', 'value'],
  basic_auth: ['username', 'password'],
  header_set: ['headersJson'],
  env_set: ['envJson'],
  ssh_private_key: ['privateKey'],
  oauth: [],
};

export function credentialFields(type: CredentialType): string[] {
  return CRED_FIELDS[type] ?? [];
}

function rowToCredMeta(row: any): CredentialMeta {
  const usedBy = db.prepare('SELECT name FROM integrations WHERE credential_id = ?').all(row.id).map((r: any) => r.name);
  return { id: row.id, name: row.name, type: row.type, createdAt: row.created_at, updatedAt: row.updated_at, usedBy };
}

export function listCredentials(): CredentialMeta[] {
  return db.prepare('SELECT * FROM credentials ORDER BY name').all().map(rowToCredMeta);
}

export function createCredential(name: string, type: CredentialType, data: Record<string, string>): CredentialMeta {
  if (!name.trim()) throw new Error('Credential name is required.');
  if (!CRED_FIELDS[type]) throw new Error(`Unknown credential type: ${type}`);
  for (const f of CRED_FIELDS[type]) {
    if (!String(data[f] ?? '').trim()) throw new Error(`Missing field: ${f}`);
  }
  const now = Date.now();
  const id = randomUUID();
  db.prepare('INSERT INTO credentials (id, name, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name.trim(), type, encryptSecret(data), now, now);
  return rowToCredMeta(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id));
}

/** replace secret material and/or rename — omitted secret fields keep their stored value */
export function updateCredential(id: string, patch: { name?: string; data?: Record<string, string> }): CredentialMeta {
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as any;
  if (!row) throw new Error('Credential not found.');
  let data = decryptSecret(row.data);
  if (patch.data) {
    for (const [k, v] of Object.entries(patch.data)) {
      if (String(v).trim()) data[k] = v;
    }
  }
  db.prepare('UPDATE credentials SET name = ?, data = ?, updated_at = ? WHERE id = ?')
    .run((patch.name ?? row.name).trim() || row.name, encryptSecret(data), Date.now(), id);
  return rowToCredMeta(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id));
}

/**
 * Replace a credential's secret material exactly. updateCredential merges and
 * ignores blank fields — right for the form, where blank means "unchanged" —
 * but a sign-in that signs out, or refreshes to a token with no expiry, has
 * to be able to clear a field. Server-internal: the OAuth flow writes through
 * this, never the API.
 */
export function replaceCredentialData(id: string, data: Record<string, string>): void {
  const res = db.prepare('UPDATE credentials SET data = ?, updated_at = ? WHERE id = ?').run(encryptSecret(data), Date.now(), id);
  if (res.changes === 0) throw new Error('Credential not found.');
}

export function deleteCredential(id: string): void {
  const used = db.prepare('SELECT name FROM integrations WHERE credential_id = ?').all(id) as any[];
  if (used.length > 0) throw new Error(`In use by: ${used.map((u) => u.name).join(', ')} — detach it there first.`);
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
}

/** server-internal only: decrypted secret material for execution */
export function credentialSecret(id: string | null): { type: CredentialType; data: Record<string, string> } | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { type: row.type, data: decryptSecret(row.data) };
}

/** the parts of an OAuth credential that are secret; the rest is public metadata */
const OAUTH_SECRET_KEYS = ['accessToken', 'refreshToken', 'clientSecret'] as const;

/** every secret string of a credential — used to scrub outputs/errors */
export function credentialSecretValues(id: string | null): string[] {
  const c = credentialSecret(id);
  if (!c) return [];
  const values: string[] = [];
  if (c.type === 'oauth') {
    for (const k of OAUTH_SECRET_KEYS) if (c.data[k]) values.push(c.data[k]);
    return values.filter((v) => v.length >= 4);
  }
  for (const [k, v] of Object.entries(c.data)) {
    if (k === 'headersJson' || k === 'envJson') {
      try { values.push(...Object.values(JSON.parse(v)).map(String)); } catch { values.push(v); }
    } else if (k !== 'header' && k !== 'username') {
      values.push(v);
    }
  }
  return values.filter((v) => v.length >= 4);
}

// ---------------------------------------------------------------- integrations

// set when a server answers with an OAuth challenge and no sign-in exists yet
try { db.exec('ALTER TABLE integrations ADD COLUMN oauth_required INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

export function setOAuthRequired(id: string, required: boolean): void {
  db.prepare('UPDATE integrations SET oauth_required = ? WHERE id = ?').run(required ? 1 : 0, id);
}

/** Sign-in status for the UI, read from the encrypted credential without exposing it. */
function oauthStatus(row: any): IntegrationOAuthStatus | undefined {
  const cred = row.credential_id ? credentialSecret(row.credential_id) : null;
  if (cred?.type === 'oauth') {
    const exp = Number(cred.data.expiresAt);
    return {
      required: !cred.data.accessToken,
      signedIn: !!cred.data.accessToken,
      issuer: cred.data.issuer || undefined,
      expiresAt: Number.isFinite(exp) && exp > 0 ? exp : null,
      scope: cred.data.scope || undefined,
      clientSource: (cred.data.clientSource || undefined) as IntegrationOAuthStatus['clientSource'],
    };
  }
  return row.oauth_required ? { required: true, signedIn: false } : undefined;
}

function rowToTool(row: any): IntegrationTool {
  return {
    id: row.id,
    integrationId: row.integration_id,
    name: row.name,
    fullName: row.full_name,
    description: row.description || row.default_description,
    defaultDescription: row.default_description,
    paramsSchema: JSON.parse(row.params_schema),
    spec: JSON.parse(row.spec),
    enabled: !!row.enabled,
    roles: JSON.parse(row.roles),
    ...(row.missing ? { missing: true } : {}),
  };
}

function rowToIntegration(row: any, withTools = true): Integration {
  const cred = row.credential_id
    ? (db.prepare('SELECT name FROM credentials WHERE id = ?').get(row.credential_id) as any)?.name ?? null
    : null;
  const oauth = oauthStatus(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    enabled: !!row.enabled,
    credentialId: row.credential_id,
    credentialName: cred,
    config: JSON.parse(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok == null ? null : !!row.last_test_ok,
    lastTestError: row.last_test_error,
    ...(oauth ? { oauth } : {}),
    tools: withTools
      ? db.prepare('SELECT * FROM integration_tools WHERE integration_id = ? ORDER BY name').all(row.id).map(rowToTool)
      : [],
  };
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  if (!s) throw new Error('Integration name must contain letters or digits.');
  return s;
}

export function listIntegrations(): Integration[] {
  return db.prepare('SELECT * FROM integrations ORDER BY name').all().map((r) => rowToIntegration(r));
}

export function getIntegration(id: string): Integration | null {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
  return row ? rowToIntegration(row) : null;
}

export function createIntegration(input: {
  name: string; type: IntegrationType; config: unknown; credentialId?: string | null; slug?: string;
}): Integration {
  if (!['mcp', 'openapi', 'http', 'ssh'].includes(input.type)) throw new Error(`Unsupported integration type: ${input.type}`);
  if (!input.name.trim()) throw new Error('Integration name is required.');
  if (input.credentialId && !db.prepare('SELECT id FROM credentials WHERE id = ?').get(input.credentialId)) {
    throw new Error('Referenced credential does not exist.');
  }
  let slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name);
  if (db.prepare('SELECT id FROM integrations WHERE slug = ?').get(slug)) {
    slug = `${slug.slice(0, 27)}_${randomUUID().slice(0, 4)}`;
  }
  const now = Date.now();
  const id = randomUUID();
  db.prepare('INSERT INTO integrations (id, slug, name, type, enabled, credential_id, config, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
    .run(id, slug, input.name.trim(), input.type, input.credentialId ?? null, JSON.stringify(input.config ?? {}), now, now);
  return getIntegration(id)!;
}

export function updateIntegration(id: string, patch: {
  name?: string; config?: unknown; credentialId?: string | null; enabled?: boolean;
}): Integration {
  const cur = getIntegration(id);
  if (!cur) throw new Error('Integration not found.');
  if (patch.credentialId && !db.prepare('SELECT id FROM credentials WHERE id = ?').get(patch.credentialId)) {
    throw new Error('Referenced credential does not exist.');
  }
  db.prepare('UPDATE integrations SET name = ?, config = ?, credential_id = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(
      (patch.name ?? cur.name).trim() || cur.name,
      JSON.stringify(patch.config ?? cur.config),
      patch.credentialId === undefined ? cur.credentialId : patch.credentialId,
      patch.enabled === undefined ? (cur.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      Date.now(), id,
    );
  return getIntegration(id)!;
}

export function recordTest(id: string, ok: boolean, error?: string): void {
  db.prepare('UPDATE integrations SET last_test_at = ?, last_test_ok = ?, last_test_error = ? WHERE id = ?')
    .run(Date.now(), ok ? 1 : 0, error ?? null, id);
}

export function deleteIntegration(id: string): void {
  db.prepare('DELETE FROM integration_tools WHERE integration_id = ?').run(id);
  db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- tools

const VALID_ROLES: RoleName[] = ['builder', 'reviewer'];

function toolFullName(slug: string, name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!clean) throw new Error(`Tool name "${name}" contains no usable characters.`);
  return `${slug}_${clean}`;
}

export function upsertTool(integration: Integration, input: {
  name: string;
  description: string;
  paramsSchema: { properties: Record<string, unknown>; required: string[] };
  spec: IntegrationToolSpec;
  enabled?: boolean;
  roles?: RoleName[];
}): IntegrationTool {
  const fullName = toolFullName(integration.slug, input.name);
  const existing = db.prepare('SELECT * FROM integration_tools WHERE full_name = ?').get(fullName) as any;
  if (existing && existing.integration_id !== integration.id) throw new Error(`Tool name collides with ${fullName}.`);
  if (existing) {
    // discovery refresh: update facts, PRESERVE admin choices (enabled/roles/edited description)
    db.prepare('UPDATE integration_tools SET default_description = ?, params_schema = ?, spec = ?, missing = 0 WHERE id = ?')
      .run(input.description, JSON.stringify(input.paramsSchema), JSON.stringify(input.spec), existing.id);
    return rowToTool(db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(existing.id));
  }
  const id = randomUUID();
  const roles = (input.roles ?? ['builder']).filter((r) => VALID_ROLES.includes(r));
  db.prepare(`INSERT INTO integration_tools (id, integration_id, name, full_name, description, default_description, params_schema, spec, enabled, roles)
    VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`)
    .run(id, integration.id, input.name, fullName, input.description, JSON.stringify(input.paramsSchema), JSON.stringify(input.spec), input.enabled === false ? 0 : 1, JSON.stringify(roles));
  return rowToTool(db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(id));
}

/** after a refresh, tools discovery no longer reports are flagged, not deleted */
export function markMissingExcept(integrationId: string, keepFullNames: string[]): void {
  const rows = db.prepare('SELECT id, full_name FROM integration_tools WHERE integration_id = ?').all(integrationId) as any[];
  for (const r of rows) {
    db.prepare('UPDATE integration_tools SET missing = ? WHERE id = ?').run(keepFullNames.includes(r.full_name) ? 0 : 1, r.id);
  }
}

export function updateTool(toolId: string, patch: { description?: string; enabled?: boolean; roles?: RoleName[] }): IntegrationTool {
  const row = db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(toolId) as any;
  if (!row) throw new Error('Tool not found.');
  if (patch.description !== undefined) {
    if (patch.description.length > 4_000) throw new Error('Descriptions are limited to 4,000 characters.');
    const value = patch.description.trim() === '' || patch.description === row.default_description ? '' : patch.description;
    db.prepare('UPDATE integration_tools SET description = ? WHERE id = ?').run(value, toolId);
  }
  if (patch.enabled !== undefined) {
    db.prepare('UPDATE integration_tools SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, toolId);
  }
  if (patch.roles !== undefined) {
    const roles = patch.roles.filter((r) => VALID_ROLES.includes(r));
    db.prepare('UPDATE integration_tools SET roles = ? WHERE id = ?').run(JSON.stringify(roles), toolId);
  }
  return rowToTool(db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(toolId));
}

/** custom-http tools can be fully replaced (facts included) — they are Admin-authored */
export function replaceHttpTool(toolId: string, integration: Integration, input: {
  name: string; description: string; paramsSchema: { properties: Record<string, unknown>; required: string[] }; spec: IntegrationToolSpec;
}): IntegrationTool {
  const row = db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(toolId) as any;
  if (!row) throw new Error('Tool not found.');
  const fullName = toolFullName(integration.slug, input.name);
  const clash = db.prepare('SELECT id FROM integration_tools WHERE full_name = ? AND id != ?').get(fullName, toolId);
  if (clash) throw new Error(`Tool name collides with ${fullName}.`);
  db.prepare('UPDATE integration_tools SET name = ?, full_name = ?, default_description = ?, params_schema = ?, spec = ? WHERE id = ?')
    .run(input.name, fullName, input.description, JSON.stringify(input.paramsSchema), JSON.stringify(input.spec), toolId);
  return rowToTool(db.prepare('SELECT * FROM integration_tools WHERE id = ?').get(toolId));
}

export function deleteTool(toolId: string): void {
  db.prepare('DELETE FROM integration_tools WHERE id = ?').run(toolId);
}

export function getToolByFullName(fullName: string): { tool: IntegrationTool; integration: Integration } | null {
  const row = db.prepare('SELECT * FROM integration_tools WHERE full_name = ?').get(fullName) as any;
  if (!row) return null;
  const integration = getIntegration(row.integration_id);
  if (!integration) return null;
  return { tool: rowToTool(row), integration };
}
