/**
 * Read-only views of a project's repository: its file tree, file contents,
 * branches, commit log, and changes (uncommitted, a branch against its base,
 * or one commit).
 *
 * Nothing here writes to the repository or takes git's optional locks, so it
 * is safe to use while a Builder is working in the same directory.
 *
 * Every path a caller names is relative to the project root and confined to it:
 * absolute paths, `..`, and anything inside `.git` are refused, and on disk the
 * resolved real path must still be inside the root, so a symlink cannot lead a
 * read out of the project. Refs are checked against a strict pattern and then
 * resolved to a commit before use, so a ref can never be read as an option or
 * as a range.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  RepoBranch, RepoBranches, RepoChangeScope, RepoChanges, RepoCommit, RepoEntry, RepoFile, RepoFileChange, RepoLog, RepoTree,
} from '../../shared/types';
import { db, getProject } from './db';

/** a file's content beyond this is cut; the viewer says so */
const FILE_CAP = 1024 * 1024;
/** one file's diff beyond this is cut */
const DIFF_FILE_CAP = 256 * 1024;
/** all diffs together beyond this: later files are listed without their diff */
const DIFF_TOTAL_CAP = 4 * 1024 * 1024;
const MAX_CHANGED_FILES = 400;
const MAX_UNTRACKED_READ = 200;
const MAX_ENTRIES = 2000;
const MAX_COMMITS = 100;
const MAX_BRANCH_COUNTS = 60;

class BrowseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------- git

interface GitOut { code: number; stdout: Buffer; stderr: string; tooLarge: boolean }

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // never contend with a Builder for index.lock: a read must not refresh the index
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
};

function gitRaw(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { timeout: 20_000, maxBuffer, encoding: 'buffer', env: GIT_ENV },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: (stderr ?? Buffer.alloc(0)).toString('utf8'),
          tooLarge: e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
  });
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await gitRaw(cwd, args);
  return r.code === 0 ? r.stdout.toString('utf8') : null;
}

/** The first `cap` bytes of a blob, without loading the rest into memory. */
function gitBlobHead(cwd: string, spec: string, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, 'cat-file', 'blob', spec], { env: GIT_ENV });
    const parts: Buffer[] = [];
    let got = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, 20_000);
    child.stdout.on('data', (b: Buffer) => {
      if (got >= cap) return;
      parts.push(b);
      got += b.length;
      if (got >= cap) child.kill('SIGKILL');
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && got < cap) return finish(null);
      finish(Buffer.concat(parts).subarray(0, cap));
    });
  });
}

async function isRepo(root: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

// ---------------------------------------------------------------- validation

/** A ref as a caller may name it: no leading dash, no colon, no whitespace, no range. */
const REF_RE = /^(?!-)[A-Za-z0-9._/@{}~^+-]{1,200}$/;

/** Resolve a caller-supplied ref to a commit id, or refuse it. */
async function resolveCommit(root: string, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..')) {
    throw new BrowseError(400, 'That is not a valid branch, tag or commit name.');
  }
  const sha = (await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim();
  if (!sha) throw new BrowseError(404, `"${ref}" is not a branch, tag or commit in this repository.`);
  return sha;
}

/**
 * A caller-supplied path, normalized to a '/'-separated path relative to the
 * project root ('' for the root itself), or refused.
 */
function cleanRel(input: unknown): string {
  if (input == null || input === '') return '';
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) {
    throw new BrowseError(400, 'Invalid path.');
  }
  const s = input.replace(/\\/g, '/');
  if (s.startsWith('/')) throw new BrowseError(400, 'Paths are relative to the project.');
  const norm = path.posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (norm === '.' || norm === '') return '';
  if (norm === '..' || norm.startsWith('../')) throw new BrowseError(400, 'That path is outside the project.');
  if (norm.split('/').includes('.git')) throw new BrowseError(403, 'Git\'s own directory is not browsable.');
  return norm;
}

/** The real on-disk location of `rel`, refused unless it is inside the root. */
function resolveInside(root: string, rel: string): string {
  let real: string;
  try { real = fs.realpathSync(path.join(root, rel)); } catch {
    throw new BrowseError(404, 'That file or folder does not exist.');
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new BrowseError(403, 'That path leads outside the project.');
  }
  if (path.relative(root, real).split(path.sep).includes('.git')) {
    throw new BrowseError(403, 'Git\'s own directory is not browsable.');
  }
  return real;
}

function projectRoot(id: string): string {
  const project = getProject(id);
  if (!project) throw new BrowseError(404, 'Project not found.');
  try { return fs.realpathSync(project.rootPath); } catch {
    throw new BrowseError(404, 'The project directory no longer exists.');
  }
}

function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

// ---------------------------------------------------------------- tree

async function workingTree(root: string, rel: string): Promise<RepoTree> {
  const dir = resolveInside(root, rel);
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (err: any) {
    if (err?.code === 'ENOTDIR') throw new BrowseError(400, 'That path is a file, not a folder.');
    throw new BrowseError(403, err?.code === 'EACCES' ? 'This folder is not readable.' : 'This folder cannot be read.');
  }
  const entries: RepoEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.git') continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    let type: RepoEntry['type'] = d.isDirectory() ? 'dir' : 'file';
    let size: number | undefined;
    if (d.isSymbolicLink()) {
      // a link is shown as what it points to, when that is inside the project
      try {
        const st = fs.statSync(resolveInside(root, childRel));
        type = st.isDirectory() ? 'dir' : 'file';
        if (st.isFile()) size = st.size;
      } catch { type = 'symlink'; }
    } else if (d.isFile()) {
      try { size = fs.statSync(path.join(dir, d.name)).size; } catch { /* vanished */ }
    } else if (!d.isDirectory()) {
      continue; // sockets, fifos, devices
    }
    entries.push({ name: d.name, path: childRel, type, ...(size != null ? { size } : {}) });
  }
  return { isRepo: await isRepo(root), ref: null, path: rel, ...capEntries(entries) };
}

async function refTree(root: string, ref: string, rel: string): Promise<RepoTree> {
  const sha = await resolveCommit(root, ref);
  const out = await git(root, ['ls-tree', '-z', '-l', `${sha}:./${rel}`]);
  if (out == null) throw new BrowseError(404, `That folder does not exist on ${ref}.`);
  const entries: RepoEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, , size] = rec.slice(0, tab).split(/\s+/);
    const name = rec.slice(tab + 1);
    const kind: RepoEntry['type'] = type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
    entries.push({
      name, path: rel ? `${rel}/${name}` : name, type: kind,
      ...(kind === 'file' && /^\d+$/.test(size) ? { size: Number(size) } : {}),
    });
  }
  return { isRepo: true, ref, path: rel, ...capEntries(entries) };
}

function capEntries(entries: RepoEntry[]): { entries: RepoEntry[]; truncated: boolean } {
  const rank = (e: RepoEntry) => (e.type === 'dir' ? 0 : e.type === 'submodule' ? 1 : 2);
  entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

// ---------------------------------------------------------------- file

async function workingFile(root: string, rel: string): Promise<RepoFile> {
  if (!rel) throw new BrowseError(400, 'Name a file.');
  const real = resolveInside(root, rel);
  const st = fs.statSync(real);
  if (st.isDirectory()) throw new BrowseError(400, 'That path is a folder, not a file.');
  if (!st.isFile()) throw new BrowseError(400, 'That is not a regular file.');
  const len = Math.min(st.size, FILE_CAP);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(real, 'r');
  try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
  return fileResult(rel, null, st.size, buf);
}

async function refFile(root: string, ref: string, rel: string): Promise<RepoFile> {
  if (!rel) throw new BrowseError(400, 'Name a file.');
  const sha = await resolveCommit(root, ref);
  const spec = `${sha}:./${rel}`;
  const type = (await git(root, ['cat-file', '-t', spec]))?.trim();
  if (!type) throw new BrowseError(404, `That file does not exist on ${ref}.`);
  if (type !== 'blob') throw new BrowseError(400, 'That path is a folder, not a file.');
  const size = Number((await git(root, ['cat-file', '-s', spec]))?.trim() ?? 0);
  const buf = await gitBlobHead(root, spec, FILE_CAP);
  if (!buf) throw new BrowseError(500, 'The file could not be read from git.');
  return fileResult(rel, ref, size, buf);
}

function fileResult(rel: string, ref: string | null, size: number, buf: Buffer): RepoFile {
  const binary = isBinary(buf);
  return {
    path: rel, ref, size, binary, truncated: size > FILE_CAP,
    ...(binary ? {} : { content: buf.toString('utf8') }),
  };
}

// ---------------------------------------------------------------- branches

/** Where ahead/behind are counted from: origin's default branch, else main or master. */
async function defaultBase(root: string, local: Set<string>, current: string | null): Promise<string | null> {
  const originHead = (await git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']))?.trim();
  if (originHead) {
    const short = originHead.replace(/^origin\//, '');
    return local.has(short) ? short : originHead;
  }
  for (const b of ['main', 'master', 'trunk', 'develop']) if (local.has(b)) return b;
  return current;
}

/** The directory git keeps a repository's shared state in, for matching worktrees to one repo. */
const commonDirCache = new Map<string, { at: number; dir: string | null }>();
async function commonDir(dir: string): Promise<string | null> {
  const hit = commonDirCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.dir;
  let resolved: string | null = null;
  if (fs.existsSync(dir)) {
    const out = (await git(dir, ['rev-parse', '--git-common-dir']))?.trim();
    if (out) { try { resolved = fs.realpathSync(path.resolve(dir, out)); } catch { /* gone */ } }
  }
  commonDirCache.set(dir, { at: Date.now(), dir: resolved });
  return resolved;
}

/** Map branch names to the Tandem chat working on each, within this repository. */
async function chatsByBranch(root: string, names: Set<string>): Promise<Map<string, { id: string; title: string }>> {
  const mine = await commonDir(root);
  const byBranch = new Map<string, { id: string; title: string }>();
  if (!mine) return byBranch;
  const rows = db.prepare('SELECT id, title, git_state FROM chats WHERE git_state IS NOT NULL ORDER BY created_at DESC').all() as
    { id: string; title: string; git_state: string }[];
  for (const r of rows) {
    let st: { workBranch?: string; repoPath?: string };
    try { st = JSON.parse(r.git_state); } catch { continue; }
    if (!st.workBranch || !names.has(st.workBranch) || byBranch.has(st.workBranch) || !st.repoPath) continue;
    if ((await commonDir(st.repoPath)) !== mine) continue;
    byBranch.set(st.workBranch, { id: r.id, title: r.title });
  }
  return byBranch;
}

async function branches(root: string, baseQuery: unknown): Promise<RepoBranches> {
  if (!(await isRepo(root))) return { isRepo: false, current: null, base: null, branches: [] };
  const out = await git(root, [
    'for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:unix)',
    'refs/heads',
  ]);
  const current = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
  const list: RepoBranch[] = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const [name, sha, subject, author, date] = line.split('\0');
    list.push({ name, current: name === current, sha, subject, author, date: Number(date) * 1000 });
  }
  const local = new Set(list.map((b) => b.name));
  let base: string | null;
  if (baseQuery) {
    await resolveCommit(root, baseQuery);
    base = baseQuery as string;
  } else {
    base = await defaultBase(root, local, current);
  }
  if (base) {
    // counted a few at a time: a repository can hold hundreds of branches
    const counted = list.filter((b) => b.name !== base).slice(0, MAX_BRANCH_COUNTS);
    for (let i = 0; i < counted.length; i += 8) {
      await Promise.all(counted.slice(i, i + 8).map(async (b) => {
        const c = (await git(root, ['rev-list', '--left-right', '--count', `${base}...${b.sha}`]))?.trim();
        const m = c?.match(/^(\d+)\s+(\d+)$/);
        if (m) { b.behind = Number(m[1]); b.ahead = Number(m[2]); }
      }));
    }
  }
  const chats = await chatsByBranch(root, local);
  for (const b of list) {
    const c = chats.get(b.name);
    if (c) { b.chatId = c.id; b.chatTitle = c.title; }
  }
  // the checked-out branch first, then the rest by recent activity
  list.sort((a, b) => Number(b.current) - Number(a.current));
  return { isRepo: true, current, base, branches: list };
}

// ---------------------------------------------------------------- log

async function log(root: string, refQuery: unknown, baseQuery: unknown): Promise<RepoLog> {
  if (!(await isRepo(root))) return { isRepo: false, ref: '', base: null, commits: [], truncated: false };
  const ref = typeof refQuery === 'string' && refQuery ? refQuery : 'HEAD';
  const sha = await resolveCommit(root, ref);
  const baseSha = baseQuery ? await resolveCommit(root, baseQuery) : null;
  const out = await git(root, [
    'log', `--format=%H%x00%s%x00%an%x00%ct`, '-n', String(MAX_COMMITS + 1),
    baseSha ? `${baseSha}..${sha}` : sha, '--',
  ]);
  const commits: RepoCommit[] = [];
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const [c, subject, author, date] = line.split('\0');
    commits.push({ sha: c, subject, author, date: Number(date) * 1000 });
  }
  return {
    isRepo: true, ref, base: baseSha ? (baseQuery as string) : null,
    commits: commits.slice(0, MAX_COMMITS), truncated: commits.length > MAX_COMMITS,
  };
}

// ---------------------------------------------------------------- changes

/** The empty tree, in whatever hash this repository uses. */
async function emptyTree(root: string): Promise<string> {
  return (await git(root, ['hash-object', '-t', 'tree', '/dev/null']))?.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

const DIFF_FLAGS = ['--relative', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];

async function changes(root: string, scopeQuery: unknown, refQuery: unknown, baseQuery: unknown): Promise<RepoChanges> {
  const scope: RepoChangeScope = scopeQuery === 'branch' || scopeQuery === 'commit' ? scopeQuery : 'working';
  const empty: RepoChanges = { isRepo: false, scope, base: null, head: null, files: [], additions: 0, deletions: 0, truncated: false };
  if (!(await isRepo(root))) return empty;

  let range: string[];
  let base: string | null;
  let head: string | null;
  if (scope === 'working') {
    const hasHead = !!(await git(root, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim();
    range = [hasHead ? 'HEAD' : await emptyTree(root)];
    base = hasHead ? 'HEAD' : null;
    head = null;
  } else if (scope === 'branch') {
    if (!refQuery) throw new BrowseError(400, 'Name the branch to compare.');
    const sha = await resolveCommit(root, refQuery);
    let baseName = typeof baseQuery === 'string' && baseQuery ? baseQuery : null;
    if (!baseName) {
      const heads = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))?.split('\n').filter(Boolean) ?? [];
      const current = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null;
      baseName = await defaultBase(root, new Set(heads), current);
    }
    if (!baseName) throw new BrowseError(400, 'There is no base branch to compare against.');
    const baseSha = await resolveCommit(root, baseName);
    // three dots: what the branch changed since it left the base, not what the
    // base has changed since
    range = [`${baseSha}...${sha}`];
    base = baseName;
    head = refQuery as string;
  } else {
    if (!refQuery) throw new BrowseError(400, 'Name the commit.');
    const sha = await resolveCommit(root, refQuery);
    const parent = (await git(root, ['rev-parse', '--verify', '-q', `${sha}^`]))?.trim();
    range = [parent || await emptyTree(root), sha];
    base = parent ? parent.slice(0, 12) : null;
    head = sha.slice(0, 12);
  }

  const r = await gitRaw(root, ['diff', ...DIFF_FLAGS, ...range, '--']);
  let files: RepoFileChange[];
  let truncated = false;
  if (r.tooLarge) {
    // too large to diff in one go: list the files with their counts, no text
    files = await numstatOnly(root, range);
    truncated = true;
  } else if (r.code !== 0) {
    throw new BrowseError(500, `git diff failed: ${r.stderr.trim().slice(0, 300)}`);
  } else {
    files = parseDiff(r.stdout.toString('utf8'));
  }
  if (scope === 'working') files.push(...untracked(root, await git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? ''));

  // cap the payload: a file count cap, then a total diff-text budget
  if (files.length > MAX_CHANGED_FILES) { files = files.slice(0, MAX_CHANGED_FILES); truncated = true; }
  let budget = DIFF_TOTAL_CAP;
  for (const f of files) {
    if (f.diff.length > DIFF_FILE_CAP) { f.diff = f.diff.slice(0, DIFF_FILE_CAP); f.truncated = true; }
    if (f.diff.length > budget) { f.diff = ''; f.truncated = true; truncated = true; }
    budget -= f.diff.length;
  }
  return {
    isRepo: true, scope, base, head, files, truncated,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

async function numstatOnly(root: string, range: string[]): Promise<RepoFileChange[]> {
  const out = await git(root, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range, '--']) ?? '';
  const files: RepoFileChange[] = [];
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    let file = p;
    let oldPath: string | undefined;
    if (p === '') { oldPath = recs[++i]; file = recs[++i]; } // -z rename: empty path, then old, then new
    files.push({
      path: file, ...(oldPath ? { oldPath } : {}), status: oldPath ? 'renamed' : 'modified',
      additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d),
      binary: a === '-', diff: '', truncated: true,
    });
  }
  return files;
}

/** Untracked files as additions, with a new-file diff built from their content. */
function untracked(root: string, listing: string): RepoFileChange[] {
  const files: RepoFileChange[] = [];
  for (const rel of listing.split('\0').filter(Boolean)) {
    if (files.length >= MAX_UNTRACKED_READ) {
      files.push({ path: rel, status: 'untracked', additions: 0, deletions: 0, binary: false, diff: '', truncated: true });
      continue;
    }
    let buf: Buffer | null = null;
    try {
      const real = resolveInside(root, rel);
      const st = fs.statSync(real);
      if (st.isFile()) {
        const len = Math.min(st.size, DIFF_FILE_CAP);
        buf = Buffer.alloc(len);
        const fd = fs.openSync(real, 'r');
        try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
      }
    } catch { /* outside the project via a link, or vanished: listed without content */ }
    if (!buf || isBinary(buf)) {
      files.push({ path: rel, status: 'untracked', additions: 0, deletions: 0, binary: !!buf, diff: '', truncated: false });
      continue;
    }
    const text = buf.toString('utf8');
    const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
    files.push({
      path: rel, status: 'untracked', additions: lines.length, deletions: 0, binary: false,
      diff: [`--- /dev/null`, `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n'),
      truncated: buf.length >= DIFF_FILE_CAP,
    });
  }
  return files;
}

/** Undo git's C-style quoting of an unusual path ("a/with\ttab"). */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p.slice(1, -1).replace(/\\(["\\tnr]|[0-7]{3})/g, (_, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : /^[0-7]{3}$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c);
}

/** Split a unified diff into one entry per file. Exported for tests. */
export function parseDiff(text: string): RepoFileChange[] {
  const files: RepoFileChange[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const lines = chunk.replace(/\n$/, '').split('\n');
    let status: RepoFileChange['status'] = 'modified';
    let minus: string | null = null;
    let plus: string | null = null;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let binary = false;
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines.slice(1)) {
      if (inHunk) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
        continue;
      }
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename from ')) { renameFrom = unquote(line.slice(12)); status = 'renamed'; }
      else if (line.startsWith('rename to ')) renameTo = unquote(line.slice(10));
      else if (line.startsWith('--- ')) minus = unquote(line.slice(4));
      else if (line.startsWith('+++ ')) plus = unquote(line.slice(4));
      else if (line.startsWith('Binary files ')) binary = true;
      else if (line.startsWith('@@')) inHunk = true;
    }
    let file = renameTo
      ?? (plus && plus !== '/dev/null' ? plus.replace(/^b\//, '') : null)
      ?? (minus && minus !== '/dev/null' ? minus.replace(/^a\//, '') : null);
    if (!file) {
      // a mode change or binary file with no ---/+++ lines: the header names
      // the same path twice, "a/<p> b/<p>", so its halves split evenly
      const rest = lines[0].slice('diff --git '.length);
      const n = (rest.length - 1) / 2;
      file = Number.isInteger(n) ? unquote(rest.slice(n + 1)).replace(/^b\//, '') : rest;
    }
    const hasHunks = lines.some((l) => l.startsWith('@@'));
    files.push({
      path: file, ...(renameFrom ? { oldPath: renameFrom } : {}), status, additions, deletions, binary,
      diff: hasHunks ? lines.slice(lines.findIndex((l) => l.startsWith('--- ') || l.startsWith('@@'))).join('\n') : '',
      truncated: false,
    });
  }
  return files;
}

// ---------------------------------------------------------------- resolve a mention

const MAX_EXPANSIONS = 64;
const MAX_MATCHES = 200;

/** `a/{x,y}.log` → `a/x.log`, `a/y.log` — every brace group, capped */
function expandBraces(p: string): string[] {
  let out = [p];
  for (let guard = 0; guard < 8; guard++) {
    const next: string[] = [];
    let changed = false;
    for (const s of out) {
      const m = s.match(/\{([^{}]*)\}/);
      if (!m || m.index == null) { next.push(s); continue; }
      changed = true;
      for (const alt of m[1].split(',')) next.push(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length));
      if (next.length > MAX_EXPANSIONS) break;
    }
    out = next.slice(0, MAX_EXPANSIONS);
    if (!changed) break;
  }
  return out;
}

function globRe(seg: string): RegExp {
  return new RegExp(`^${seg.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** Paths under the root matching a relative pattern whose segments may hold * or ? */
function globMatch(root: string, rel: string): RepoEntry[] {
  let frontier = [''];
  const segs = rel.split('/').filter(Boolean);
  for (let i = 0; i < segs.length && frontier.length > 0; i++) {
    const seg = segs[i];
    const next: string[] = [];
    for (const base of frontier) {
      if (!/[*?]/.test(seg)) { next.push(base ? `${base}/${seg}` : seg); continue; }
      let names: string[] = [];
      try { names = fs.readdirSync(resolveInside(root, base)); } catch { continue; }
      const re = globRe(seg);
      for (const n of names) if (n !== '.git' && re.test(n)) next.push(base ? `${base}/${n}` : n);
      if (next.length > MAX_MATCHES) break;
    }
    frontier = next.slice(0, MAX_MATCHES);
  }
  return frontier.flatMap((r) => { const e = entryAt(root, r); return e ? [e] : []; });
}

function entryAt(root: string, rel: string): RepoEntry | null {
  try {
    const clean = cleanRel(rel);
    const st = fs.statSync(resolveInside(root, clean));
    return { name: path.posix.basename(clean) || clean, path: clean, type: st.isDirectory() ? 'dir' : 'file', ...(st.isFile() ? { size: st.size } : {}) };
  } catch { return null; }
}

/**
 * Turn a file mention from the chat into files in this project. It accepts what
 * agents write: `a/b.ts`, `a/b.ts:120`, `a/b.ts:120:4`, `./a`, an absolute path
 * inside the project, brace lists `{x,y}` and `*`/`?` wildcards. A path that is
 * not found from the root is looked up as a suffix of the project's files, so
 * `src/app.ts` still finds `web/src/app.ts`. Nothing outside the project is
 * ever returned.
 */
async function resolveMention(root: string, raw: unknown): Promise<{ matches: RepoEntry[]; line?: number; col?: number }> {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || raw.includes('\0')) throw new BrowseError(400, 'Name a file.');
  let q = raw.trim().replace(/^[`'"(]+|[`'")\].,;]+$/g, '');
  let line: number | undefined;
  let col: number | undefined;
  const lc = q.match(/:(\d+)(?::(\d+))?$/);
  if (lc) { line = Number(lc[1]); col = lc[2] ? Number(lc[2]) : undefined; q = q.slice(0, lc.index); }
  q = q.replace(/#L(\d+).*$/, (_, n: string) => { line = Number(n); return ''; });
  if (path.isAbsolute(q)) {
    const rel = path.relative(root, path.resolve(q));
    if (!rel || rel.startsWith('..')) {
      // the project may be reached through a symlinked path; compare real paths too
      let real = '';
      try { real = fs.realpathSync(q); } catch { /* does not exist */ }
      const relReal = real ? path.relative(root, real) : '..';
      if (!relReal || relReal.startsWith('..')) return { matches: [] };
      q = relReal;
    } else q = rel;
  }
  q = q.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const seen = new Set<string>();
  const matches: RepoEntry[] = [];
  const add = (e: RepoEntry) => { if (!seen.has(e.path) && matches.length < MAX_MATCHES) { seen.add(e.path); matches.push(e); } };
  const candidates = expandBraces(q);
  for (const c of candidates) {
    let clean: string;
    try { clean = cleanRel(c); } catch { continue; } // '..' and .git are never resolved
    if (/[*?]/.test(clean)) globMatch(root, clean).forEach(add);
    else { const e = entryAt(root, clean); if (e) add(e); }
  }
  if (matches.length === 0 && (await isRepo(root))) {
    // written relative to some subfolder: find it by suffix among the project's files
    const listing = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    if (listing) {
      const files = listing.split('\0').filter(Boolean);
      for (const c of candidates) {
        let clean: string;
        try { clean = cleanRel(c); } catch { continue; }
        if (!clean || /[*?]/.test(clean)) continue;
        for (const f of files) {
          if (f === clean || f.endsWith(`/${clean}`)) { const e = entryAt(root, f); if (e) add(e); }
          if (matches.length >= 20) break;
        }
      }
    }
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return { matches, ...(line ? { line } : {}), ...(col ? { col } : {}) };
}

// ---------------------------------------------------------------- routes

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BrowseError) return reply.code(err.status).send({ error: err.message });
  return reply.code(500).send({ error: `Could not read the repository: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
}

export function registerRepoBrowseRoutes(app: FastifyInstance): void {
  type Q = { path?: string; ref?: string; base?: string; scope?: string; q?: string };
  const handler = (fn: (root: string, q: Q) => Promise<unknown>) => async (req: any, reply: FastifyReply) => {
    try {
      return await fn(projectRoot(req.params.id), (req.query ?? {}) as Q);
    } catch (err) {
      return fail(reply, err);
    }
  };

  app.get('/api/projects/:id/repo/tree', handler((root, q) => {
    const rel = cleanRel(q.path);
    return q.ref ? refTree(root, q.ref, rel) : workingTree(root, rel);
  }));
  app.get('/api/projects/:id/repo/file', handler((root, q) => {
    const rel = cleanRel(q.path);
    return q.ref ? refFile(root, q.ref, rel) : workingFile(root, rel);
  }));
  app.get('/api/projects/:id/repo/branches', handler((root, q) => branches(root, q.base)));
  app.get('/api/projects/:id/repo/log', handler((root, q) => log(root, q.ref, q.base)));
  app.get('/api/projects/:id/repo/changes', handler((root, q) => changes(root, q.scope, q.ref, q.base)));
  app.get('/api/projects/:id/repo/resolve', handler((root, q) => resolveMention(root, q.q)));
}
