/**
 * Findings are advice. This module is the machinery that keeps them so.
 *
 * The responsibility chain it implements:
 *   Builder builds and owns the implementation.
 *   Reviewer advises and independently verifies.
 *   Director arbitrates disagreements and owns delivery decisions.
 *
 * Three protocol parsers live here (the Builder's dispositions, the Director's
 * decisions, and the text each side is shown), plus the one call that asks the
 * Director to decide. Like parseVerdict, the parsers handle a contracted output
 * FORMAT — they detect no intent, and every unparsable case falls to the
 * conservative side: an unanswered finding counts as accepted (so it is
 * verified), an undecided finding stays open and blocking (so nothing is
 * repaired on nobody's instruction, and nothing is quietly waved through).
 */
import type {
  ArbitrationDecision, ArbitrationItem, ArbitrationPayload, Finding, FindingDisposition, FindingResponse, ReviewFindingRecord,
} from '../../../shared/types';
import { getPrompt, renderPrompt } from '../prompts';
import { executeRole } from '../providers/executor';
import { resolveDirectorRoleConfig } from '../providers/resolve';
import type { ClosedFinding } from './reviewLedger';
import type { RunHandle } from './run';

/** how long the Director may take to decide — it reads, it does not build */
export const ARBITRATION_TIMEOUT = 15 * 60_000;

const DISPOSITIONS: FindingDisposition[] = ['accepted', 'partially_accepted', 'rejected', 'cannot_address'];
const DECISIONS: ArbitrationDecision[] = ['builder_upheld', 'reviewer_upheld', 'non_blocking', 'deferred', 'different_resolution_required'];

/**
 * One `FINDING n: <word>` block per finding, with `Key: value` lines beneath.
 * Shared by both parsers: the Builder and the Director speak the same shape
 * with different vocabularies.
 */
function parseBlocks(text: string): Map<number, { word: string; fields: Record<string, string> }> {
  const out = new Map<number, { word: string; fields: Record<string, string> }>();
  let cur: { word: string; fields: Record<string, string> } | null = null;
  let curKey: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[*_`#>\-\s]+|[*_`\s]+$/g, '');
    const head = line.match(/^FINDING\s+#?(\d+)\s*[:\-—–]\s*`?([a-z_ ]+?)`?\s*(?:[—–\-|(].*)?$/i);
    if (head) {
      cur = { word: head[2].trim().toLowerCase().replace(/\s+/g, '_'), fields: {} };
      curKey = null;
      out.set(Number(head[1]), cur);
      continue;
    }
    if (!cur) continue;
    const field = line.match(/^(Reason|Evidence|Required|Blocking)\s*:\s*(.*)$/i);
    if (field) {
      curKey = field[1].toLowerCase();
      cur.fields[curKey] = field[2].trim();
    } else if (curKey && line) {
      // a field's continuation line
      cur.fields[curKey] = `${cur.fields[curKey]} ${line}`.trim();
    }
  }
  return out;
}

/**
 * The Builder's answer to each finding. A finding the Builder did not answer
 * — or answered with a word outside the contract — is recorded as accepted
 * with `source: 'assumed'`: that is the historical behavior (every finding
 * was treated as an instruction), and it keeps such findings on the path
 * that gets verified rather than the path that gets argued.
 */
export function parseDispositions(text: string, findings: Finding[]): FindingResponse[] {
  const blocks = parseBlocks(text);
  return findings.map((f, i) => {
    const b = blocks.get(i + 1);
    const word = b?.word as FindingDisposition | undefined;
    if (!b || !word || !DISPOSITIONS.includes(word)) {
      return { ...(f.id ? { id: f.id } : {}), index: i + 1, title: f.title, severity: f.severity, disposition: 'accepted', reason: b?.fields.reason || '(no disposition given — recorded as accepted)', source: 'assumed' };
    }
    return {
      ...(f.id ? { id: f.id } : {}), index: i + 1, title: f.title, severity: f.severity, disposition: word,
      reason: b.fields.reason || '(no reason given)',
      ...(b.fields.evidence && !/^none\.?$/i.test(b.fields.evidence) ? { evidence: b.fields.evidence } : {}),
      source: 'builder',
    };
  });
}

/**
 * The Director's decision on each disputed finding. A finding with no
 * parsable decision is `unresolved`: it stays open and blocking, and no
 * repair is started for it — a decision nobody made is not a decision.
 */
export interface Disputed {
  finding: Finding;
  /** the Builder's answer, when it gave one */
  response?: FindingResponse;
  /** where the finding stands (from the registry), when known */
  record?: ReviewFindingRecord;
  index: number;
}

export function parseArbitration(text: string, disputed: Disputed[]): ArbitrationItem[] {
  const blocks = parseBlocks(text);
  return disputed.map((d, i) => {
    const b = blocks.get(i + 1);
    const word = b?.word as ArbitrationDecision | undefined;
    const base: Omit<ArbitrationItem, 'decision' | 'reason' | 'blocking'> = {
      ...(d.finding.id ? { id: d.finding.id } : {}),
      index: d.index, title: d.finding.title, severity: d.finding.severity,
      ...(d.response ? { disposition: d.response.disposition } : d.record?.disposition ? { disposition: d.record.disposition } : {}),
      ...(d.record ? { state: d.record.state, ...(d.record.repairStatus ? { repairStatus: d.record.repairStatus } : {}) } : {}),
    };
    if (!b || !word || !DECISIONS.includes(word)) {
      return { ...base, decision: 'unresolved', reason: '(the Director gave no usable decision for this finding — it stands open)', blocking: true };
    }
    const required = b.fields.required && !/^none\.?$/i.test(b.fields.required) ? b.fields.required : undefined;
    const needsChange = word === 'reviewer_upheld' || word === 'different_resolution_required';
    // blocking follows the decision unless the Director said otherwise for an
    // upheld finding; a closed finding is never blocking whatever the field says
    const saidNot = /^\s*(no|false|non)/i.test(b.fields.blocking ?? '');
    const blocking = needsChange ? !saidNot : false;
    return { ...base, decision: word, reason: b.fields.reason || '(no reason given)', ...(required ? { required } : {}), blocking };
  });
}

/** the closing `PROCEED: yes|no — …` line of a final decision */
export function parseProceed(text: string): { proceed?: boolean; summary?: string } {
  const m = text.match(/^\s*[*_`#>\-\s]*PROCEED\s*:\s*`?(yes|no)`?\s*(?:[—–\-:]\s*(.*))?$/im);
  if (!m) return {};
  return { proceed: m[1].toLowerCase() === 'yes', ...(m[2]?.trim() ? { summary: m[2].trim() } : {}) };
}

// ---------------------------------------------------------------- text shown to each side

export function findingAsText(f: Finding, n: number): string {
  return `${n}. ${f.id ? `${f.id} ` : ''}[${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n   ${f.detail}`
    + (f.evidence ? `\n   Evidence: ${f.evidence}` : '')
    + (f.category ? `\n   Category: ${f.category}` : '')
    + (f.recommendation ? `\n   Recommendation: ${f.recommendation}` : '');
}

/** the findings before the Director, each with the Builder's position and where it stands */
export function disputedAsText(items: Disputed[]): string {
  return items.map((d, i) => {
    const r = d.response;
    const rec = d.record;
    const standing = rec ? `\n   Standing: ${rec.state}${rec.repairStatus ? `, repair ${rec.repairStatus}` : ''}${rec.restated ? `, restated by the Reviewer ${rec.restated}×` : ''}` : '';
    const builder = r
      ? `${r.disposition} — ${r.reason}${r.evidence ? `\n   Builder evidence: ${r.evidence}` : ''}`
      : rec?.disposition
        ? `${rec.disposition} — ${rec.dispositionReason ?? ''}${rec.dispositionEvidence ? `\n   Builder evidence: ${rec.dispositionEvidence}` : ''}`
        : '(the Builder gave no position on this finding)';
    return `${findingAsText(d.finding, i + 1)}${standing}\n   Builder: ${builder}`;
  }).join('\n\n');
}

/** what the Director decided, in the words the Builder acts on */
export function mandatedAsText(items: ArbitrationItem[]): string {
  return items.map((a, i) => `${i + 1}. ${a.id ? `${a.id} ` : ''}[${a.severity}] ${a.title}\n   Director: ${a.decision.replace(/_/g, ' ')} — ${a.reason}\n   Required: ${a.required ?? 'address the finding; how is your call'}`).join('\n\n');
}

export function closedAsText(items: ClosedFinding[]): string {
  return items.length === 0 ? '(none)' : items.map((c) => `- ${c.id ? `${c.id} ` : ''}[${c.severity}] ${c.title} — ${c.decision.replace(/_/g, ' ')} (round ${c.round}): ${c.reason}`).join('\n');
}

export function dispositionsAsText(items: FindingResponse[]): string {
  return items.map((r) => `${r.id ?? `${r.index}.`} [${r.severity}] ${r.title} — ${r.disposition.replace(/_/g, ' ')}${r.source === 'assumed' ? ' (assumed)' : ''}: ${r.reason}${r.evidence ? `\n   Evidence: ${r.evidence}` : ''}`).join('\n');
}

// ---------------------------------------------------------------- the decision

export interface ArbitrationInput {
  round: number;
  /** the findings before the Director, each with the Builder's answer where it gave one */
  disputed: Disputed[];
  originalRequest: string;
  steering?: string;
  builderHandoff: string;
  changedPaths: string[];
  diff: string | null;
  diffNote: string;
  closed: ClosedFinding[];
  /**
   * The FINAL decision: the loop is over (review 1 → response → review 2 →
   * final pass), nothing is repaired or reviewed again, and the question is
   * whether the result may proceed as it stands.
   */
  final: boolean;
}

/**
 * Ask the Director to decide. One read-only call on the Director's own
 * provider and model, in the session's chat, recorded as an `arbitration`
 * event by the caller. A failed call decides nothing: every item comes back
 * `unresolved`, open and blocking.
 */
export async function arbitrate(h: RunHandle, input: ArbitrationInput): Promise<ArbitrationPayload> {
  const director = resolveDirectorRoleConfig(h.settings);
  const prompt = [
    renderPrompt('director.arbitration_request', {
      original_request: input.originalRequest,
      continuation: input.steering && input.steering.trim() !== input.originalRequest.trim()
        ? `\n# The continuation instruction this run was started with\n${input.steering}\n` : '',
      round: input.round,
      cap_note: input.final
        ? 'This is the FINAL decision. The loop is complete (review 1 → Builder response → review 2 → final Builder pass); nothing is repaired or reviewed again. Decide, per finding, whether it blocks this result as it stands, and close with PROCEED: yes|no.'
        : 'One review round remains. Findings you uphold are repaired by the Builder now and verified by the Reviewer in that round.',
      disputed: disputedAsText(input.disputed),
      closed: closedAsText(input.closed),
      builder_handoff: input.builderHandoff.trim().slice(0, 6_000) || '(the Builder gave no hand-off)',
      changed_paths: input.changedPaths.length > 0 ? input.changedPaths.slice(0, 60).map((f) => `- ${f}`).join('\n') : '- (no file content changed since the reviewed state)',
      repair_diff: input.diff ?? input.diffNote,
      policies: getPrompt('director.arbitration_policies'),
    }),
    getPrompt('director.arbitration_output_format'),
  ].join('\n\n');

  const system = [getPrompt('director.arbitration_base'), ...(h.settings.sharedInstructions.trim() ? [h.settings.sharedInstructions.trim()] : [])].join('\n\n');
  const prevPhase = h.ctx.phase;
  h.ctx.phase = 'reviewer'; // Builder-only app-state tools are refused while the Director judges
  let result;
  try {
    result = await executeRole({
      handle: h,
      role: 'arbiter',
      provider: director.provider,
      model: director.model,
      effort: director.effort,
      systemPrompt: system,
      userPrompt: prompt,
      cwd: h.project.rootPath,
      emitActivity: false,
      timeoutMs: ARBITRATION_TIMEOUT,
    });
  } finally {
    h.ctx.phase = prevPhase;
  }
  const base = { round: input.round, ...(input.final ? { final: true } : {}) };
  if (result.status !== 'completed') {
    const failed = result.status === 'stopped' ? 'stopped' : (result.failure?.message ?? 'the Director call failed');
    return {
      ...base, failed,
      items: input.disputed.map((d) => ({
        ...(d.finding.id ? { id: d.finding.id } : {}),
        index: d.index, title: d.finding.title, severity: d.finding.severity,
        ...(d.response ? { disposition: d.response.disposition } : {}),
        decision: 'unresolved' as const, reason: `(no decision — ${failed})`, blocking: true,
      })),
    };
  }
  const items = parseArbitration(result.answer, input.disputed);
  const closing = input.final ? parseProceed(result.answer) : {};
  // the Director's own PROCEED line never overrides a blocking item: an item it
  // judged blocking blocks, and "proceed: yes" beside it is recorded as its
  // stated opinion, not as the outcome
  return { ...base, items, ...(input.final ? { proceed: closing.proceed ?? !items.some((a) => a.blocking) } : {}), ...(closing.summary ? { summary: closing.summary } : {}) };
}
