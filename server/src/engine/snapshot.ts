import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeState {
  kind: 'git' | 'fs' | 'missing';
  hash: string;
  /** currently modified/untracked paths (git) or path→signature map (fs) */
  files: Map<string, string>;
}

const md5 = (s: string | Uint8Array) => createHash('md5').update(s).digest('hex');

/**
 * Objective snapshot of a working tree, used to decide — from resulting state,
 * never predicted intent — whether the Reviewer needs to run.
 */
export function captureWorktree(dir: string): WorktreeState {
  if (!fs.existsSync(dir)) return { kind: 'missing', hash: 'missing', files: new Map() };

  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      const porcelain = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).toString();
      const diff = execFileSync('git', ['-C', dir, 'diff', 'HEAD'], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }).toString();
      const files = new Map<string, string>();
      for (const line of porcelain.split('\n')) {
        if (!line.trim()) continue;
        const status = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        files.set(file, status);
      }
      return { kind: 'git', hash: md5(porcelain + '\0' + md5(diff)), files };
    } catch { /* fall through to fs walk */ }
  }

  const files = new Map<string, string>();
  let count = 0;
  const walk = (d: string) => {
    if (count > 20_000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.tandem-extract') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        count += 1;
        try {
          const st = fs.statSync(full);
          files.set(path.relative(dir, full), `${st.size}:${st.mtimeMs}`);
        } catch { /* raced */ }
      }
    }
  };
  walk(dir);
  const serial = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, s]) => `${f}|${s}`).join('\n');
  return { kind: 'fs', hash: md5(serial), files };
}

/**
 * Identity of the worktree's CONTENT, for the review ledger. `hash` is
 * porcelain + `git diff HEAD`, and `git diff HEAD` never sees the content of an
 * untracked file — a new file rewritten with different content keeps the same
 * hash. Untracked files enter here by size+mtime, the signature the non-git
 * walk already uses: a rewrite that changes neither is not one the ledger needs
 * to tell apart from a no-op, and any real rewrite is a new revision.
 */
export function revisionHash(dir: string, state: WorktreeState): string {
  if (state.kind !== 'git') return state.hash;
  try {
    const others = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
      .toString().split('\0').filter(Boolean).sort();
    const sig = others.map((f) => {
      try { const st = fs.statSync(path.join(dir, f)); return `${f}|${st.size}:${st.mtimeMs}`; } catch { return `${f}|gone`; }
    }).join('\n');
    return md5(state.hash + '\n' + sig);
  } catch { return state.hash; }
}

/** Objective facts only — the Reviewer-facing wording lives in prompts.ts. */
export type DeltaNoteKind = 'git' | 'git_state' | 'nongit';

export interface WorktreeDelta {
  changed: boolean;
  /** changed-path list for the Reviewer (capped) */
  files: string[];
  noteKind: DeltaNoteKind;
}

export function diffWorktrees(before: WorktreeState, after: WorktreeState): WorktreeDelta {
  const changed = before.hash !== after.hash || before.kind !== after.kind;
  if (!changed) return { changed: false, files: [], noteKind: 'nongit' };

  if (after.kind === 'git') {
    const files = [...after.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100);
    return { changed: true, files, noteKind: files.length > 0 ? 'git' : 'git_state' };
  }
  const files: string[] = [];
  for (const [f, sig] of after.files) {
    if (before.files.get(f) !== sig) files.push(f);
    if (files.length >= 100) break;
  }
  for (const [f] of before.files) {
    if (!after.files.has(f)) files.push(`(deleted) ${f}`);
    if (files.length >= 100) break;
  }
  return { changed: true, files, noteKind: 'nongit' };
}

// ---------------------------------------------------------------- repair scope

/** files bigger than this are identified by size alone; hashing them is not worth it */
const HASH_MAX_BYTES = 2 * 1024 * 1024;
/** upper bound on files considered, so a huge tree cannot stall a review */
const SIG_MAX_FILES = 2_000;

/**
 * Content signatures for the files a review cares about, at one instant.
 *
 * `captureWorktree` answers "did anything change at all" and is keyed on git
 * porcelain, which cannot tell one edit of a file from a second edit of the
 * same file — both leave status `M`. A repair review needs the narrower
 * question "what changed since the state the Reviewer already judged", so this
 * signs CONTENT. An eight-line repair to a file that was already modified is
 * invisible to porcelain and obvious here.
 *
 * A git repo asks git which files are interesting (tracked plus
 * untracked-not-ignored), keeping build output and vendored trees out. A
 * workspace with no repository walks the tree exactly as captureWorktree's
 * non-git branch does. Nothing here creates or writes to a repository.
 */
export function signatureMap(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;

  const sign = (rel: string) => {
    if (out.size >= SIG_MAX_FILES) return;
    const full = path.join(dir, rel);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return;
      out.set(rel, st.size > HASH_MAX_BYTES ? `big:${st.size}` : md5(fs.readFileSync(full)));
    } catch { /* raced or unreadable — absent is the honest signature */ }
  };

  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      const listed = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
      for (const rel of listed) sign(rel);
      return out;
    } catch { /* fall through to the walk */ }
  }

  let count = 0;
  const walk = (d: string) => {
    if (count > 20_000 || out.size >= SIG_MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.tandem-extract') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { count += 1; sign(path.relative(dir, full)); }
    }
  };
  walk(dir);
  return out;
}

/** paths added, modified or deleted between two signature maps */
export function changedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [f, sig] of after) {
    const prev = before.get(f);
    if (prev === undefined) changed.push(`(added) ${f}`);
    else if (prev !== sig) changed.push(f);
  }
  for (const [f] of before) if (!after.has(f)) changed.push(`(deleted) ${f}`);
  return changed.sort();
}

/**
 * The real diff for specific paths, plus an honest note when there is none.
 *
 * Two cases produce no diff for a path that genuinely changed, and they are not
 * the same thing: the workspace has no repository at all, or the path is
 * untracked and so has no committed baseline. `git diff HEAD` is silent about
 * the second, which once made this report "no git repository" to a Reviewer
 * standing in one. Tracked paths are diffed against HEAD; untracked ones are
 * diffed against /dev/null, which shows the new file without touching the
 * index. Nothing here creates a repository or stages anything.
 */
export function diffForPaths(dir: string, paths: string[], maxChars: number): { text: string | null; note: string } {
  if (paths.length === 0) return { text: null, note: '(no file content changed since the reviewed state, so there is nothing to diff)' };
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return {
      text: null,
      note: '(this workspace has no git repository, so no independent diff can be produced. The paths above are '
        + "content-hash comparisons and are trustworthy; the hand-off above is the Builder's own claim and is not)",
    };
  }
  const clean = paths.map((p) => p.replace(/^\((?:added|deleted)\) /, '')).slice(0, 50);
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }).toString();
    } catch (err: any) {
      // `git diff --no-index` exits 1 when the files differ, which is the
      // normal case here — the diff is still on stdout.
      return typeof err?.stdout === 'string' ? err.stdout : (err?.stdout?.toString?.() ?? '');
    }
  };
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const rel of clean) {
    try {
      execFileSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', rel], { timeout: 10_000, stdio: 'ignore' });
      tracked.push(rel);
    } catch { untracked.push(rel); }
  }
  const chunks: string[] = [];
  if (tracked.length > 0) {
    const t = git(['diff', 'HEAD', '--', ...tracked]);
    if (t.trim()) chunks.push(t);
  }
  for (const rel of untracked.slice(0, 20)) {
    const u = git(['diff', '--no-index', '--', '/dev/null', rel]);
    if (u.trim()) chunks.push(u);
  }
  if (chunks.length === 0) {
    return { text: null, note: '(git produced no diff for these paths — they may have been deleted, or changed only in mode or metadata)' };
  }
  const text = chunks.join('\n');
  return {
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… diff truncated at ${maxChars} characters …` : text,
    note: '',
  };
}
