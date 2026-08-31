import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DirListing, Project } from '../../shared/types';
import { config } from './config';
import { db, getProject, rowToProject } from './db';
import { broadcast } from './sse';
import { getGitStatus } from './git';

const FORBIDDEN_PREFIXES = ['/proc', '/sys', '/dev', '/etc', '/boot', '/run'];

export function findOrCreateProject(rootPath: string, source: Project['source']): Project {
  const resolved = path.resolve(rootPath);
  const existing = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(resolved);
  if (existing) {
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), (existing as any).id);
    const project = rowToProject({ ...(existing as any), last_opened_at: Date.now() });
    broadcast({ type: 'project', project });
    return project;
  }
  const now = Date.now();
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, root_path, source, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, path.basename(resolved) || resolved, resolved, source, now, now);
  // serialize through rowToProject like every other path — it alone computes
  // `hidden`, and a create-path literal once leaked worktree projects into
  // connected sidebars until the next full fetch re-filtered them
  const project = rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
  broadcast({ type: 'project', project });
  return project;
}

function validDirectory(p: string): string | null {
  if (!p || !path.isAbsolute(p)) return 'Path must be absolute.';
  const resolved = path.resolve(p);
  if (resolved === '/') return 'The filesystem root cannot be a project.';
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (resolved === forbidden || resolved.startsWith(forbidden + '/')) return `Directories under ${forbidden} cannot be used.`;
  }
  let st: fs.Stats;
  try { st = fs.statSync(resolved); } catch { return 'Directory does not exist or is not readable.'; }
  if (!st.isDirectory()) return 'Path is not a directory.';
  return null;
}

/** Guard for mutating operations (mkdir target parent excluded — see mkdir). */
function guardMutablePath(p: string): string | null {
  const base = validDirectory(p);
  if (base) return base;
  const resolved = path.resolve(p);
  if (resolved.split('/').filter(Boolean).length < 2) {
    return 'Top-level system directories cannot be modified here.';
  }
  const protectedPaths = [config.dataDir, config.projectsDir, process.cwd()];
  for (const prot of protectedPaths.map((x) => path.resolve(x))) {
    if (resolved === prot) return 'This directory is managed by Tandem and cannot be modified.';
    if (prot.startsWith(resolved + '/')) return 'This directory contains Tandem\'s own data and cannot be modified.';
  }
  return null;
}

function validFolderName(name: string): string | null {
  const clean = (name ?? '').trim();
  if (!clean) return 'Enter a folder name.';
  if (clean === '.' || clean === '..') return 'That name is not allowed.';
  if (clean.length > 80) return 'Folder names are limited to 80 characters.';
  if (/[/\0]/.test(clean)) return 'Folder names cannot contain slashes.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(clean)) return 'Folder names cannot contain control characters.';
  return null;
}

function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY last_opened_at DESC').all();
    return rows.map(rowToProject); // rowToProject marks Director worktrees hidden
  });

  app.post('/api/projects/open', async (req, reply) => {
    const { id } = req.body as { id: string };
    const project = getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true };
  });

  // -------------------------------------------------- choose working directory

  app.post('/api/projects/directory', async (req, reply) => {
    const { dirPath } = req.body as { dirPath: string };
    const problem = validDirectory(dirPath ?? '');
    if (problem) return reply.code(400).send({ error: problem });
    return findOrCreateProject(dirPath, 'directory');
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
      writable: isWritable(resolved),
      quickLinks: [
        { name: 'projects', path: config.projectsDir },
        { name: 'srv', path: '/srv' },
        { name: 'home', path: process.env.HOME || '/home' },
        { name: 'root fs', path: '/' },
      ].filter((l) => fs.existsSync(l.path)),
    };
    return listing;
  });

  app.post('/api/fs/mkdir', async (req, reply) => {
    const { parent, name } = (req.body ?? {}) as { parent?: string; name?: string };
    const parentProblem = validDirectory(parent ?? '');
    if (parentProblem) return reply.code(400).send({ error: parentProblem });
    const nameProblem = validFolderName(name ?? '');
    if (nameProblem) return reply.code(400).send({ error: nameProblem });
    const target = path.join(path.resolve(parent!), name!.trim());
    if (fs.existsSync(target)) return reply.code(409).send({ error: `"${name!.trim()}" already exists here.` });
    if (!isWritable(path.resolve(parent!))) return reply.code(403).send({ error: 'This directory is not writable.' });
    try {
      fs.mkdirSync(target);
    } catch (err: any) {
      return reply.code(500).send({ error: `Could not create the folder: ${err?.code ?? err}` });
    }
    return { name: name!.trim(), path: target };
  });

  app.post('/api/fs/rename', async (req, reply) => {
    const { dirPath, name } = (req.body ?? {}) as { dirPath?: string; name?: string };
    const problem = guardMutablePath(dirPath ?? '');
    if (problem) return reply.code(400).send({ error: problem });
    const nameProblem = validFolderName(name ?? '');
    if (nameProblem) return reply.code(400).send({ error: nameProblem });
    const src = path.resolve(dirPath!);
    const dest = path.join(path.dirname(src), name!.trim());
    if (dest === src) return { path: src };
    if (fs.existsSync(dest)) return reply.code(409).send({ error: `"${name!.trim()}" already exists here.` });
    if (!isWritable(path.dirname(src))) return reply.code(403).send({ error: 'The parent directory is not writable.' });
    try {
      fs.renameSync(src, dest);
    } catch (err: any) {
      return reply.code(500).send({ error: `Rename failed: ${err?.code ?? err}` });
    }
    // keep projects pointing at the moved directory (exact match and descendants)
    const affected = db.prepare("SELECT * FROM projects WHERE root_path = ? OR root_path LIKE ? ESCAPE '\\'")
      .all(src, `${src.replace(/[%_\\]/g, (m) => `\\${m}`)}/%`) as any[];
    for (const row of affected) {
      const newRoot = row.root_path === src ? dest : dest + row.root_path.slice(src.length);
      const newName = row.root_path === src ? path.basename(dest) : row.name;
      db.prepare('UPDATE projects SET root_path = ?, name = ? WHERE id = ?').run(newRoot, newName, row.id);
      broadcast({ type: 'project', project: rowToProject({ ...row, root_path: newRoot, name: newName }) });
    }
    return { path: dest, updatedProjects: affected.length };
  });

  app.post('/api/fs/delete', async (req, reply) => {
    const { dirPath, force } = (req.body ?? {}) as { dirPath?: string; force?: boolean };
    const problem = guardMutablePath(dirPath ?? '');
    if (problem) return reply.code(400).send({ error: problem });
    const resolved = path.resolve(dirPath!);
    let entries: string[];
    try {
      entries = fs.readdirSync(resolved);
    } catch (err: any) {
      return reply.code(500).send({ error: `Cannot read the folder: ${err?.code ?? err}` });
    }
    if (entries.length > 0 && !force) {
      return reply.code(409).send({
        error: 'Folder is not empty',
        requiresConfirm: true,
        entries: entries.length,
        name: path.basename(resolved),
      });
    }
    if (!isWritable(path.dirname(resolved))) return reply.code(403).send({ error: 'The parent directory is not writable.' });
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (err: any) {
      return reply.code(500).send({ error: `Delete failed: ${err?.code ?? err}` });
    }
    return { ok: true, deleted: resolved, wasEmpty: entries.length === 0 };
  });

  // -------------------------------------------------- git status

  app.get('/api/projects/:id/git', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return getGitStatus(project.rootPath);
  });
}
