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
 * The state a review judged, kept so the NEXT round can diff against it.
 *
 * Two things defeat a naive comparison. A repair that commits moves HEAD, so
 * `git diff HEAD` shows nothing and the Reviewer is told "no diff" about a file
 * it can see changed. And a file that was untracked at review time has no
 * baseline in git at all, so it either looks new or looks like nothing. This
 * records the commit the review saw, and takes private copies of exactly the
 * files git cannot baseline — untracked ones, or every file when the workspace
 * has no repository. Copies live outside the project, are bounded, and are
 * deleted as soon as the diff is built.
 */
export interface ReviewBaseline {
  /** HEAD when the review ran; null when the workspace is not a repository */
  head: string | null;
  signatures: Map<string, string>;
  /** private copies of files git cannot baseline, or null when none were taken */
  copiesDir: string | null;
  copied: Set<string>;
  /** the copy budget ran out, so some baselines are genuinely missing */
  truncated: boolean;
}

/** files copied for baselining, and the per-file ceiling */
const COPY_MAX_FILES = 300;
const COPY_MAX_BYTES = 256 * 1024;

export function captureReviewBaseline(dir: string, tmpRoot: string): ReviewBaseline {
  const signatures = signatureMap(dir);
  let head: string | null = null;
  let tracked = new Set<string>();
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 10_000 }).toString().trim() || null;
    } catch { head = null; }
    try {
      const listed = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '-z'], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 })
        .toString().split('\0').filter(Boolean);
      tracked = new Set(listed);
    } catch { /* treat everything as uncopyable-by-git below */ }
  }

  // git can reconstruct any tracked file from `head`; everything else needs a copy
  const needCopy = [...signatures.keys()].filter((f) => !tracked.has(f));
  const copied = new Set<string>();
  let copiesDir: string | null = null;
  let truncated = false;
  if (needCopy.length > 0) {
    try {
      copiesDir = fs.mkdtempSync(path.join(tmpRoot, 'reviewbase-'));
      for (const rel of needCopy) {
        if (copied.size >= COPY_MAX_FILES) { truncated = true; break; }
        const src = path.join(dir, rel);
        try {
          if (fs.statSync(src).size > COPY_MAX_BYTES) { truncated = true; continue; }
          const dest = path.join(copiesDir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          copied.add(rel);
        } catch { truncated = true; }
      }
    } catch { copiesDir = null; truncated = needCopy.length > 0; }
  }
  return { head, signatures, copiesDir, copied, truncated };
}

/** delete the private copies; safe to call more than once */
export function releaseReviewBaseline(b: ReviewBaseline): void {
  if (!b.copiesDir) return;
  try { fs.rmSync(b.copiesDir, { recursive: true, force: true }); } catch { /* best effort */ }
  b.copiesDir = null;
}

/**
 * The diff from the reviewed state to the state now, for specific paths.
 *
 * Tracked files are diffed from the COMMIT the review saw, so a repair the
 * Builder committed is included — comparing against the current HEAD would
 * show nothing at all. Untracked files are diffed against the copy taken at
 * review time; only a file that did not exist then is diffed against
 * /dev/null. Anything without a baseline is named as such: a known content
 * change is never described as possibly metadata-only.
 */
export function repairDiff(
  dir: string, baseline: ReviewBaseline, changedPaths: string[], maxChars: number,
): { text: string | null; note: string } {
  if (changedPaths.length === 0) {
    return { text: null, note: '(no file content changed since the reviewed state, so there is nothing to diff)' };
  }
  const isRepo = fs.existsSync(path.join(dir, '.git'));
  const git = (args: string[]) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }).toString();
    } catch (err: any) {
      // `git diff --no-index` exits 1 when files differ — the diff is on stdout
      return typeof err?.stdout === 'string' ? err.stdout : (err?.stdout?.toString?.() ?? '');
    }
  };
  const clean = changedPaths.map((p) => p.replace(/^\((?:added|deleted)\) /, '')).slice(0, 60);
  const tracked: string[] = [];
  const viaCopy: string[] = [];
  const brandNew: string[] = [];
  const noBaseline: string[] = [];
  for (const rel of clean) {
    let isTracked = false;
    if (isRepo && baseline.head) {
      try {
        execFileSync('git', ['-C', dir, 'cat-file', '-e', `${baseline.head}:${rel}`], { timeout: 10_000, stdio: 'ignore' });
        isTracked = true;
      } catch { isTracked = false; }
    }
    if (isTracked) tracked.push(rel);
    else if (baseline.copied.has(rel)) viaCopy.push(rel);
    else if (!baseline.signatures.has(rel)) brandNew.push(rel);
    else noBaseline.push(rel);
  }

  const chunks: string[] = [];
  if (tracked.length > 0 && baseline.head) {
    // the reviewed COMMIT, not HEAD: this is what survives a committed repair
    const t = git(['diff', baseline.head, '--', ...tracked]);
    if (t.trim()) chunks.push(t);
  }
  // `git diff --no-index` labels its hunks with the absolute paths it was
  // given, which would show the Reviewer a private temp directory instead of
  // the file it knows. Put the project-relative name back.
  // git prints its own `a/` and `b/` prefixes immediately before the path it was
  // given, so the replacement keeps the leading slash: `a` + `/tmp/x/a.txt`
  // becomes `a` + `/a.txt`. /dev/null is left exactly as it is — it is what
  // marks a genuinely new file.
  const relabel = (text: string, before: string, after: string, rel: string) => {
    let out = text;
    if (before !== '/dev/null') out = out.split(before).join(`/${rel}`);
    if (after !== '/dev/null') out = out.split(after).join(`/${rel}`);
    return out;
  };
  for (const rel of viaCopy.slice(0, 30)) {
    const before = path.join(baseline.copiesDir ?? '', rel);
    const after = path.join(dir, rel);
    if (!fs.existsSync(before)) { noBaseline.push(rel); continue; }
    const present = fs.existsSync(after);
    const u = git(['diff', '--no-index', '--', before, present ? after : '/dev/null']);
    if (u.trim()) chunks.push(relabel(u, before, present ? after : '/dev/null', rel));
  }
  for (const rel of brandNew.slice(0, 30)) {
    const after = path.join(dir, rel);
    const u = git(['diff', '--no-index', '--', '/dev/null', after]);
    if (u.trim()) chunks.push(relabel(u, '/dev/null', after, rel));
  }

  const notes: string[] = [];
  if (noBaseline.length > 0) {
    notes.push(`(no baseline was kept for ${noBaseline.slice(0, 20).join(', ')}${noBaseline.length > 20 ? `, +${noBaseline.length - 20} more` : ''}`
      + ' — these files existed at review time but git held no copy of them. Their content HAS changed (the hashes differ); only the'
      + ' before/after text is unavailable, so read the current file directly.)');
  }
  if (baseline.truncated) {
    notes.push('(the baseline copy budget was exceeded, so some comparisons above may be missing rather than empty)');
  }
  if (chunks.length === 0 && notes.length === 0) {
    notes.push(isRepo
      ? '(git produced no diff for these paths even though their content changed — read the files directly rather than assuming the change was cosmetic)'
      : '(this workspace has no git repository and no baseline copy was available, so no before/after text can be produced)');
  }
  const text = chunks.join('\n');
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n… diff truncated at ${maxChars} characters …` : text;
  return { text: body.trim() ? body : null, note: notes.join('\n') };
}
