import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import type { DirListing, Project } from '../../shared/types';
import { config } from './config';
import { db, getProject, rowToProject } from './db';
import { broadcast } from './sse';
import { getGitStatus } from './git';

const execFileP = promisify(execFile);

const MAX_ZIP_BYTES = 400 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 40_000;

function insertProject(name: string, rootPath: string, source: Project['source']): Project {
  const now = Date.now();
  const project: Project = { id: randomUUID(), name, rootPath, source, createdAt: now, lastOpenedAt: now };
  db.prepare('INSERT INTO projects (id, name, root_path, source, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(project.id, name, rootPath, source, now, now);
  broadcast({ type: 'project', project });
  return project;
}

/** unique directory under the managed projects root */
function managedTarget(baseName: string): string {
  const safe = baseName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project';
  let target = path.join(config.projectsDir, safe);
  let i = 2;
  while (fs.existsSync(target)) target = path.join(config.projectsDir, `${safe}-${i++}`);
  return target;
}

function validDirectory(p: string): string | null {
  if (!path.isAbsolute(p)) return 'Path must be absolute.';
  const resolved = path.resolve(p);
  if (resolved === '/' ) return 'The filesystem root cannot be a project.';
  for (const forbidden of ['/proc', '/sys', '/dev', '/etc', '/boot', '/run']) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/')) return `Directories under ${forbidden} cannot be projects.`;
  }
  let st: fs.Stats;
  try { st = fs.statSync(resolved); } catch { return 'Directory does not exist or is not readable.'; }
  if (!st.isDirectory()) return 'Path is not a directory.';
  return null;
}

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY last_opened_at DESC').all();
    return rows.map(rowToProject);
  });

  app.post('/api/projects/open', async (req, reply) => {
    const { id } = req.body as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true };
  });

  // -------------------------------------------------- existing directory

  app.post('/api/projects/directory', async (req, reply) => {
    const { dirPath } = req.body as { dirPath: string };
    const problem = validDirectory(dirPath ?? '');
    if (problem) return reply.code(400).send({ error: problem });
    const resolved = path.resolve(dirPath);
    const existing = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(resolved);
    if (existing) {
      db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), (existing as any).id);
      return rowToProject(existing);
    }
    return insertProject(path.basename(resolved), resolved, 'directory');
  });

  // -------------------------------------------------- directory browser

  app.get('/api/fs/list', async (req, reply) => {
    const q = (req.query as { path?: string }).path || '/';
    if (!path.isAbsolute(q)) return reply.code(400).send({ error: 'Path must be absolute.' });
    const resolved = path.resolve(q);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err: any) {
      return reply.code(400).send({ error: err?.code === 'EACCES' ? 'Not readable (permission denied).' : 'Directory cannot be read.' });
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 400);
    const listing: DirListing = {
      path: resolved,
      parent: resolved === '/' ? null : path.dirname(resolved),
      dirs,
      quickLinks: [
        { name: 'projects', path: config.projectsDir },
        { name: 'srv', path: '/srv' },
        { name: 'home', path: process.env.HOME || '/home' },
        { name: 'root fs', path: '/' },
      ].filter((l) => fs.existsSync(l.path)),
    };
    return listing;
  });

  // -------------------------------------------------- zip import

  app.post('/api/projects/zip', async (req, reply) => {
    const file = await (req as any).file({ limits: { fileSize: MAX_ZIP_BYTES } });
    if (!file) return reply.code(400).send({ error: 'No file uploaded.' });
    const buf = await file.toBuffer();
    const baseName = (file.filename || 'project.zip').replace(/\.zip$/i, '');

    let zip: AdmZip;
    try { zip = new AdmZip(buf); } catch { return reply.code(400).send({ error: 'Not a valid ZIP archive.' }); }
    const entries = zip.getEntries();
    if (entries.length === 0) return reply.code(400).send({ error: 'The archive is empty.' });
    if (entries.length > MAX_ZIP_ENTRIES) return reply.code(400).send({ error: `Too many entries (${entries.length} > ${MAX_ZIP_ENTRIES}).` });

    // single top-level folder collapses into the project root
    const roots = new Set(entries.map((e) => e.entryName.split('/')[0]));
    const collapse = roots.size === 1 && entries.every((e) => e.entryName.includes('/')) ? `${[...roots][0]}/` : '';

    const target = managedTarget(collapse ? [...roots][0] : baseName);
    fs.mkdirSync(target, { recursive: true });

    let total = 0;
    for (const entry of entries) {
      const rel = collapse && entry.entryName.startsWith(collapse) ? entry.entryName.slice(collapse.length) : entry.entryName;
      if (!rel) continue;
      const dest = path.resolve(target, rel);
      if (!dest.startsWith(target + path.sep) && dest !== target) {
        fs.rmSync(target, { recursive: true, force: true });
        return reply.code(400).send({ error: `Unsafe path in archive: ${entry.entryName}` });
      }
      if (entry.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      const data = entry.getData();
      total += data.length;
      if (total > MAX_ZIP_BYTES) {
        fs.rmSync(target, { recursive: true, force: true });
        return reply.code(400).send({ error: 'Archive expands beyond the 400 MB limit.' });
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    const project = insertProject(path.basename(target), target, 'zip');
    return { ...project, imported: { files: entries.filter((e) => !e.isDirectory).length, bytes: total } };
  });

  // -------------------------------------------------- git clone

  app.post('/api/projects/git', async (req, reply) => {
    const { url } = req.body as { url: string };
    const clean = (url ?? '').trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(clean)) {
      return reply.code(400).send({ error: 'That does not look like a git URL (https://…, git@…, or ssh://…).' });
    }
    const baseName = clean.split('/').pop()?.replace(/\.git$/, '') || 'repository';
    const target = managedTarget(baseName);
    try {
      const { stdout, stderr } = await execFileP('git', ['clone', '--progress', clean, target], {
        timeout: 5 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const project = insertProject(path.basename(target), target, 'git');
      return { ...project, cloneOutput: tail(stderr || stdout, 30) };
    } catch (err: any) {
      fs.rmSync(target, { recursive: true, force: true });
      const output = tail(String(err?.stderr || err?.message || err), 30);
      return reply.code(502).send({ error: 'git clone failed', output });
    }
  });

  // -------------------------------------------------- git status

  app.get('/api/projects/:id/git', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return getGitStatus(project.rootPath);
  });
}

function tail(s: string, lines: number): string {
  const all = s.split('\n').filter((l) => l.trim().length > 0);
  return all.slice(-lines).join('\n');
}
