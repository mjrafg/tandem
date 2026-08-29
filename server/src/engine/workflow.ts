import { randomUUID } from 'node:crypto';
import type { AttachmentMeta, Finding, FindingsPayload } from '../../../shared/types';
import { computeUsage } from '../context';
import { getBuilderSession, getChat, getEvent, getProject, setBuilderSession } from '../db';
import { addEvent, updateEvent } from '../events';
import { BASE_PROMPTS, getSettings } from '../settings';
import { runClaudeTurn } from './claude';
import { runCodexReview } from './codex';
import { applyCompaction, recentConversation, runCompaction } from './compactor';
import {
  RunHandle, type RunCtx, isRunning, markDanglingStopped, registerCtx, releaseCtx, setChatRunning, stopRun,
} from './run';
import { captureWorktree, diffWorktrees, type WorktreeDelta } from './snapshot';

export { isRunning, stopRun, applyWorkdirChange } from './run';

const BUILDER_TIMEOUT = 30 * 60_000;
const REVIEW_TIMEOUT = 15 * 60_000;

/**
 * The production run: ONE Builder invocation per user message — the Builder
 * decides what to do. The application's own logic is limited to objective
 * facts: did files actually change (worktree snapshots), the capped review
 * loop, timeouts, and honest bookkeeping. No intent detection anywhere.
 */
export async function startRun(chatId: string, userText: string, attachments: AttachmentMeta[] = []): Promise<void> {
  const chat = getChat(chatId);
  if (!chat || isRunning(chatId)) return;
  const project = getProject(chat.projectId);
  if (!project) return;

  const ctx: RunCtx = { chatId, runId: randomUUID(), stopped: false };
  registerCtx(ctx);
  setChatRunning(chatId, true);
  addEvent(chatId, 'run', { phase: 'started' }, { runId: ctx.runId });

  const h = new RunHandle(ctx, chat, project, attachments);
  try {
    await runWorkflow(h, userText);
    addEvent(chatId, 'run', { phase: ctx.stopped ? 'stopped' : 'finished' }, { runId: ctx.runId });
  } catch (err) {
    h.error({ message: 'The run failed unexpectedly', detail: String(err), source: 'engine' });
    addEvent(chatId, 'run', { phase: 'failed' }, { runId: ctx.runId });
  } finally {
    markDanglingStopped(chatId, ctx.runId);
    releaseCtx(ctx);
    setChatRunning(chatId, false);
    void maybeAutoCompact(chatId);
  }
}

async function runWorkflow(h: RunHandle, userText: string): Promise<void> {
  const builderCfg = h.settings.roles.builder;
  const startDir = h.project.rootPath;
  const before = captureWorktree(startDir);
  const resume = getBuilderSession(h.chat.id);

  // ---- Builder does the work (its own decisions, its own tools)
  const first = await runClaudeTurn(h, {
    role: 'builder',
    model: builderCfg.model,
    effort: builderCfg.effort,
    systemAppendix: builderSystem(h, 'builder'),
    message: builderMessage(h, userText, resume),
    cwd: startDir,
    resumeSessionId: resume,
    withWorkdirTool: true,
    timeoutMs: BUILDER_TIMEOUT,
  });
  if (first.sessionId) setBuilderSession(h.chat.id, first.sessionId);
  if (h.stopped) return;
  if (!first.ok) {
    h.error({ message: 'Builder call failed', detail: first.error, source: 'builder', retryable: true });
    return;
  }

  // ---- objective review gate: what actually changed on disk?
  h.refresh();
  const endDir = h.project.rootPath;
  const delta = reviewGate(before, startDir, endDir, h);
  if (!delta) return; // nothing to review (or no baseline — already noted)
  if (h.settings.roles.reviewer.enabled === false) return;

  // ---- round 1
  const round1 = await review(h, userText, delta, 1);
  if (!round1 || h.stopped || round1.verdict === 'pass') return;

  // ---- repair
  const repair = await runClaudeTurn(h, {
    role: 'builder',
    model: builderCfg.model,
    effort: builderCfg.effort,
    systemAppendix: builderSystem(h, 'builder'),
    message: `The independent Reviewer evaluated the result against the user's request and returned these findings:\n\n${findingsAsText(round1.items)}\n\nAddress them in the project now.`,
    cwd: endDir,
    resumeSessionId: getBuilderSession(h.chat.id),
    withWorkdirTool: true,
    timeoutMs: BUILDER_TIMEOUT,
  });
  if (repair.sessionId) setBuilderSession(h.chat.id, repair.sessionId);
  if (h.stopped) return;
  if (!repair.ok) {
    h.error({ message: 'Builder repair call failed', detail: repair.error, source: 'builder', retryable: true });
    return;
  }

  // ---- round 2 (the last review)
  h.refresh();
  const round2 = await review(h, userText, currentDelta(h), 2);
  if (!round2 || h.stopped || round2.verdict === 'pass') return;

  // ---- final repair — hard cap: never re-reviewed
  const final = await runClaudeTurn(h, {
    role: 'final_repair',
    model: builderCfg.model,
    effort: builderCfg.effort,
    systemAppendix: builderSystem(h, 'final_repair'),
    message: `Final repair round. The Reviewer's remaining findings:\n\n${findingsAsText(round2.items)}\n\nAddress them precisely; there will be no further review.`,
    cwd: h.project.rootPath,
    resumeSessionId: getBuilderSession(h.chat.id),
    withWorkdirTool: true,
    timeoutMs: BUILDER_TIMEOUT,
  });
  if (final.sessionId) setBuilderSession(h.chat.id, final.sessionId);
  if (!h.stopped && final.ok) {
    updateEvent(round2.eventId, { finalRepairNotReviewed: true });
    h.status('Final repair applied. The review loop is capped at two rounds, so this final repair was not re-reviewed.');
  } else if (!h.stopped && !final.ok) {
    h.error({ message: 'Final repair call failed', detail: final.error, source: 'builder', retryable: true });
  }
}

// ---------------------------------------------------------------- review gate

/** Decide from RESULTING STATE whether review applies; null = no review. */
function reviewGate(before: ReturnType<typeof captureWorktree>, startDir: string, endDir: string, h: RunHandle): WorktreeDelta | null {
  if (endDir === startDir) {
    const delta = diffWorktrees(before, captureWorktree(endDir));
    return delta.changed ? delta : null;
  }
  // the Builder moved the chat to a different directory during the run
  const after = captureWorktree(endDir);
  if (after.kind === 'git') {
    if (after.files.size === 0) return null; // clean tree (e.g. fresh clone): nothing modified
    return {
      changed: true,
      files: [...after.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: `The working directory changed to ${endDir} during the run. Uncommitted changes there:`,
    };
  }
  h.status('Review skipped: the working directory changed mid-run and the new directory has no baseline to diff against.');
  return null;
}

function currentDelta(h: RunHandle): WorktreeDelta {
  const state = captureWorktree(h.project.rootPath);
  if (state.kind === 'git') {
    return {
      changed: true,
      files: [...state.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: state.files.size > 0 ? 'Uncommitted changes per `git status --porcelain`:' : 'Inspect the repository state directly (`git status`, `git log`).',
    };
  }
  return { changed: true, files: [], note: 'Not a git repository — inspect the working tree directly.' };
}

// ---------------------------------------------------------------- reviewer

async function review(h: RunHandle, userText: string, delta: WorktreeDelta, round: number):
  Promise<{ verdict: 'pass' | 'findings'; items: Finding[]; eventId: string } | null> {
  h.status(round === 1 ? 'Reviewer is checking the result…' : 'Reviewer is checking the repaired result…');
  const cfg = h.settings.roles.reviewer;
  const prompt = [
    `# The user's original request\n${userText}`,
    `# Changed files\n${delta.note}\n${delta.files.map((f) => `- ${f}`).join('\n') || '(list unavailable — inspect directly)'}`,
    `# Round\n${round} of maximum 2.`,
    [
      '# Required output format',
      'First line: exactly `PASS` or `FINDINGS`.',
      'If FINDINGS, list each one as:',
      '1. [major|minor] <short title> — <file>:<line>',
      '   <what is wrong, concretely>',
      '   Recommendation: <one line>',
      'Only report issues that matter for this request: incorrect or incomplete implementation, regressions, broken behavior, real security problems, relevant test/build failures, accidental unrelated changes. Do not demand unrelated improvements.',
    ].join('\n'),
  ].join('\n\n');

  const systemParts = [BASE_PROMPTS.reviewer];
  if (h.settings.sharedInstructions.trim()) systemParts.push(h.settings.sharedInstructions.trim());
  if (cfg.instructions.trim()) systemParts.push(cfg.instructions.trim());

  const result = await runCodexReview(h, {
    model: cfg.model,
    effort: cfg.effort,
    prompt: `${systemParts.join('\n\n')}\n\n${prompt}`,
    cwd: h.project.rootPath,
    timeoutMs: REVIEW_TIMEOUT,
  });
  if (h.stopped) return null;
  if (!result.ok) {
    h.error({ message: 'Reviewer could not run', detail: result.error, source: 'reviewer', retryable: true });
    h.status('The review loop stopped because the Reviewer failed — the result above has NOT been reviewed.');
    return null;
  }

  const { verdict, items } = parseVerdict(result.text);
  const payload: FindingsPayload = { verdict, round, items };
  const ev = addEvent(h.chat.id, 'findings', payload, { runId: h.ctx.runId });
  return { verdict, items, eventId: ev.id };
}

/** Parse the Reviewer's contracted output format (protocol, not intent). */
export function parseVerdict(text: string): { verdict: 'pass' | 'findings'; items: Finding[] } {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (/^`?PASS`?\b/i.test(firstLine)) return { verdict: 'pass', items: [] };

  const items: Finding[] = [];
  const lines = text.split('\n');
  let current: Finding | null = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*\d+\.\s*\[(major|minor)\]\s*(.+)$/i);
    if (m) {
      if (current) items.push(current);
      let title = m[2].trim();
      let file: string | undefined;
      let lineNo: number | undefined;
      const loc = title.match(/\s[—–-]\s*(\S+?)(?::(\d+))?\s*$/);
      if (loc && /[./]/.test(loc[1])) {
        file = loc[1].replace(/[`(),]/g, '');
        if (loc[2]) lineNo = Number(loc[2]);
        title = title.slice(0, loc.index).trim();
      }
      current = { severity: m[1].toLowerCase() as 'major' | 'minor', title: title.replace(/`/g, ''), file, line: lineNo, detail: '' };
      continue;
    }
    if (current && raw.trim()) {
      const rec = raw.trim().match(/^Recommendation:\s*(.+)$/i);
      if (rec) current.recommendation = rec[1];
      else current.detail = current.detail ? `${current.detail} ${raw.trim()}` : raw.trim();
    }
  }
  if (current) items.push(current);
  if (items.length === 0) {
    items.push({ severity: 'major', title: 'Reviewer reported issues (unstructured output)', detail: text.trim().slice(0, 4_000) });
  }
  return { verdict: 'findings', items };
}

function findingsAsText(items: Finding[]): string {
  return items.map((f, i) =>
    `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n   ${f.detail}${f.recommendation ? `\n   Recommendation: ${f.recommendation}` : ''}`).join('\n');
}

// ---------------------------------------------------------------- prompts

function builderSystem(h: RunHandle, role: 'builder' | 'final_repair'): string {
  const parts = [BASE_PROMPTS.builder];
  if (role === 'final_repair') parts.push(BASE_PROMPTS.final_repair);
  if (h.settings.sharedInstructions.trim()) parts.push(h.settings.sharedInstructions.trim());
  const roleExtra = role === 'final_repair' ? h.settings.finalRepairInstructions : h.settings.roles.builder.instructions;
  if (roleExtra.trim()) parts.push(roleExtra.trim());
  parts.push([
    'You are running inside Tandem, a chat product: the user sees your streamed replies plus a live record of your commands, file reads, and edits.',
    'The current directory is this chat\'s active workspace. If you set up a project somewhere else (for example after cloning a repository or extracting an archive) and further work belongs there, call the tandem_set_working_dir tool to make it the chat\'s working directory.',
    'Never commit, push, publish, or deploy unless the user explicitly asked for it in this conversation.',
  ].join('\n'));
  return parts.join('\n\n');
}

function builderMessage(h: RunHandle, userText: string, resumeSessionId: string | null): string {
  const parts: string[] = [];
  if (!resumeSessionId) {
    // fresh CLI session: seed continuity from the stored record
    const compaction = latestCompactionSummary(h);
    const recent = recentConversation(h.chat.id, h.settings.context.preserveRecentTokens * 4, true);
    if (compaction) parts.push(`# Compacted context of this conversation so far\n${compaction}`);
    if (recent.trim()) parts.push(`# Recent conversation\n${recent}`);
  }
  let body = userText.trim();
  if (h.attachments.length > 0) {
    body += `\n\n[Files the user attached to this message — stored on this machine]\n${h.attachments.map((a) => `- ${a.path} (${Math.round(a.size / 1024)} KB)`).join('\n')}`;
  }
  parts.push(parts.length > 0 ? `# New request\n${body}` : body);
  return parts.join('\n\n');
}

function latestCompactionSummary(h: RunHandle): string | null {
  const ev = h.chat.lastCompactionEventId ? getEvent(h.chat.lastCompactionEventId) : null;
  return ev ? (ev.payload as any).summary ?? null : null;
}

// ---------------------------------------------------------------- auto-compact

async function maybeAutoCompact(chatId: string): Promise<void> {
  try {
    const settings = getSettings();
    if (!settings.context.autoCompact) return;
    const chat = getChat(chatId);
    if (!chat || isRunning(chatId)) return;
    if (computeUsage(chat).pct < settings.context.compactPct) return;
    const call = await runCompaction(chat);
    if (!call.ok) {
      addEvent(chatId, 'error', { message: 'Automatic compaction failed', detail: call.error, source: 'compactor', retryable: true });
      return;
    }
    applyCompaction(chat, call);
  } catch (err) {
    addEvent(chatId, 'error', { message: 'Automatic compaction failed', detail: String(err), source: 'compactor' });
  }
}
