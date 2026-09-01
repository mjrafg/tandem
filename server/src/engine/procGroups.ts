/**
 * Per-session process containment.
 *
 * Everything an agent invocation spawns (dev servers, watchers, daemons)
 * belongs to the session CHAT that started it — not to the single CLI process
 * and not to nobody. Invocations end without killing background processes (a
 * Reviewer or repair may still need the Builder's dev server); only a TERMINAL
 * transition (session completed/abandoned, chat deleted, project terminal
 * cleanup, restart of a replaced session) reaps the group, and worktree
 * removal happens only after the group is verified empty.
 *
 * Backend 1 — cgroup v2 (production): the systemd unit delegates its subtree
 * (Delegate=yes), so the service user creates one sub-cgroup per chat and
 * moves each spawned CLI pid into it; descendants inherit membership in the
 * kernel. Enumeration and verification are RECURSIVE (a contained process may
 * legally create nested sub-cgroups), and the guaranteed kill is cgroup.kill,
 * which the kernel applies to the whole subtree. The cgroup filesystem itself
 * is the restart-surviving source of truth.
 *
 * Backend 2 — process groups (dev/macOS fallback, and the safety net when a
 * cgroup adoption fails): children spawn detached as their own group leaders;
 * pgids are tracked per chat in the database and killed with kill(-pgid).
 * Weaker (a setsid-ing daemon escapes; pid reuse exists), so kills are gated
 * on the row being from THIS host boot — anything older is provably dead and
 * only its row is dropped, never a signal sent at a recycled pgid.
 *
 * BrowserHost/Chromium never enters a session group: browsers are spawned by
 * the server process through Playwright, not through spawnStreaming.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from '../db';

const GRACE_MS = 5_000;
const PREFIX = 's-';

// ------------------------------------------------------------ backend detect

let cgroupBase: string | null | undefined; // undefined = not probed yet

/** The service's own cgroup dir when sub-groups can be created there, else null. */
function cgroupRoot(): string | null {
  if (cgroupBase !== undefined) return cgroupBase;
  cgroupBase = null;
  try {
    if (process.platform === 'linux' && fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
      const own = line ? path.join('/sys/fs/cgroup', line.slice(3).trim()) : null;
      if (own && fs.existsSync(own)) {
        const probe = path.join(own, `${PREFIX}probe-${process.pid}`);
        fs.mkdirSync(probe);
        fs.rmdirSync(probe);
        cgroupBase = own;
      }
    }
  } catch { cgroupBase = null; }
  if (process.platform === 'linux' && !cgroupBase) {
    console.log('[tandem] cgroup v2 subtree not writable — session process containment falls back to process groups (add Delegate=yes to the unit for full containment)');
  }
  return cgroupBase;
}

/** Milliseconds since epoch of the current HOST boot (0 = unknown). */
function bootTimeMs(): number {
  try {
    if (process.platform === 'linux') {
      return Date.now() - Math.round(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000);
    }
    return Date.now() - Math.round(os.uptime() * 1000);
  } catch { return 0; }
}

export function spawnDetached(): boolean {
  // children always lead their own process group: it is the fallback backend's
  // whole mechanism, and in cgroup mode it keeps the pgid safety net usable
  // when a cgroup adoption fails
  return true;
}

function groupDir(chatId: string): string {
  return path.join(cgroupRoot()!, `${PREFIX}${chatId.replace(/[^a-zA-Z0-9-]/g, '')}`);
}

// --------------------------------------------------------------- membership

/** Adopt a freshly spawned CLI process into its chat's containment group. */
export function enterProcGroup(chatId: string, pid: number | undefined): void {
  if (!pid) return;
  const base = cgroupRoot();
  try {
    if (base) {
      const dir = groupDir(chatId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cgroup.procs'), String(pid));
      return;
    }
  } catch (err) {
    // fall through to the pgid record: a failed cgroup adoption must never
    // mean "contained by nothing"
    console.error('[tandem] cgroup adoption failed — falling back to pgid tracking:', err);
  }
  try {
    db.prepare('INSERT OR IGNORE INTO proc_groups (chat_id, pgid, created_at) VALUES (?, ?, ?)')
      .run(chatId, pid, Date.now());
  } catch (err) {
    console.error('[tandem] could not contain spawned process:', err);
  }
}

// -------------------------------------------------------------- termination

/** Every sub-cgroup directory under a group, deepest first (for rmdir order). */
function cgroupDirsDeepFirst(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(d, e.name));
    out.push(d);
  };
  walk(dir);
  return out;
}

/** RECURSIVE member enumeration — nested sub-cgroups count. */
function readPids(dir: string): number[] {
  const pids: number[] = [];
  for (const d of cgroupDirsDeepFirst(dir)) {
    try {
      for (const l of fs.readFileSync(path.join(d, 'cgroup.procs'), 'utf8').split('\n')) {
        const n = Number(l.trim());
        if (n > 0) pids.push(n);
      }
    } catch { /* dir raced away */ }
  }
  return pids;
}

function pgidMembers(pgid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
    return out.split('\n').map((l) => Number(l.trim())).filter((n) => n > 0);
  } catch { return []; } // pgrep exits 1 when the group is empty
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reap every process still belonging to the chat's group: TERM first, a grace
 * period, then a guaranteed recursive kill, then VERIFY the group is empty.
 * Returns how many processes were still alive — callers that remove worktrees
 * must await this first.
 */
export async function terminateProcGroup(chatId: string): Promise<number> {
  let alive = 0;
  const base = cgroupRoot();
  try {
    if (base) {
      const dir = groupDir(chatId);
      if (fs.existsSync(dir)) {
        const initial = readPids(dir);
        alive += initial.length;
        for (const pid of initial) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
        const deadline = Date.now() + GRACE_MS;
        while (readPids(dir).length > 0 && Date.now() < deadline) await sleep(200);
        // cgroup.kill is subtree-recursive in the kernel — write it even when
        // the group LOOKS empty, so nothing hiding in a nested cgroup survives
        try { fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1'); } catch { /* already gone */ }
        const hardStop = Date.now() + GRACE_MS;
        while (readPids(dir).length > 0 && Date.now() < hardStop) await sleep(200);
        if (readPids(dir).length === 0) {
          for (const d of cgroupDirsDeepFirst(dir)) { try { fs.rmdirSync(d); } catch { /* raced */ } }
        }
      }
    }
    // pgid rows exist in fallback mode — and in cgroup mode when an adoption
    // failed. Kills are valid only within the boot the row was written in.
    const boot = bootTimeMs();
    const rows = db.prepare('SELECT pgid, created_at FROM proc_groups WHERE chat_id = ?').all(chatId) as { pgid: number; created_at: number }[];
    const current = rows.filter((r) => boot === 0 || r.created_at >= boot);
    for (const { pgid } of current) {
      const members = pgidMembers(pgid);
      alive += members.length;
      if (members.length > 0) { try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ } }
    }
    if (current.length > 0) {
      const deadline = Date.now() + GRACE_MS;
      while (Date.now() < deadline && current.some(({ pgid }) => pgidMembers(pgid).length > 0)) await sleep(200);
      for (const { pgid } of current) {
        if (pgidMembers(pgid).length > 0) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
      }
      const hardStop = Date.now() + GRACE_MS;
      while (Date.now() < hardStop && current.some(({ pgid }) => pgidMembers(pgid).length > 0)) await sleep(200);
    }
    db.prepare('DELETE FROM proc_groups WHERE chat_id = ?').run(chatId);
    return alive;
  } catch (err) {
    console.error('[tandem] process-group termination failed:', err);
    return alive;
  }
}

// ------------------------------------------------------------ reconciliation

/**
 * Boot pass: groups whose chat no longer exists, or whose Director session is
 * already terminal (completed/abandoned), are stale — their processes must not
 * outlive the decision that ended them. Groups of live chats and preserved
 * sessions (paused, awaiting_review, recoverable failures) are left alone.
 * pgid rows from before the current HOST boot are provably dead: dropped
 * without ever signalling a possibly-recycled pgid.
 */
export async function reconcileProcGroups(): Promise<void> {
  const terminal = (chatId: string): boolean => {
    const chat = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
    if (!chat) return true;
    const s = db.prepare('SELECT status FROM pd_sessions WHERE chat_id = ?').get(chatId) as any;
    return !!s && ['completed', 'abandoned'].includes(s.status);
  };
  try {
    const base = cgroupRoot();
    const stale = new Set<string>();
    if (base) {
      for (const entry of fs.readdirSync(base)) {
        if (!entry.startsWith(PREFIX)) continue;
        const chatId = entry.slice(PREFIX.length);
        const dir = path.join(base, entry);
        if (terminal(chatId)) stale.add(chatId);
        else if (readPids(dir).length === 0) {
          for (const d of cgroupDirsDeepFirst(dir)) { try { fs.rmdirSync(d); } catch { /* keep */ } }
        }
      }
    }
    const boot = bootTimeMs();
    const rows = db.prepare('SELECT chat_id, pgid, created_at FROM proc_groups').all() as { chat_id: string; pgid: number; created_at: number }[];
    for (const row of rows) {
      // pre-boot rows and finished invocations: prune, never signal
      if ((boot !== 0 && row.created_at < boot) || pgidMembers(row.pgid).length === 0) {
        db.prepare('DELETE FROM proc_groups WHERE chat_id = ? AND pgid = ?').run(row.chat_id, row.pgid);
        continue;
      }
      if (terminal(row.chat_id)) stale.add(row.chat_id);
    }
    for (const chatId of stale) {
      const n = await terminateProcGroup(chatId);
      if (n > 0) console.log(`[tandem] reaped ${n} stale process(es) of terminal session chat ${chatId}`);
    }
  } catch (err) {
    console.error('[tandem] process-group reconciliation failed:', err);
  }
}
