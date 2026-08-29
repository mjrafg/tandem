import { randomUUID } from 'node:crypto';
import type { AttachmentMeta, Finding, FindingsPayload } from '../../../shared/types';
import { computeUsage } from '../context';
import { getBuilderSession, getChat, getEvent, getProject, setBuilderSession } from '../db';
import { addEvent, updateEvent } from '../events';
import { getSettings } from '../settings';
import { builderSystemText, getPrompt, renderPrompt, reviewerSystemText } from '../prompts';
import { runClaudeTurn } from './claude';
import { runCodexReview } from './codex';
import { applyCompaction, recentConversation, runCompaction } from './compactor';
import {
  RunHandle, type RunCtx, isRunning, markDanglingStopped, registerCtx, releaseCtx, setChatRunning, stopRun,
} from './run';
import { captureWorktree, diffWorktrees, type DeltaNoteKind } from './snapshot';

export { isRunning, stopRun, applyWorkdirChange } from './run';

const BUILDER_TIMEOUT = 30 * 60_000;
const REVIEW_TIMEOUT = 15 * 60_000;
/** the review-loop cap — enforced by the orchestration below, not by prompts */
const MAX_REVIEW_ROUNDS = 2;

/** wording for the changed-files note comes from the prompt registry */
interface ReviewDelta { files: string[]; note: string }

function noteFor(kind: DeltaNoteKind): string {
  return getPrompt(kind === 'git' ? 'reviewer.note_git' : kind === 'git_state' ? 'reviewer.note_git_state' : 'reviewer.note_nongit');
}

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
    systemAppendix: builderSystemText(h.settings, 'builder'),
    message: builderMessage(h, userText, resume),
    cwd: startDir,
    resumeSessionId: resume,
    withTandemTools: true,
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
    systemAppendix: builderSystemText(h.settings, 'builder'),
    message: renderPrompt('repair.findings_message', { findings: findingsAsText(round1.items) }),
    cwd: endDir,
    resumeSessionId: getBuilderSession(h.chat.id),
    withTandemTools: true,
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
    systemAppendix: builderSystemText(h.settings, 'final_repair'),
    message: renderPrompt('repair.final_message', { findings: findingsAsText(round2.items) }),
    cwd: h.project.rootPath,
    resumeSessionId: getBuilderSession(h.chat.id),
    withTandemTools: true,
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
function reviewGate(before: ReturnType<typeof captureWorktree>, startDir: string, endDir: string, h: RunHandle): ReviewDelta | null {
  if (endDir === startDir) {
    const delta = diffWorktrees(before, captureWorktree(endDir));
    return delta.changed ? { files: delta.files, note: noteFor(delta.noteKind) } : null;
  }
  // the Builder moved the chat to a different directory during the run
  const after = captureWorktree(endDir);
  if (after.kind === 'git') {
    if (after.files.size === 0) return null; // clean tree (e.g. fresh clone): nothing modified
    return {
      files: [...after.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: renderPrompt('reviewer.note_switched', { new_dir: endDir }),
    };
  }
  h.status('Review skipped: the working directory changed mid-run and the new directory has no baseline to diff against.');
  return null;
}

function currentDelta(h: RunHandle): ReviewDelta {
  const state = captureWorktree(h.project.rootPath);
  if (state.kind === 'git') {
    return {
      files: [...state.files.entries()].map(([f, s]) => `${s} ${f}`).slice(0, 100),
      note: state.files.size > 0 ? getPrompt('reviewer.note_git') : getPrompt('reviewer.note_git_clean'),
    };
  }
  return { files: [], note: getPrompt('reviewer.note_nongit_inspect') };
}

// ---------------------------------------------------------------- reviewer

async function review(h: RunHandle, userText: string, delta: ReviewDelta, round: number):
  Promise<{ verdict: 'pass' | 'findings'; items: Finding[]; eventId: string } | null> {
  h.status(round === 1 ? 'Reviewer is checking the result…' : 'Reviewer is checking the repaired result…');
  const cfg = h.settings.roles.reviewer;
  const prompt = [
    renderPrompt('reviewer.request_section', { original_request: userText }),
    renderPrompt('reviewer.changed_section', {
      changed_files_note: delta.note,
      changed_files: delta.files.map((f) => `- ${f}`).join('\n') || getPrompt('reviewer.changed_empty'),
    }),
    renderPrompt('reviewer.round_section', { review_round: round, max_review_rounds: MAX_REVIEW_ROUNDS }),
    getPrompt('reviewer.output_format'),
  ].join('\n\n');

  const result = await runCodexReview(h, {
    model: cfg.model,
    effort: cfg.effort,
    prompt: `${reviewerSystemText(h.settings)}\n\n${prompt}`,
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
// All static wording comes from the prompt registry (Admin → AI Prompts).
// Do not add literal instruction strings here — add them to prompts.ts.

function builderMessage(h: RunHandle, userText: string, resumeSessionId: string | null): string {
  const parts: string[] = [];
  if (!resumeSessionId) {
    // fresh CLI session: seed continuity from the stored record
    const compaction = latestCompactionSummary(h);
    const recent = recentConversation(h.chat.id, h.settings.context.preserveRecentTokens * 4, true);
    if (compaction) parts.push(renderPrompt('builder.continuation_compacted', { compacted_context: compaction }));
    if (recent.trim()) parts.push(renderPrompt('builder.continuation_recent', { recent_conversation: recent }));
  }
  let body = userText.trim();
  if (h.attachments.length > 0) {
    const attachmentList = h.attachments.map((a) => `- ${a.path} (${Math.round(a.size / 1024)} KB)`).join('\n');
    body += `\n\n${renderPrompt('builder.attachments', { attachment_list: attachmentList })}`;
  }
  parts.push(parts.length > 0 ? renderPrompt('builder.new_request', { user_message: body }) : body);
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
