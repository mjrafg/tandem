/**
 * Files an agent hands to the user: a report, an export, an archive, a
 * generated image or voice clip — anything the work produced as a file.
 *
 * Sharing COPIES the file, at the moment it is shared. That is deliberate:
 *   - a Director session's worktree is deleted when its project completes, so
 *     a link into it would quietly break;
 *   - the user gets exactly the file they were given, even if the agent
 *     edits or deletes it afterwards.
 *
 * Only a regular file inside the chat's own directory can be shared. The path
 * checks are the file browser's (repoBrowse), so there is one implementation
 * of "inside the project"; on top of that the copy opens the file refusing to
 * follow a symlink, so a file swapped for a link between the check and the
 * copy is refused rather than read.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { db, getChat } from './db';
import { BrowseError, cleanRel, projectRoot, resolveInside } from './repoBrowse';

export const MAX_DELIVERABLE_BYTES = 200 * 1024 * 1024; // the same ceiling as an upload
/** text handed over inline travels inside one tool call, so it is kept smaller */
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const store = path.join(config.dataDir, 'deliverables');

db.exec(`CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_deliverables_chat ON deliverables(chat_id)');

export class DeliverableError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Deliverable {
  id: string;
  chatId: string;
  name: string;
  /** where it was shared from, relative to the chat's directory */
  sourcePath: string;
  size: number;
  sha256: string;
  mime: string;
  note: string;
  createdAt: number;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', js: 'text/javascript', css: 'text/css',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * What a browser may show inside the page: raster images, audio and video.
 * Never HTML, SVG, XML or script — served from Tandem's own origin those would
 * run with the user's session. Everything else is only ever a download.
 */
export const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/opus',
  'video/mp4', 'video/webm',
]);

/** types that must never reach the browser labelled as what they are */
const ACTIVE = new Set(['text/html', 'image/svg+xml', 'application/xml', 'text/javascript', 'text/css']);

export function mimeFor(name: string): string {
  return MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** the type to send for a download: active content goes out as opaque bytes */
export function downloadType(mime: string): string {
  return ACTIVE.has(mime) ? 'application/octet-stream' : mime;
}

/** a file name that is safe on any disk and in a header: no path, no control characters */
function safeName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f/]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return clean || 'file';
}

function row(r: any): Deliverable {
  return {
    id: r.id, chatId: r.chat_id, name: r.name, sourcePath: r.source_path, size: r.size,
    sha256: r.sha256, mime: r.mime, note: r.note, createdAt: r.created_at,
  };
}

/**
 * The agent names a file; the user gets a copy of it. `rawPath` may be
 * relative to the chat's directory or absolute inside it.
 */
export async function shareFile(chatId: string, rawPath: unknown, opts: { name?: unknown; note?: unknown } = {}): Promise<Deliverable> {
  const chat = getChat(chatId);
  if (!chat) throw new DeliverableError(404, 'This chat does not exist.');
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new DeliverableError(400, 'Name the file to share.');

  let root: string;
  let real: string;
  let rel: string;
  try {
    root = projectRoot(chat.projectId);
    let given = rawPath.trim();
    if (path.isAbsolute(given)) {
      // an absolute path is fine when it is inside the chat's directory; it may
      // reach it through a symlink (macOS /tmp is /private/tmp), so compare real paths
      let abs = path.resolve(given);
      try { abs = fs.realpathSync(abs); } catch { /* resolveInside reports a missing file */ }
      const inside = path.relative(root, abs);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        throw new DeliverableError(403, 'Only a file inside this chat\'s working directory can be shared.');
      }
      given = inside.split(path.sep).join('/');
    }
    rel = cleanRel(given);
    if (!rel) throw new DeliverableError(400, 'That is the working directory itself — name a file inside it.');
    real = resolveInside(root, rel);
  } catch (err) {
    if (err instanceof BrowseError) throw new DeliverableError(err.status, err.message);
    throw err;
  }

  // open without following a link, then trust only the open handle
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new DeliverableError(403, 'That file was replaced by a link while it was being shared, so it was not shared.');
    if (code === 'EISDIR') throw new DeliverableError(400, 'That is a folder. Share a file — zip the folder first if you need all of it.');
    throw new DeliverableError(400, `The file could not be opened: ${code ?? String(err)}.`);
  }
  const id = randomUUID();
  const dir = path.join(store, id);
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) throw new DeliverableError(400, 'That is a folder. Share a file — zip the folder first if you need all of it.');
    if (!st.isFile()) throw new DeliverableError(400, 'Only a regular file can be shared.');
    if (st.size > MAX_DELIVERABLE_BYTES) {
      throw new DeliverableError(413, `That file is ${(st.size / 1048576).toFixed(0)} MB; the limit is ${MAX_DELIVERABLE_BYTES / 1048576} MB.`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const src = fs.createReadStream('', { fd, autoClose: false });
      const dst = fs.createWriteStream(path.join(dir, 'file'));
      src.on('data', (chunk) => {
        size += chunk.length;
        hash.update(chunk);
        if (size > MAX_DELIVERABLE_BYTES) src.destroy(new DeliverableError(413, 'The file grew past the limit while it was being shared.'));
      });
      // a failed read must not leave the half-written copy open
      src.on('error', (e) => { dst.destroy(); reject(e); });
      dst.on('error', (e) => { src.destroy(); reject(e); });
      dst.on('finish', () => resolve());
      src.pipe(dst);
    });
    const name = safeName(typeof opts.name === 'string' && opts.name.trim() ? opts.name : path.basename(real));
    const d: Deliverable = {
      id, chatId, name, sourcePath: rel, size, sha256: hash.digest('hex'), mime: mimeFor(name),
      note: typeof opts.note === 'string' ? opts.note.trim().slice(0, 300) : '', createdAt: Date.now(),
    };
    db.prepare(`INSERT INTO deliverables (id, chat_id, name, source_path, size, sha256, mime, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.id, d.chatId, d.name, d.sourcePath, d.size, d.sha256, d.mime, d.note, d.createdAt);
    return d;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Text the agent wrote, stored as a file Tandem creates — never written into
 * the project. This is how a read-only role (a Reviewer, the Director) hands
 * over a report or a log without its access to the project changing.
 */
export function shareContent(chatId: string, content: unknown, opts: { name?: unknown; note?: unknown } = {}): Deliverable {
  if (!getChat(chatId)) throw new DeliverableError(404, 'This chat does not exist.');
  if (typeof content !== 'string') throw new DeliverableError(400, 'content must be text.');
  if (typeof opts.name !== 'string' || !opts.name.trim()) {
    throw new DeliverableError(400, 'Give the file a name, with its extension (e.g. "review.md"), when sharing content.');
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_CONTENT_BYTES) {
    throw new DeliverableError(413, `That content is ${(bytes.length / 1048576).toFixed(1)} MB; the limit for content is ${MAX_CONTENT_BYTES / 1048576} MB. Write it to a file and share the file instead.`);
  }
  const id = randomUUID();
  const dir = path.join(store, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'file'), bytes);
    const name = safeName(opts.name);
    const d: Deliverable = {
      id, chatId, name, sourcePath: '', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: mimeFor(name), note: typeof opts.note === 'string' ? opts.note.trim().slice(0, 300) : '', createdAt: Date.now(),
    };
    db.prepare(`INSERT INTO deliverables (id, chat_id, name, source_path, size, sha256, mime, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.id, d.chatId, d.name, d.sourcePath, d.size, d.sha256, d.mime, d.note, d.createdAt);
    return d;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function getDeliverable(id: string): Deliverable | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id);
  return r ? row(r) : null;
}

export function deliverablePath(d: Deliverable): string {
  return path.join(store, d.id, 'file');
}

/** A deleted chat takes its shared files with it. */
export function deleteDeliverables(chatId: string): void {
  for (const r of db.prepare('SELECT id FROM deliverables WHERE chat_id = ?').all(chatId) as { id: string }[]) {
    fs.rmSync(path.join(store, r.id), { recursive: true, force: true });
  }
  db.prepare('DELETE FROM deliverables WHERE chat_id = ?').run(chatId);
}
