/**
 * THE single registry of every Tandem-owned static instruction string that can
 * reach a Claude or Codex invocation.
 *
 * Rule: no production AI-request assembly may contain a human-written literal —
 * it must come from getPrompt()/renderPrompt() so Admin → AI Prompts always
 * shows and controls the real text. Defaults here exist only for
 * "Reset to default". Runtime values (findings, diffs, rounds, paths…) are
 * substituted into {{placeholders}} by code and are NOT settings.
 *
 * NOT in this registry, deliberately (protocol/serialization, not instructions):
 * tool names + JSON schemas + MCP tool descriptions and tool RESULT texts,
 * the conversation-digest line labels (USER:/ASSISTANT:/CHANGED:…),
 * findings-list serialization handed back to the Builder, truncation markers,
 * and provider-internal prompts Tandem cannot see.
 */
import type { AppSettings, PromptEntry, PromptGroup } from '../../shared/types';
import { kvGet, kvSet } from './db';

interface PromptDef {
  key: string;
  name: string;
  description: string;
  group: PromptGroup;
  roles: string[];
  placeholders?: string[];
  default: string;
}

export const PROMPT_DEFS: PromptDef[] = [
  // ---------------------------------------------------------------- builder
  {
    key: 'builder.base',
    name: 'Builder — base instructions',
    description: 'Start of the Builder system additions on every Builder call.',
    group: 'builder',
    roles: ['builder'],
    default: [
      'You are the Builder, the coding agent for this project.',
      'Understand the request and decide yourself how to investigate and act: read, search, run commands, edit files, verify.',
      'Do only what the request needs. Report honestly what you did and what you found.',
    ].join('\n'),
  },
  {
    key: 'builder.environment',
    name: 'Builder — Tandem environment note',
    description: 'Tells the Builder it runs inside Tandem and that its activity is visible.',
    group: 'builder',
    roles: ['builder', 'final repair'],
    default: 'You are running inside Tandem, a chat product: the user sees your streamed replies plus a live record of your commands, file reads, and edits.',
  },
  {
    key: 'builder.workdir_guidance',
    name: 'Builder — working-directory guidance',
    description: 'Explains the tandem_set_working_dir capability.',
    group: 'builder',
    roles: ['builder', 'final repair'],
    default: 'The current directory is this chat\'s active workspace. If you set up a project somewhere else (for example after cloning a repository or extracting an archive) and further work belongs there, call the tandem_set_working_dir tool to make it the chat\'s working directory.',
  },
  {
    key: 'builder.browser_guidance',
    name: 'Builder — browser guidance',
    description: 'Explains the internal browser capability to the Builder.',
    group: 'builder',
    roles: ['builder', 'final repair'],
    default: 'A real internal browser (headless Chromium) is available through the browser_* tools: open any URL including localhost and file://, inspect page structure, click, type, resize the viewport to any dimensions, read the console, and take screenshots you can see. Use it whenever actually rendering or driving a page would help; skip it when it would not.',
  },
  {
    key: 'builder.deploy_guardrail',
    name: 'Builder — merge/push/deploy guardrail',
    description: 'Instruction-level guardrail: local work commits are fine; merging, pushing, publishing, deploying follow the persistent policy and the user\'s instructions.',
    group: 'builder',
    roles: ['builder', 'final repair'],
    default: 'Local commits on this chat\'s Tandem working branch are fine (the app also checkpoints completed work automatically). Do not merge into the user\'s branch, push, publish, or deploy unless the active Git workflow policy or the user\'s explicit instructions in this conversation allow it.',
  },
  {
    key: 'builder.git_workflow',
    name: 'Builder — Git workflow state',
    description: 'Tells the Builder the chat\'s persistent Git policy and how to change it when the user asks. Included only when the project is a Git repository.',
    group: 'builder',
    roles: ['builder', 'final repair'],
    placeholders: ['git_workflow'],
    default: 'Git workflow for this chat (persistent application state): {{git_workflow}}. The app automatically checkpoints completed work and applies this policy — you don\'t need to commit/merge yourself unless it helps. When the user asks to change how Git is handled (for example: merge finished work into a branch automatically from now on, stop merging, work directly on a branch, start pushing completed work), call the tandem_set_git_workflow tool once with the new policy — it persists for future requests without re-asking.',
  },
  {
    key: 'builder.continuation_compacted',
    name: 'Builder — compacted-context section',
    description: 'Prepended when a fresh CLI session starts after a compaction.',
    group: 'builder',
    roles: ['builder'],
    placeholders: ['compacted_context'],
    default: '# Compacted context of this conversation so far\n{{compacted_context}}',
  },
  {
    key: 'builder.continuation_recent',
    name: 'Builder — recent-conversation section',
    description: 'Prepended when a fresh CLI session starts with prior history.',
    group: 'builder',
    roles: ['builder'],
    placeholders: ['recent_conversation'],
    default: '# Recent conversation\n{{recent_conversation}}',
  },
  {
    key: 'builder.new_request',
    name: 'Builder — new-request header',
    description: 'Wraps the user message when a continuation preamble precedes it.',
    group: 'builder',
    roles: ['builder'],
    placeholders: ['user_message'],
    default: '# New request\n{{user_message}}',
  },
  {
    key: 'builder.attachments',
    name: 'Builder — attachment note',
    description: 'Appended to the user message when files are attached.',
    group: 'builder',
    roles: ['builder'],
    placeholders: ['attachment_list'],
    default: '[Files the user attached to this message — stored on this machine]\n{{attachment_list}}',
  },
  // ---------------------------------------------------------------- repair
  {
    key: 'repair.findings_message',
    name: 'Repair — findings hand-off',
    description: 'The message the Builder receives after round-1 findings.',
    group: 'repair',
    roles: ['builder'],
    placeholders: ['findings'],
    default: 'The independent Reviewer evaluated the result against the user\'s request and returned these findings:\n\n{{findings}}\n\nAddress them in the project now.',
  },
  {
    key: 'repair.final_base',
    name: 'Final repair — base instructions',
    description: 'Added to the Builder system additions on the final repair round.',
    group: 'repair',
    roles: ['final repair'],
    default: 'This is the final repair round. Address the reviewer\'s remaining findings precisely.\nThere will be no further review after this — keep the change minimal and safe.',
  },
  {
    key: 'repair.final_message',
    name: 'Final repair — findings hand-off',
    description: 'The message the Builder receives for the never-re-reviewed final repair.',
    group: 'repair',
    roles: ['final repair'],
    placeholders: ['findings'],
    default: 'Final repair round. The Reviewer\'s remaining findings:\n\n{{findings}}\n\nAddress them precisely; there will be no further review.',
  },
  // ---------------------------------------------------------------- reviewer
  {
    key: 'reviewer.base',
    name: 'Reviewer — base instructions',
    description: 'Start of every Reviewer request (scope, PASS rule, verification honesty).',
    group: 'reviewer',
    roles: ['reviewer'],
    default: [
      'You are the Reviewer. Independently evaluate the current state of the project against the user\'s original request.',
      'You may inspect the project read-only; you must not modify anything. You have network access for verification.',
      'Reply PASS if the request is correctly and completely implemented with no regressions.',
      'Otherwise list concrete, actionable findings with file evidence. Do not demand unrelated improvements.',
      'If something material to the request cannot be verified (an unreachable URL, a check you cannot run), do not PASS on assumptions — report it as a finding.',
    ].join('\n'),
  },
  {
    key: 'reviewer.browser_guidance',
    name: 'Reviewer — browser guidance',
    description: 'Explains the internal browser capability to the Reviewer.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'A real internal browser (headless Chromium) is available through the browser_* tools — open URLs including localhost, interact with pages, resize the viewport, read the console, take screenshots you can see. Use it if inspecting the running application helps your judgment. Your project filesystem access remains read-only.',
  },
  {
    key: 'reviewer.network_guidance',
    name: 'Reviewer — network/proxy guidance',
    description: 'Documents how the sandbox proxy reaches public and local addresses.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'Your shell has network access via the sandbox\'s HTTP(S) proxy: public URLs and name resolution work with normal tools (curl, wget). Local/private addresses (localhost, 127.0.0.1, 172.x, 10.x…) are excluded from the default proxy env, so for those force the proxy — e.g. `curl --noproxy \'\' http://127.0.0.1:PORT/…` — or use the internal browser, which reaches them directly.',
  },
  {
    key: 'reviewer.request_section',
    name: 'Reviewer — original-request section',
    description: 'Presents the user\'s original request to the Reviewer.',
    group: 'reviewer',
    roles: ['reviewer'],
    placeholders: ['original_request'],
    default: '# The user\'s original request\n{{original_request}}',
  },
  {
    key: 'reviewer.changed_section',
    name: 'Reviewer — changed-files section',
    description: 'Presents the objective changed-files evidence.',
    group: 'reviewer',
    roles: ['reviewer'],
    placeholders: ['changed_files_note', 'changed_files'],
    default: '# Changed files\n{{changed_files_note}}\n{{changed_files}}',
  },
  {
    key: 'reviewer.changed_empty',
    name: 'Reviewer — empty changed-list fallback',
    description: 'Used when no per-file list is available.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: '(list unavailable — inspect directly)',
  },
  {
    key: 'reviewer.note_git',
    name: 'Reviewer — note: git changes',
    description: 'Changed-files note when git porcelain lists uncommitted changes.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'Uncommitted changes per `git status --porcelain` (status + path):',
  },
  {
    key: 'reviewer.note_git_state',
    name: 'Reviewer — note: git state changed',
    description: 'Used when the git state changed but the tree lists no files (e.g. a commit).',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'The git state changed (e.g. a commit or new repository) — inspect `git log`/`git status` directly.',
  },
  {
    key: 'reviewer.note_git_clean',
    name: 'Reviewer — note: re-review of clean tree',
    description: 'Round-2 note when the repaired tree shows no porcelain entries.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'Inspect the repository state directly (`git status`, `git log`).',
  },
  {
    key: 'reviewer.note_nongit',
    name: 'Reviewer — note: non-git changes',
    description: 'Changed-files note for non-git working trees.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'Not a git repository — files that changed during the run:',
  },
  {
    key: 'reviewer.note_nongit_inspect',
    name: 'Reviewer — note: re-review of non-git tree',
    description: 'Round-2 note for non-git working trees.',
    group: 'reviewer',
    roles: ['reviewer'],
    default: 'Not a git repository — inspect the working tree directly.',
  },
  {
    key: 'reviewer.note_switched',
    name: 'Reviewer — note: working directory switched',
    description: 'Used when the Builder moved the chat to a different directory mid-run.',
    group: 'reviewer',
    roles: ['reviewer'],
    placeholders: ['new_dir'],
    default: 'The working directory changed to {{new_dir}} during the run. Uncommitted changes there:',
  },
  {
    key: 'reviewer.round_section',
    name: 'Reviewer — round section',
    description: 'States the review round. The two-round cap itself is enforced by code.',
    group: 'reviewer',
    roles: ['reviewer'],
    placeholders: ['review_round', 'max_review_rounds'],
    default: '# Round\n{{review_round}} of maximum {{max_review_rounds}}.',
  },
  {
    key: 'reviewer.output_format',
    name: 'Reviewer — required output format',
    description: 'The PASS/FINDINGS contract. Changing it may degrade verdict parsing (unparsed output is treated as findings, never as PASS).',
    group: 'reviewer',
    roles: ['reviewer'],
    default: [
      '# Required output format',
      'First line: exactly `PASS` or `FINDINGS`.',
      'If FINDINGS, list each one as:',
      '1. [major|minor] <short title> — <file>:<line>',
      '   <what is wrong, concretely>',
      '   Recommendation: <one line>',
      'Only report issues that matter for this request: incorrect or incomplete implementation, regressions, broken behavior, real security problems, relevant test/build failures, accidental unrelated changes. Do not demand unrelated improvements.',
    ].join('\n'),
  },
  // ---------------------------------------------------------------- compactor
  {
    key: 'compactor.base',
    name: 'Compactor — base instructions',
    description: 'Start of every Compactor call.',
    group: 'compactor',
    roles: ['compactor'],
    default: [
      'You are the Compactor. Produce a compact replacement for this conversation\'s context.',
      'Preserve: goals, instructions, decisions, current task state, key discoveries, changed files, test results that still matter, unresolved issues, reviewer findings, constraints, remaining work.',
      'Aggressively drop stale noise and repetition.',
    ].join('\n'),
  },
  {
    key: 'compactor.output_directive',
    name: 'Compactor — output directive',
    description: 'Forces a clean summary-only reply.',
    group: 'compactor',
    roles: ['compactor'],
    default: 'Reply with ONLY the compacted context in markdown — no preface, no commentary.',
  },
  {
    key: 'compactor.message',
    name: 'Compactor — message wrapper',
    description: 'Wraps the serialized conversation digest.',
    group: 'compactor',
    roles: ['compactor'],
    placeholders: ['conversation_digest'],
    default: 'Compact this conversation:\n\n{{conversation_digest}}',
  },
];

const DEF_BY_KEY = new Map(PROMPT_DEFS.map((d) => [d.key, d]));

// ---------------------------------------------------------------- storage

type Overrides = Record<string, string>;

function overrides(): Overrides {
  return kvGet<Overrides>('prompts') ?? {};
}

export function getPrompt(key: string): string {
  const def = DEF_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown prompt key: ${key}`);
  const o = overrides()[key];
  return typeof o === 'string' && o.trim().length > 0 ? o : def.default;
}

export function setPromptOverride(key: string, value: string): void {
  if (!DEF_BY_KEY.has(key)) throw new Error(`Unknown prompt key: ${key}`);
  const o = overrides();
  o[key] = value;
  kvSet('prompts', o);
}

export function resetPrompt(key: string): void {
  if (!DEF_BY_KEY.has(key)) throw new Error(`Unknown prompt key: ${key}`);
  const o = overrides();
  delete o[key];
  kvSet('prompts', o);
}

export function listPrompts(): PromptEntry[] {
  const o = overrides();
  return PROMPT_DEFS.map((d) => ({
    key: d.key,
    name: d.name,
    description: d.description,
    group: d.group,
    roles: d.roles,
    placeholders: d.placeholders ?? [],
    default: d.default,
    value: getPrompt(d.key),
    customized: typeof o[d.key] === 'string' && o[d.key].trim().length > 0 && o[d.key] !== d.default,
  }));
}

// ---------------------------------------------------------------- import/export

export interface PromptsExport {
  app: 'tandem';
  kind: 'prompts';
  version: 1;
  exportedAt: string;
  /** key → current effective text (defaults included, so the file is a complete snapshot) */
  prompts: Record<string, string>;
}

export function exportPrompts(): PromptsExport {
  const prompts: Record<string, string> = {};
  for (const d of PROMPT_DEFS) prompts[d.key] = getPrompt(d.key);
  return { app: 'tandem', kind: 'prompts', version: 1, exportedAt: new Date().toISOString(), prompts };
}

export interface PromptsImportResult {
  applied: string[];
  resetToDefault: string[];
  unchanged: string[];
  skipped: string[];
}

/**
 * Apply a prompts JSON file. Accepts the export shape ({ prompts: {…} }) or a
 * bare key→text map. Known keys only; a value equal to the default clears the
 * override; keys absent from the file are left untouched.
 */
export function importPrompts(data: unknown): PromptsImportResult {
  const map = (data && typeof data === 'object' && !Array.isArray(data))
    ? ((data as any).prompts && typeof (data as any).prompts === 'object' ? (data as any).prompts : data)
    : null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('Expected a JSON object with prompt texts (the exported format, or a plain {key: text} map).');
  }
  const entries = Object.entries(map as Record<string, unknown>).filter(([k]) => k !== 'app' && k !== 'kind' && k !== 'version' && k !== 'exportedAt');
  if (entries.length > 200) throw new Error('Too many entries in the file.');

  const result: PromptsImportResult = { applied: [], resetToDefault: [], unchanged: [], skipped: [] };
  for (const [key, raw] of entries) {
    const def = DEF_BY_KEY.get(key);
    if (!def || typeof raw !== 'string' || raw.length > 20_000) {
      result.skipped.push(key);
      continue;
    }
    const current = getPrompt(key);
    if (raw === current) {
      // still normalize storage: matching the default must not linger as an override
      if (raw === def.default) resetPrompt(key);
      result.unchanged.push(key);
    } else if (raw === def.default || raw.trim().length === 0) {
      resetPrompt(key);
      result.resetToDefault.push(key);
    } else {
      setPromptOverride(key, raw);
      result.applied.push(key);
    }
  }
  return result;
}

/** {{name}} substitution; unknown placeholders stay visible rather than vanishing. */
export function renderPrompt(key: string, vars: Record<string, string | number>): string {
  return getPrompt(key).replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : m);
}

// ---------------------------------------------------------------- assemblies
// The exact system-addition builders used by the production engine (and by the
// Admin preview, so the preview can never drift from reality).

export function builderSystemText(settings: AppSettings, role: 'builder' | 'final_repair', gitWorkflow?: string): string {
  const parts = [getPrompt('builder.base')];
  if (role === 'final_repair') parts.push(getPrompt('repair.final_base'));
  if (settings.sharedInstructions.trim()) parts.push(settings.sharedInstructions.trim());
  const extra = role === 'final_repair' ? settings.finalRepairInstructions : settings.roles.builder.instructions;
  if (extra.trim()) parts.push(extra.trim());
  parts.push([
    getPrompt('builder.environment'),
    getPrompt('builder.workdir_guidance'),
    getPrompt('builder.browser_guidance'),
    getPrompt('builder.deploy_guardrail'),
  ].join('\n'));
  if (gitWorkflow) parts.push(renderPrompt('builder.git_workflow', { git_workflow: gitWorkflow }));
  return parts.join('\n\n');
}

export function reviewerSystemText(settings: AppSettings): string {
  const parts = [getPrompt('reviewer.base')];
  if (settings.sharedInstructions.trim()) parts.push(settings.sharedInstructions.trim());
  if (settings.roles.reviewer.instructions.trim()) parts.push(settings.roles.reviewer.instructions.trim());
  parts.push([getPrompt('reviewer.browser_guidance'), getPrompt('reviewer.network_guidance')].join('\n'));
  return parts.join('\n\n');
}

export function compactorSystemText(settings: AppSettings): string {
  return [
    getPrompt('compactor.base'),
    settings.sharedInstructions.trim(),
    settings.roles.compactor.instructions.trim(),
    getPrompt('compactor.output_directive'),
  ].filter(Boolean).join('\n\n');
}

/** Admin "effective prompt" preview — the real assembly plus template skeletons. */
export function buildRolePreview(role: string, settings: AppSettings): string {
  if (role === 'reviewer') {
    return [
      reviewerSystemText(settings),
      getPrompt('reviewer.request_section'),
      getPrompt('reviewer.changed_section'),
      getPrompt('reviewer.round_section'),
      getPrompt('reviewer.output_format'),
      '[{{…}} placeholders are filled by Tandem at call time with real runtime values]',
    ].join('\n\n');
  }
  if (role === 'compactor') {
    return [
      compactorSystemText(settings),
      getPrompt('compactor.message'),
      '[{{conversation_digest}} is generated from the chat\'s stored events at call time]',
    ].join('\n\n');
  }
  const r = role === 'final_repair' ? 'final_repair' : 'builder';
  return [
    builderSystemText(settings, r, '{{git_workflow}}'),
    '[at call time Tandem appends the message: on a fresh session, the compacted-context / recent-conversation sections, then the user request (with the attachment note when files are attached); on a resumed session, just the request. {{git_workflow}} is filled with the chat\'s persistent Git policy, and the section is omitted for non-Git directories]',
  ].join('\n\n');
}
