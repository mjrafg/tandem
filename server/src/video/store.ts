/**
 * Channels, their versions, media assets, video projects, approvals and the
 * paid-operation ledger — the persistence behind video production.
 *
 * A video project is an ordinary Director project run (project_runs); the
 * video_projects row only adds what makes it a video: the Channel version it
 * is pinned to, its production phase and its approved budget. Nothing owned by
 * the Director, the sessions or the chats is duplicated here.
 *
 * Versioning. A Channel's content (Style Bible, entities, the list of its
 * reusable assets) is stored as immutable versions. Every change writes the
 * next version inside one transaction, so two projects updating the same
 * Channel at once get consecutive versions rather than a lost update; a caller
 * that read version N can pass expectedVersion=N to refuse a write on top of a
 * version it has not seen. Asset files are immutable too, so a version that
 * lists an asset keeps meaning exactly that image forever. A project reads the
 * version it is pinned to and never moves unless someone explicitly moves it.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalKind, ApprovalPayload, AssetKind, Channel, ChannelContent, ChannelEntity, ChannelVersion,
  EntityType, MediaAsset, VideoPhase, VideoProject,
} from '../../../shared/types';
import { config } from '../config';
import { db } from '../db';

// ---------------------------------------------------------------- schema

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  head_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_versions (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel_id, version)
);
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  channel_id TEXT,
  project_run_id TEXT,
  entity_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  attributes TEXT NOT NULL DEFAULT '{}',
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  promoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_assets_channel ON media_assets(channel_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_run ON media_assets(project_run_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_sha ON media_assets(sha256);
CREATE TABLE IF NOT EXISTS video_projects (
  run_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  channel_version INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'planning',
  budget_usd REAL,
  estimate TEXT,
  narration TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  event_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS paid_ops (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  op_key TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_paid_ops_key ON paid_ops(run_id, op_key);
`);
// how many new images the approved plan covers — binding even when a provider's rate is $0
try { db.exec('ALTER TABLE video_projects ADD COLUMN approved_images INTEGER'); } catch { /* exists */ }

export class VideoError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------- media files

export const MEDIA_DIR = path.join(config.dataDir, 'media');
/** production files: the ONLY directory the Video Engine is given, as its "tandem" library */
export const PRODUCTION_DIR = path.join(MEDIA_DIR, 'production');
const REFERENCE_DIR = path.join(MEDIA_DIR, 'reference');
const PREVIEW_DIR = path.join(MEDIA_DIR, 'previews');
export const ENGINE_LIBRARY = 'tandem';

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm',
};

export function assetFilePath(a: Pick<MediaAsset, 'kind'> & { file: string }): string {
  return path.join(a.kind === 'production' ? PRODUCTION_DIR : REFERENCE_DIR, a.file);
}

/** a small JPEG an agent can look at without paying for a 2 MB image in its context */
export function previewPath(assetId: string): string {
  return path.join(PREVIEW_DIR, `${assetId}.jpg`);
}

function makePreview(src: string, dst: string): boolean {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const attempts: [string, string[]][] = [
    ['ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', "scale='min(640,iw)':-2", '-frames:v', '1', '-q:v', '6', dst]],
    ...(process.platform === 'darwin' ? [['sips', ['-Z', '640', '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', src, '--out', dst]] as [string, string[]]] : []),
  ];
  for (const [bin, args] of attempts) {
    try {
      execFileSync(bin, args, { stdio: 'ignore', timeout: 30_000 });
      if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return true;
    } catch { /* try the next tool */ }
  }
  return false;
}

/** width and height from PNG / JPEG headers; null when not an image we can read */
function dimensions(b: Buffer): { width: number | null; height: number | null } {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return { width: null, height: null };
}

// ---------------------------------------------------------------- channels

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'channel';
}

function rowToChannel(r: any): Channel {
  return { id: r.id, slug: r.slug, name: r.name, headVersion: r.head_version, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listChannels(): Channel[] {
  return (db.prepare('SELECT * FROM channels ORDER BY name').all() as any[]).map(rowToChannel);
}

/** by id, slug or exact name */
export function findChannel(ref: unknown): Channel | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const q = ref.trim();
  const r = db.prepare('SELECT * FROM channels WHERE id = ? OR slug = ? OR lower(name) = lower(?)').get(q, slugify(q), q) as any;
  return r ? rowToChannel(r) : null;
}

export function requireChannel(ref: unknown): Channel {
  const c = findChannel(ref);
  if (!c) throw new VideoError(404, `No channel "${String(ref ?? '')}". Use channel_list to see the channels.`);
  return c;
}

export function getChannelVersion(channelId: string, version?: number): ChannelVersion {
  const ch = db.prepare('SELECT head_version FROM channels WHERE id = ?').get(channelId) as any;
  if (!ch) throw new VideoError(404, 'That channel does not exist.');
  const v = version ?? ch.head_version;
  const r = db.prepare('SELECT * FROM channel_versions WHERE channel_id = ? AND version = ?').get(channelId, v) as any;
  if (!r) throw new VideoError(404, `The channel has no version ${v} (latest is ${ch.head_version}).`);
  return { channelId, version: r.version, content: JSON.parse(r.content), note: r.note, createdAt: r.created_at, createdBy: r.created_by };
}

export function listChannelVersions(channelId: string): { version: number; note: string; createdAt: number; createdBy: string }[] {
  return (db.prepare('SELECT version, note, created_at, created_by FROM channel_versions WHERE channel_id = ? ORDER BY version DESC').all(channelId) as any[])
    .map((r) => ({ version: r.version, note: r.note, createdAt: r.created_at, createdBy: r.created_by }));
}

export function createChannel(input: { name: unknown; description?: unknown; patch?: ChannelPatch; note?: unknown; by: string }): { channel: Channel; version: ChannelVersion; changes: string[] } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new VideoError(400, 'A channel needs a name.');
  if (name.length > 80) throw new VideoError(400, 'Channel names are limited to 80 characters.');
  if (findChannel(name)) throw new VideoError(409, `A channel called "${name}" already exists — update it instead.`);
  let slug = slugify(name);
  while (db.prepare('SELECT 1 FROM channels WHERE slug = ?').get(slug)) slug = `${slugify(name).slice(0, 34)}-${randomBytes(2).toString('hex')}`;
  const id = `ch_${randomBytes(8).toString('hex')}`;
  const now = Date.now();
  const empty: ChannelContent = {
    name,
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 4000) : '',
    styleBible: { summary: '', sections: {} },
    entities: [],
    assetIds: [],
    defaults: {},
  };
  // the first version carries whatever the creator already knows
  const { next: content, changes } = input.patch ? applyPatch(empty, { ...input.patch, name: undefined }) : { next: empty, changes: [] as string[] };
  db.transaction(() => {
    db.prepare('INSERT INTO channels (id, slug, name, head_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(id, slug, name, now, now);
    db.prepare('INSERT INTO channel_versions (channel_id, version, content, note, created_at, created_by) VALUES (?, 1, ?, ?, ?, ?)')
      .run(id, JSON.stringify(content), str(input.note, 500) || 'Channel created', now, input.by);
  })();
  return { channel: requireChannel(id), version: getChannelVersion(id, 1), changes };
}

export interface ChannelPatch {
  name?: unknown;
  description?: unknown;
  styleBible?: { summary?: unknown; sections?: Record<string, unknown> };
  entities?: unknown[];
  removeEntities?: unknown[];
  addAssetIds?: string[];
  removeAssetIds?: unknown[];
  defaults?: Record<string, unknown>;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

const ENTITY_TYPES: EntityType[] = ['character', 'location', 'prop', 'other'];

/** apply a patch to a copy of the content; throws on anything malformed */
function applyPatch(base: ChannelContent, patch: ChannelPatch): { next: ChannelContent; changes: string[] } {
  const next: ChannelContent = structuredClone(base);
  const changes: string[] = [];
  if (patch.name !== undefined) { const n = str(patch.name, 80); if (!n) throw new VideoError(400, 'A channel name cannot be empty.'); next.name = n; changes.push('name'); }
  if (patch.description !== undefined) { next.description = str(patch.description, 4000); changes.push('description'); }
  if (patch.styleBible) {
    if (patch.styleBible.summary !== undefined) { next.styleBible.summary = str(patch.styleBible.summary, 4000); changes.push('style bible summary'); }
    for (const [title, text] of Object.entries(patch.styleBible.sections ?? {})) {
      const key = title.trim().slice(0, 80);
      if (!key) continue;
      if (text === null || text === '') { delete next.styleBible.sections[key]; changes.push(`style bible: removed "${key}"`); }
      else { next.styleBible.sections[key] = str(text, 12_000); changes.push(`style bible: "${key}"`); }
    }
  }
  for (const raw of patch.entities ?? []) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const type = String(e.type ?? '') as EntityType;
    const existing = typeof e.id === 'string' ? next.entities.find((x) => x.id === e.id) : undefined;
    if (!existing && !ENTITY_TYPES.includes(type)) throw new VideoError(400, `An entity needs a type: ${ENTITY_TYPES.join(', ')}.`);
    const name = e.name !== undefined ? str(e.name, 120) : existing?.name ?? '';
    if (!name) throw new VideoError(400, 'An entity needs a name.');
    if (existing) {
      if (e.type !== undefined && ENTITY_TYPES.includes(type)) existing.type = type;
      existing.name = name;
      if (e.summary !== undefined) existing.summary = str(e.summary, 600);
      if (e.description !== undefined) existing.description = str(e.description, 12_000);
      if (e.attributes && typeof e.attributes === 'object') existing.attributes = { ...existing.attributes, ...(e.attributes as object) };
      changes.push(`${existing.type} ${existing.id} updated`);
    } else {
      if (typeof e.id === 'string' && e.id.trim()) throw new VideoError(404, `There is no entity ${e.id} in this channel version — omit id to create one.`);
      let id = `${type === 'character' ? 'char' : type === 'location' ? 'loc' : type}-${slugify(name).slice(0, 30)}`;
      while (next.entities.some((x) => x.id === id)) id = `${id}-${randomBytes(1).toString('hex')}`;
      const entity: ChannelEntity = {
        id, type, name, summary: str(e.summary, 600), description: str(e.description, 12_000),
        attributes: e.attributes && typeof e.attributes === 'object' ? { ...(e.attributes as object) } : {},
      };
      next.entities.push(entity);
      changes.push(`${type} ${id} created`);
    }
  }
  for (const id of patch.removeEntities ?? []) {
    const before = next.entities.length;
    next.entities = next.entities.filter((x) => x.id !== id);
    if (next.entities.length !== before) changes.push(`entity ${String(id)} removed`);
  }
  for (const id of patch.addAssetIds ?? []) {
    if (!next.assetIds.includes(id)) { next.assetIds.push(id); changes.push(`asset ${id} added`); }
  }
  for (const id of patch.removeAssetIds ?? []) {
    const before = next.assetIds.length;
    next.assetIds = next.assetIds.filter((x) => x !== id);
    if (next.assetIds.length !== before) changes.push(`asset ${String(id)} removed`);
  }
  if (patch.defaults && typeof patch.defaults === 'object') { next.defaults = { ...next.defaults, ...patch.defaults }; changes.push('defaults'); }
  return { next, changes };
}

/**
 * Write the next version. Atomic: read head, apply, insert, bump — in one
 * transaction, so concurrent writers serialize instead of overwriting.
 */
export function updateChannel(channelId: string, patch: ChannelPatch, opts: { expectedVersion?: unknown; by: string; note?: unknown }): { version: ChannelVersion; changes: string[] } {
  return db.transaction(() => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as any;
    if (!ch) throw new VideoError(404, 'That channel does not exist.');
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== null && Number(opts.expectedVersion) !== ch.head_version) {
      throw new VideoError(409, `The channel changed since version ${opts.expectedVersion} — it is now at version ${ch.head_version}. Read it again (channel_get) and re-apply your change on top.`);
    }
    const head = getChannelVersion(channelId, ch.head_version);
    const { next, changes } = applyPatch(head.content, patch);
    if (changes.length === 0) throw new VideoError(400, 'Nothing to change — the patch was empty.');
    const version = ch.head_version + 1;
    const now = Date.now();
    const note = str(opts.note, 500) || changes.slice(0, 6).join('; ');
    db.prepare('INSERT INTO channel_versions (channel_id, version, content, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channelId, version, JSON.stringify(next), note, now, opts.by);
    db.prepare('UPDATE channels SET head_version = ?, name = ?, updated_at = ? WHERE id = ?').run(version, next.name, now, channelId);
    return { version: getChannelVersion(channelId, version), changes };
  })();
}

// ---------------------------------------------------------------- assets

function rowToAsset(r: any): MediaAsset & { file: string } {
  return {
    id: r.id, kind: r.kind, scope: r.scope, channelId: r.channel_id ?? null, projectRunId: r.project_run_id ?? null,
    entityId: r.entity_id ?? null, name: r.name, description: r.description, tags: JSON.parse(r.tags || '[]'),
    attributes: JSON.parse(r.attributes || '{}'), mime: r.mime, width: r.width ?? null, height: r.height ?? null,
    bytes: r.bytes, sha256: r.sha256, provenance: JSON.parse(r.provenance || '{}'), createdAt: r.created_at,
    promotedAt: r.promoted_at ?? null, file: r.file,
  };
}

export function getAsset(id: string): (MediaAsset & { file: string }) | null {
  const r = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id) as any;
  return r ? rowToAsset(r) : null;
}

export interface NewAsset {
  bytes: Buffer;
  ext: string;
  kind: AssetKind;
  scope: 'channel' | 'project';
  channelId: string | null;
  projectRunId: string | null;
  entityId?: string | null;
  name: string;
  description?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export function createAsset(a: NewAsset): MediaAsset {
  if (a.kind !== 'reference' && a.kind !== 'production') throw new VideoError(400, 'An asset is either a "reference" (identity, guidance) or a "production" asset (engine-ready).');
  const ext = a.ext.toLowerCase().replace(/^\./, '');
  const mime = EXT_MIME[ext];
  if (!mime) throw new VideoError(400, `Unsupported media type ".${ext}" — use an image (png, jpg, webp), audio (mp3, wav, ogg, m4a, flac) or video (mp4, webm).`);
  const id = `ast_${randomBytes(8).toString('hex')}`;
  const file = `${id}.${ext}`;
  const dest = assetFilePath({ kind: a.kind, file });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, a.bytes, { flag: 'wx' });
  const dims = mime.startsWith('image/') ? dimensions(a.bytes) : { width: null, height: null };
  const attributes = { ...(a.attributes ?? {}) };
  // a reference is never engine-ready, whatever the caller claimed
  if (a.kind === 'reference') attributes.engineReady = false;
  try {
    db.prepare(`INSERT INTO media_assets (id, kind, scope, channel_id, project_run_id, entity_id, name, description, tags, attributes,
        file, mime, width, height, bytes, sha256, provenance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, a.kind, a.scope, a.channelId, a.projectRunId, a.entityId ?? null, a.name.slice(0, 160), (a.description ?? '').slice(0, 4000),
      JSON.stringify((a.tags ?? []).map((t) => String(t).slice(0, 60)).slice(0, 30)), JSON.stringify(attributes),
      file, mime, dims.width, dims.height, a.bytes.length, createHash('sha256').update(a.bytes).digest('hex'),
      JSON.stringify(a.provenance ?? {}), Date.now(),
    );
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  if (mime.startsWith('image/')) makePreview(dest, previewPath(id));
  return getAsset(id)!;
}

/** what a context may see: its pinned channel version's assets, plus its own project's */
export interface AssetView {
  channelId: string | null;
  version: number | null;
  runId: string | null;
}

export function visibleAssetIds(view: AssetView): Set<string> {
  const ids = new Set<string>();
  if (view.channelId && view.version) for (const id of getChannelVersion(view.channelId, view.version).content.assetIds) ids.add(id);
  if (view.runId) for (const r of db.prepare('SELECT id FROM media_assets WHERE project_run_id = ?').all(view.runId) as any[]) ids.add(r.id);
  return ids;
}

export interface AssetQuery {
  query?: string;
  kind?: AssetKind;
  entityId?: string;
  scope?: 'channel' | 'project';
  tags?: string[];
  engineReady?: boolean;
  limit?: number;
}

export function searchAssets(view: AssetView, q: AssetQuery): MediaAsset[] {
  const ids = [...visibleAssetIds(view)];
  if (ids.length === 0) return [];
  const rows = (db.prepare(`SELECT * FROM media_assets WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`).all(...ids) as any[]).map(rowToAsset);
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const channelIds = view.channelId && view.version ? new Set(getChannelVersion(view.channelId, view.version).content.assetIds) : new Set<string>();
  return rows
    .filter((a) => !q.kind || a.kind === q.kind)
    .filter((a) => !q.entityId || a.entityId === q.entityId)
    .filter((a) => !q.scope || (q.scope === 'channel' ? channelIds.has(a.id) : a.projectRunId === view.runId && !channelIds.has(a.id)))
    .filter((a) => !q.tags?.length || q.tags.every((t) => a.tags.includes(t)))
    .filter((a) => q.engineReady === undefined || !!a.attributes.engineReady === q.engineReady)
    .filter((a) => {
      if (words.length === 0) return true;
      const hay = [a.name, a.description, a.entityId ?? '', ...a.tags, JSON.stringify(a.attributes)].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, Math.min(Math.max(q.limit ?? 50, 1), 200))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ file, ...rest }) => ({ ...rest, scope: channelIds.has(rest.id) ? 'channel' : 'project' }));
}

// ---------------------------------------------------------------- video projects

function rowToVideo(r: any): VideoProject {
  const ch = db.prepare('SELECT name, head_version FROM channels WHERE id = ?').get(r.channel_id) as any;
  return {
    runId: r.run_id, channelId: r.channel_id, channelName: ch?.name ?? '(deleted channel)', channelVersion: r.channel_version,
    newerVersion: ch && ch.head_version > r.channel_version ? ch.head_version : null,
    phase: r.phase as VideoPhase, budgetUsd: r.budget_usd ?? null, spentUsd: spentUsd(r.run_id),
    approvedImages: r.approved_images ?? null, imagesGenerated: countPaidOps(r.run_id, 'images'),
    estimate: r.estimate ? JSON.parse(r.estimate) : null, narration: r.narration ? JSON.parse(r.narration) : null,
    createdAt: r.created_at,
  };
}

export function getVideoProject(runId: string): VideoProject | null {
  const r = db.prepare('SELECT * FROM video_projects WHERE run_id = ?').get(runId) as any;
  return r ? rowToVideo(r) : null;
}

/** the Director run a chat belongs to: its Project Chat, or one of its sessions */
export function runIdForChat(chatId: string): string | null {
  const own = db.prepare("SELECT project_run_id FROM chats WHERE id = ? AND kind = 'project'").get(chatId) as any;
  if (own?.project_run_id) return own.project_run_id;
  const session = db.prepare('SELECT run_id FROM pd_sessions WHERE chat_id = ?').get(chatId) as any;
  return session?.run_id ?? null;
}

export function videoProjectForChat(chatId: string): VideoProject | null {
  const runId = runIdForChat(chatId);
  return runId ? getVideoProject(runId) : null;
}

export function listVideoProjects(): VideoProject[] {
  return (db.prepare('SELECT * FROM video_projects ORDER BY created_at DESC').all() as any[]).map(rowToVideo);
}

export function insertVideoProject(runId: string, channelId: string, version: number): VideoProject {
  const now = Date.now();
  db.prepare('INSERT INTO video_projects (run_id, channel_id, channel_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, channelId, version, now, now);
  return getVideoProject(runId)!;
}

export function patchVideoProject(runId: string, patch: { phase?: VideoPhase; budgetUsd?: number | null; approvedImages?: number | null; estimate?: unknown; narration?: unknown; channelVersion?: number }): VideoProject {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.approvedImages !== undefined) { sets.push('approved_images = ?'); vals.push(patch.approvedImages); }
  if (patch.phase) { sets.push('phase = ?'); vals.push(patch.phase); }
  if (patch.budgetUsd !== undefined) { sets.push('budget_usd = ?'); vals.push(patch.budgetUsd); }
  if (patch.estimate !== undefined) { sets.push('estimate = ?'); vals.push(JSON.stringify(patch.estimate)); }
  if (patch.narration !== undefined) { sets.push('narration = ?'); vals.push(JSON.stringify(patch.narration)); }
  if (patch.channelVersion !== undefined) { sets.push('channel_version = ?'); vals.push(patch.channelVersion); }
  sets.push('updated_at = ?'); vals.push(Date.now());
  db.prepare(`UPDATE video_projects SET ${sets.join(', ')} WHERE run_id = ?`).run(...vals, runId);
  return getVideoProject(runId)!;
}

/** a fresh project directory for a video — a git repository, like any Director project */
export function makeVideoDirectory(channel: Channel): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(config.projectsDir, 'videos', `${channel.slug}-${day}-${randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${channel.name} video\n\nA Tandem video project on the "${channel.name}" channel. Scripts, plans and notes live here; media lives in Tandem's asset library.\n`);
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 });
  try {
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Tandem', '-c', 'user.email=tandem@localhost', 'commit', '-q', '-m', 'Video project created']);
  } catch { /* git is optional: the Director also runs directory projects */ }
  return dir;
}

// ---------------------------------------------------------------- approvals

function rowToApproval(r: any): ApprovalPayload & { runId: string; chatId: string; eventId: string | null } {
  return {
    id: r.id, kind: r.kind, status: r.status, title: r.title, summary: r.summary, detail: JSON.parse(r.detail || '{}'),
    ...(r.decided_at ? { decidedAt: r.decided_at } : {}), runId: r.run_id, chatId: r.chat_id, eventId: r.event_id ?? null,
  };
}

export function createApproval(input: { runId: string; chatId: string; kind: ApprovalKind; title: string; summary: string; detail: Record<string, unknown> }): ApprovalPayload & { runId: string; chatId: string; eventId: string | null } {
  const id = randomUUID();
  db.prepare('INSERT INTO approvals (id, run_id, chat_id, kind, title, summary, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.runId, input.chatId, input.kind, input.title, input.summary, JSON.stringify(input.detail), Date.now());
  return getApproval(id)!;
}

export function getApproval(id: string) {
  const r = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
  return r ? rowToApproval(r) : null;
}

export function pendingApprovals(runId: string, kind?: ApprovalKind) {
  const rows = kind
    ? db.prepare("SELECT * FROM approvals WHERE run_id = ? AND kind = ? AND status = 'pending' ORDER BY created_at").all(runId, kind)
    : db.prepare("SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY created_at").all(runId);
  return (rows as any[]).map(rowToApproval);
}

export function setApprovalEvent(id: string, eventId: string): void {
  db.prepare('UPDATE approvals SET event_id = ? WHERE id = ?').run(eventId, id);
}

export function markApproval(id: string, status: 'approved' | 'declined'): void {
  db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, Date.now(), id);
}

// ---------------------------------------------------------------- paid operations

/** a stable key for "the same paid request" — equal input, equal key */
export function opKey(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function findPaidOp(runId: string, key: string): { result: string; costUsd: number; label: string } | null {
  const r = db.prepare('SELECT result, cost_usd, label FROM paid_ops WHERE run_id = ? AND op_key = ?').get(runId, key) as any;
  return r ? { result: r.result, costUsd: r.cost_usd, label: r.label } : null;
}

export function recordPaidOp(input: { runId: string; chatId: string; key: string; category: string; label: string; costUsd: number; result: string }): void {
  db.prepare(`INSERT OR IGNORE INTO paid_ops (id, run_id, chat_id, op_key, category, label, cost_usd, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.runId, input.chatId, input.key, input.category, input.label.slice(0, 200), input.costUsd, input.result.slice(0, 200_000), Date.now());
}

export function countPaidOps(runId: string, category: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM paid_ops WHERE run_id = ? AND category = ?').get(runId, category) as any).n;
}

export function spentUsd(runId: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM paid_ops WHERE run_id = ?').get(runId) as any;
  return Math.round((r?.s ?? 0) * 10_000) / 10_000;
}

export function costBreakdown(runId: string): { category: string; count: number; usd: number }[] {
  return (db.prepare('SELECT category, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS s FROM paid_ops WHERE run_id = ? GROUP BY category ORDER BY category').all(runId) as any[])
    .map((r) => ({ category: r.category, count: r.n, usd: Math.round(r.s * 10_000) / 10_000 }));
}
