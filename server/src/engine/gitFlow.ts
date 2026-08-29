/**
 * Tandem's persistent Git workflow — deterministic mechanics, no AI decisions:
 *
 *   - each chat working in a Git repo gets its own branch: tandem/<chat-id>
 *   - completed runs are checkpointed with a local commit (recovery points)
 *   - the per-chat policy (working-branch / auto-merge / direct, target
 *     branch, push) is APPLICATION STATE persisted on the chat; the Builder
 *     changes it via the tandem_set_git_workflow tool when the user asks —
 *     the app never guesses intent from message text
 *   - merging happens only under auto-merge, with --no-ff, and a conflict
 *     aborts cleanly: neither side is ever discarded
 *   - pushing happens only when the policy explicitly says push=auto
 *   - uncommitted work found when a repo is adopted is preserved as its own
 *     clearly-labeled commit, never silently absorbed or discarded
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitFlowState } from '../../../shared/types';
import { getChat, getGitStateRow, setGitStateRow } from '../db';
import { addEvent, broadcastChat } from '../events';
import { activeCtx } from './run';
import type { RunHandle } from './run';

const execFileP = promisify(execFile);
const IDENT = ['-c', 'user.name=Tandem', '-c', 'user.email=tandem@tandem.local'];

async function git(dir: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', dir, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: any) {
    return { ok: false, stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? err?.message ?? err) };
  }
}

async function porcelainFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ['status', '--porcelain=v1']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim());
}

export function summaryText(st: GitFlowState): string {
  if (st.mode === 'auto-merge') return `auto-merge — work on ${st.workBranch}, merge into ${st.targetBranch} after each completed request; push: ${st.push}`;
  if (st.mode === 'direct') return `direct — commit directly on ${st.targetBranch}; push: ${st.push}`;
  return `working branch — commit on ${st.workBranch}, no merging into ${st.targetBranch}; push: ${st.push}`;
}

function saveState(chatId: string, st: GitFlowState): void {
  setGitStateRow(chatId, st);
  broadcastChat(chatId);
}

// ---------------------------------------------------------------- adoption

/**
 * Called at run start. Ensures the chat has a Git workflow for the current
 * directory and that HEAD is on the branch the policy expects. Returns the
 * active state, or null when checkpointing is unavailable for this run.
 */
export async function adoptRepo(h: RunHandle): Promise<GitFlowState | null> {
  const dir = h.project.rootPath;
  const existing = getGitStateRow(h.chat.id);

  if (existing && existing.repoPath === dir) {
    if (existing.mode === 'none') return null;
    const ok = await ensureOnBranch(h, existing);
    return ok ? existing : null;
  }

  // fresh adoption for this directory
  if (!fs.existsSync(path.join(dir, '.git'))) {
    saveState(h.chat.id, { mode: 'none', workBranch: '', targetBranch: '', push: 'never', repoPath: dir });
    h.status('Git checkpointing unavailable — this directory is not a Git repository.');
    return null;
  }
  const head = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (!head.ok) {
    saveState(h.chat.id, { mode: 'none', workBranch: '', targetBranch: '', push: 'never', repoPath: dir });
    h.status('Git checkpointing unavailable — the repository is on a detached HEAD.');
    return null;
  }
  const current = head.stdout.trim();
  const dirtyBefore = await porcelainFiles(dir);
  const workBranch = current.startsWith('tandem/') ? current : `tandem/${h.chat.id.slice(0, 8)}`;
  const targetBranch = current; // if already on a tandem/ branch, target=work → merge no-ops

  if (workBranch !== current) {
    const exists = (await git(dir, ['rev-parse', '--verify', `refs/heads/${workBranch}`])).ok;
    const sw = await git(dir, ['switch', ...(exists ? [] : ['-c']), workBranch]);
    if (!sw.ok) {
      saveState(h.chat.id, { mode: 'none', workBranch: '', targetBranch: '', push: 'never', repoPath: dir });
      h.status(`Git checkpointing unavailable — could not switch to ${workBranch}: ${sw.stderr.trim().split('\n').pop()}`);
      return null;
    }
  }

  const st: GitFlowState = { mode: 'working-branch', workBranch, targetBranch, push: 'never', repoPath: dir };
  saveState(h.chat.id, st);
  h.status(`Working on Git branch ${workBranch} (target: ${targetBranch}).`);

  // never silently absorb work that predates Tandem's branch work
  if (dirtyBefore.length > 0) {
    await git(dir, ['add', '-A']);
    const msg = 'tandem: preserve uncommitted changes present before adopting the working branch';
    const c = await git(dir, [...IDENT, 'commit', '-m', msg]);
    if (c.ok) {
      const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      addEvent(h.chat.id, 'checkpoint', {
        action: 'preserve', branch: workBranch, commit: hash, message: msg, files: dirtyBefore.slice(0, 100),
      }, { runId: h.ctx.runId });
    }
  }
  return st;
}

async function ensureOnBranch(h: RunHandle, st: GitFlowState): Promise<boolean> {
  const dir = st.repoPath;
  const desired = st.mode === 'direct' ? st.targetBranch : st.workBranch;
  const head = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (!head.ok) {
    h.status('Git checkpointing paused for this run — the repository is on a detached HEAD.');
    return false;
  }
  if (head.stdout.trim() === desired) return true;
  const sw = await git(dir, ['switch', desired]);
  if (!sw.ok) {
    h.status(`Git checkpointing paused for this run — could not switch from ${head.stdout.trim()} to ${desired} (${sw.stderr.trim().split('\n').pop()}).`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- run finish

/** Checkpoint a successfully completed run, then apply the merge/push policy. */
export async function finishGitRun(h: RunHandle, userText: string): Promise<void> {
  const st = h.gitFlow;
  if (!st) return;
  if (h.project.rootPath !== st.repoPath) return; // working dir switched mid-run; adopt next run
  const dir = st.repoPath;

  const files = await porcelainFiles(dir);
  if (files.length > 0) {
    await git(dir, ['add', '-A']);
    const msg = `tandem: ${userText.replace(/\s+/g, ' ').trim().slice(0, 72) || 'checkpoint'}`;
    const c = await git(dir, [...IDENT, 'commit', '-m', msg]);
    if (!c.ok) {
      h.error({ message: 'Git checkpoint failed', detail: c.stderr.trim().slice(-400), source: 'git' });
      return;
    }
    const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    const branch = (await git(dir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    addEvent(h.chat.id, 'checkpoint', {
      action: 'commit', branch, commit: hash, message: msg, files: files.slice(0, 100),
    }, { runId: h.ctx.runId });
  }

  if (st.mode !== 'auto-merge' || st.workBranch === st.targetBranch) return;
  const ahead = await git(dir, ['rev-list', '--count', `${st.targetBranch}..${st.workBranch}`]);
  if (!ahead.ok || parseInt(ahead.stdout.trim(), 10) === 0) return;

  const swT = await git(dir, ['switch', st.targetBranch]);
  if (!swT.ok) {
    h.error({ message: `Auto-merge skipped — could not switch to ${st.targetBranch}`, detail: swT.stderr.trim().slice(-300), source: 'git' });
    return;
  }
  const mergeMsg = `tandem: merge ${st.workBranch}`;
  const m = await git(dir, [...IDENT, 'merge', '--no-ff', st.workBranch, '-m', mergeMsg], 30_000);
  if (m.ok) {
    const hash = (await git(dir, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    addEvent(h.chat.id, 'checkpoint', {
      action: 'merge', branch: st.workBranch, target: st.targetBranch, commit: hash, message: mergeMsg,
    }, { runId: h.ctx.runId });
    if (st.push === 'auto') {
      const p = await git(dir, ['push', 'origin', st.targetBranch], 90_000);
      if (p.ok) {
        addEvent(h.chat.id, 'checkpoint', { action: 'push', branch: st.targetBranch, target: st.targetBranch }, { runId: h.ctx.runId });
      } else {
        h.error({ message: `Push to origin/${st.targetBranch} failed`, detail: (p.stderr || p.stdout).trim().slice(-400), source: 'git', retryable: true });
      }
    }
  } else {
    await git(dir, ['merge', '--abort']);
    h.error({
      message: `Merge conflict — auto-merge into ${st.targetBranch} aborted`,
      detail: `Nothing was discarded: your work is committed on ${st.workBranch} and ${st.targetBranch} is unchanged. Ask the Builder to resolve the conflict, or resolve it manually.\n${(m.stderr || m.stdout).trim().slice(-400)}`,
      source: 'git',
    });
  }
  await git(dir, ['switch', st.workBranch]); // future work continues on the working branch
}

// ---------------------------------------------------------------- policy tool

/** Invoked by the Builder through tandem_set_git_workflow when the user asks. */
export async function setGitWorkflow(chatId: string, patch: { mode?: string; target_branch?: string; push?: string }):
  Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, error: 'Unknown chat.' };
  const st = getGitStateRow(chatId);
  if (!st || st.mode === 'none') return { ok: false, error: 'This chat is not working in a Git repository, so there is no Git workflow to configure.' };

  const mode = patch.mode ?? st.mode;
  if (!['working-branch', 'auto-merge', 'direct'].includes(mode)) {
    return { ok: false, error: `Unknown mode "${patch.mode}". Use working-branch, auto-merge, or direct.` };
  }
  const push = patch.push ?? st.push;
  if (!['auto', 'never'].includes(push)) return { ok: false, error: `Unknown push policy "${patch.push}". Use auto or never.` };

  let targetBranch = st.targetBranch;
  if (patch.target_branch) {
    const name = patch.target_branch.trim();
    const exists = (await git(st.repoPath, ['rev-parse', '--verify', `refs/heads/${name}`])).ok;
    if (!exists) return { ok: false, error: `Branch "${name}" does not exist in this repository.` };
    targetBranch = name;
  }

  const next: GitFlowState = { ...st, mode: mode as GitFlowState['mode'], targetBranch, push: push as GitFlowState['push'] };
  saveState(chatId, next);
  const summary = summaryText(next);
  addEvent(chatId, 'status', { text: `Git workflow updated: ${summary}` }, { runId: activeCtx(chatId)?.runId });
  return { ok: true, summary };
}
