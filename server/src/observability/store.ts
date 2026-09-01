/**
 * Observability API keys and the stable instance identity.
 *
 * This is the ONLY new persistence the Observability interface adds, and it
 * stores credentials — never evidence. Tandem's existing tables remain the sole
 * source of session and project-run evidence; nothing here copies, normalizes
 * or summarizes any of it.
 *
 * Keys are high-entropy secrets shown exactly once. Only a SHA-256 hash and a
 * short display prefix are persisted, so a stored row can verify a presented
 * key but can never reproduce it.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ObservabilityKey } from '../../../shared/types';
import { db, kvGet, kvSet } from '../db';

db.exec(`
CREATE TABLE IF NOT EXISTS observability_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_observability_keys_hash ON observability_keys(key_hash);
`);

export const KEY_PREFIX = 'tnd_obs_';
/** 32 bytes = 256 bits of entropy, base64url-encoded. */
const SECRET_BYTES = 32;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The instance identity an external consumer correlates against. It is stored
 * once in the existing kv table, so it survives process restarts, service
 * restarts, hostname changes and base-URL changes — none of which are part of
 * the identity.
 */
export function instanceId(): string {
  const existing = kvGet<string>('observability_instance_id');
  if (existing) return existing;
  const id = `tnd_${randomUUID().replace(/-/g, '')}`;
  kvSet('observability_instance_id', id);
  return id;
}

function rowToKey(r: any): ObservabilityKey {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
    revokedAt: r.revoked_at ?? null,
  };
}

export function listKeys(): ObservabilityKey[] {
  return (db.prepare('SELECT * FROM observability_keys ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as any[])
    .map(rowToKey);
}

/**
 * Mint a key. The plaintext is returned to the caller EXACTLY once — it is
 * never written anywhere, so no later request (and no admin) can reveal it.
 */
export function createKey(name: string): { key: ObservabilityKey; secret: string } {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('A key name is required.');
  if (clean.length > 80) throw new Error('Key names are limited to 80 characters.');
  const secret = `${KEY_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO observability_keys (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, clean, secret.slice(0, KEY_PREFIX.length + 4), sha256(secret), now);
  return { key: rowToKey(db.prepare('SELECT * FROM observability_keys WHERE id = ?').get(id)), secret };
}

/** Is this key still usable? Used to expire connections that are already open. */
export function keyIsActive(id: string): boolean {
  const row = db.prepare('SELECT revoked_at FROM observability_keys WHERE id = ?').get(id) as any;
  return !!row && !row.revoked_at;
}

export function revokeKey(id: string): ObservabilityKey | null {
  const row = db.prepare('SELECT * FROM observability_keys WHERE id = ?').get(id) as any;
  if (!row) return null;
  if (!row.revoked_at) db.prepare('UPDATE observability_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
  return rowToKey(db.prepare('SELECT * FROM observability_keys WHERE id = ?').get(id));
}

/**
 * Verify a presented bearer secret. Returns the key row on success and stamps
 * last_used_at. A revoked key stops working immediately — the revocation check
 * is part of the same lookup, not a cached decision.
 */
export function verifyKey(presented: string | undefined): ObservabilityKey | null {
  const secret = (presented ?? '').trim();
  if (!secret.startsWith(KEY_PREFIX)) return null;
  const hash = sha256(secret);
  const row = db.prepare('SELECT * FROM observability_keys WHERE key_hash = ?').get(hash) as any;
  if (!row || row.revoked_at) return null;
  // the lookup already matched on the digest; this is the constant-time
  // confirmation that the stored digest is byte-identical to the computed one
  const a = Buffer.from(row.key_hash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  db.prepare('UPDATE observability_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return rowToKey(row);
}
