import {
  AlertTriangle, Archive, Braces, Camera, CircleCheck, CircleSlash, Clock, CloudUpload, FileDiff, FileText,
  GitBranch, GitCommitHorizontal, GitMerge, Globe, Keyboard, ListTree, MousePointerClick, MoveVertical,
  Boxes, OctagonX, Plug, Scan, Search as SearchIcon, Sparkles, SquareTerminal, Terminal,
} from 'lucide-react';
import { DIFFICULTY_ROUTING_ENABLED } from '@shared/features';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import type {
  AiCallPayload, BrowserActionPayload, ChatEvent, CheckpointPayload, CommandPayload, CompactionPayload, ErrorPayload,
  FileChangePayload, FileReadPayload, FindingsPayload, RunPayload, SearchPayload, SessionsPayload, StatusPayload, ToolCallPayload, ArbitrationPayload, DispositionsPayload } from '@shared/types';
import { fmtDuration, fmtTokens, plural } from '../../lib/format';
import { DiffView } from '../DiffView';
import { CopyButton, Markdown } from '../Markdown';
import { ActivityRow, KV } from './ActivityRow';

const roleMeta: Record<string, { label: string; dot: string }> = {
  builder: { label: 'Builder', dot: 'bg-builder' },
  reviewer: { label: 'Reviewer', dot: 'bg-reviewer' },
  builder_reviewer: { label: 'Builder Reviewer', dot: 'bg-reviewer' },
  director_reviewer: { label: 'Director Reviewer', dot: 'bg-reviewer' },
  compactor: { label: 'Compactor', dot: 'bg-compactor' },
  final_repair: { label: 'Final repair', dot: 'bg-builder' },
  // a Director turn labelled "Builder" is how a misconfigured Director looked
  // like a Builder failure — the role is its own, whatever provider runs it
  director: { label: 'Director', dot: 'bg-accent' },
  arbiter: { label: 'Director · arbitration', dot: 'bg-accent' },
};

const providerName = (p: string) => (p === 'claude-code' ? 'Claude' : p === 'codex' ? 'Codex' : p);

/**
 * How long a grouped step actually occupied the timeline: first action start to
 * last action end. Summing the individual durations instead would hide the
 * gaps where the model is deciding what to do next, reporting a few seconds for
 * a stretch the user watched for half a minute.
 */
function groupElapsed(events: ChatEvent[], running: boolean): number {
  const starts = events.map((e) => e.ts);
  const ends = events.map((e) => e.ts + (((e.payload as { durationMs?: number }).durationMs) ?? 0));
  const end = running ? Date.now() : Math.max(...ends);
  return Math.max(0, end - Math.min(...starts));
}

/** total time actually spent executing, shown when it differs from the elapsed span */
function groupBusy(events: ChatEvent[]): number {
  return events.reduce((n, e) => n + ((((e.payload as { durationMs?: number }).durationMs) ?? 0)), 0);
}

function ElapsedNote({ events, running }: { events: ChatEvent[]; running: boolean }) {
  const elapsed = groupElapsed(events, running);
  const busy = groupBusy(events);
  if (events.length < 2 || elapsed <= 0 || busy >= elapsed * 0.8) return null;
  return (
    <div className="pb-1 text-[11.5px] text-dim">
      {fmtDuration(busy)} spent running · {fmtDuration(elapsed)} elapsed including the time between steps
    </div>
  );
}

// ---------------------------------------------------------------- commands

export function CommandGroupRow({ events }: { events: ChatEvent[] }) {
  const cmds = events.map((e) => e.payload as CommandPayload);
  const running = cmds.some((c) => c.status === 'running');
  const failed = cmds.filter((c) => c.status === 'done' && (c.exitCode ?? 0) !== 0).length;
  const elapsed = groupElapsed(events, running);
  const label = cmds.length === 1
    ? <>Ran <code className="mono text-[12px] text-mut">{truncate(cmds[0].command, 60)}</code></>
    : <>Ran {plural(cmds.length, 'command')}</>;

  return (
    <ActivityRow
      icon={<Terminal size={14} />}
      label={<>{label}{failed > 0 && <span className="ml-2 text-err">{failed} failed</span>}</>}
      meta={fmtDuration(elapsed)}
      running={running}
      tone={failed > 0 ? 'error' : 'default'}
    >
      <div className="space-y-2">
        <ElapsedNote events={events} running={running} />
        {events.map((e) => <CommandDetail key={e.id} p={e.payload as CommandPayload} />)}
      </div>
    </ActivityRow>
  );
}

function CommandDetail({ p }: { p: CommandPayload }) {
  const ok = (p.exitCode ?? 0) === 0;
  return (
    <div className="overflow-hidden rounded-lg border border-linesoft bg-[#0e1013]">
      <div className="flex items-center gap-2 border-b border-linesoft px-3 py-1.5">
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-[#d7dce4]">$ {p.command}</span>
        <CopyButton text={p.command} />
        {p.status === 'running' ? (
          <span className="chip text-accent">running</span>
        ) : p.status === 'stopped' ? (
          <span className="chip text-dim">stopped</span>
        ) : (
          <span className={`chip ${ok ? 'text-ok' : 'text-err'}`}>exit {p.exitCode}</span>
        )}
        <span className="text-[11px] tabular-nums text-dim">{fmtDuration(p.durationMs)}</span>
      </div>
      <div className="px-3 py-1 text-[11px] text-dim">cwd <span className="mono">{p.cwd}</span></div>
      {(p.stdout || p.stderr) && (
        <pre className="mono max-h-72 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2.5 pt-1 text-[12px] leading-[1.55] text-[#c3c9d4]">
          {p.stdout}
          {p.stderr && <span className="text-[#ff9a94]">{p.stdout ? '\n' : ''}{p.stderr}</span>}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- file reads

export function ReadGroupRow({ events }: { events: ChatEvent[] }) {
  const reads = events.map((e) => e.payload as FileReadPayload);
  const label = reads.length === 1
    ? <>Read <code className="mono text-[12px] text-mut">{reads[0].path}</code></>
    : <>Read {plural(reads.length, 'file')}</>;
  return (
    <ActivityRow icon={<FileText size={14} />} label={label}>
      <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
        {reads.map((r, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 py-[2px]">
            <span className="mono min-w-0 truncate text-[12px] text-mut">{r.path}</span>
            {r.error
              ? <span className="shrink-0 text-[11px] text-warn" title={r.error}>not read</span>
              : r.lines != null && <span className="shrink-0 text-[11px] tabular-nums text-dim">{r.lines} lines</span>}
          </div>
        ))}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- search

export function SearchGroupRow({ events }: { events: ChatEvent[] }) {
  const searches = events.map((e) => e.payload as SearchPayload);
  const label = searches.length === 1
    ? <>Searched <code className="mono text-[12px] text-mut">{truncate(searches[0].query, 42)}</code></>
    : <>Searched code ×{searches.length}</>;
  return (
    <ActivityRow icon={<SearchIcon size={14} />} label={label} meta={matchCount(searches.reduce((n, s) => n + s.matches.length, 0))}>
      <div className="space-y-2">
        {searches.map((s, i) => (
          <div key={i} className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
            <div className="mb-1 text-[12px] text-mut">
              <span className="mono text-[#d7dce4]">{s.query}</span>
              <span className="ml-2 text-dim">via {s.tool}</span>
            </div>
            {s.matches.map((m, k) => (
              <div key={k} className="flex gap-2 py-[2px] text-[12px]">
                <span className="mono shrink-0 text-accent/90">{m.path}:{m.line}</span>
                <span className="mono min-w-0 truncate text-dim">{m.preview}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- file changes

export function ChangeGroupRow({ events }: { events: ChatEvent[] }) {
  const files = events.flatMap((e) => (e.payload as FileChangePayload).files);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <ActivityRow
      icon={<FileDiff size={14} />}
      label={
        <>
          Changed {plural(files.length, 'file')}
          <span className="ml-2 text-ok">+{adds}</span> <span className="text-err">−{dels}</span>
        </>
      }
    >
      <div className="space-y-2.5">
        {files.map((f, i) => (
          <div key={i}>
            <div className="mb-1 flex items-center gap-2">
              <span className="mono text-[12px] text-[#d7dce4]">{f.path}</span>
              <span className="text-[11px] text-ok">+{f.additions}</span>
              <span className="text-[11px] text-err">−{f.deletions}</span>
            </div>
            <DiffView diff={f.diff} />
          </div>
        ))}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- ai calls

export function AiCallRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as AiCallPayload;
  const role = roleMeta[p.role] ?? roleMeta.builder;
  const running = p.status === 'running';
  return (
    <ActivityRow
      icon={<Sparkles size={14} />}
      running={running}
      label={
        <span className="inline-flex items-center gap-2">
          <span>Asked {providerName(p.provider)} · {role.label}</span>
          <span className={`inline-block h-[6px] w-[6px] rounded-full ${role.dot}`} />
          {p.difficulty && (
            <span className="rounded-full border border-line px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-dim" title={`difficulty ${p.difficulty} — model chosen by the ${p.modelSource === 'difficulty' ? 'difficulty tier' : p.modelSource === 'agent' ? 'Builder Agent profile' : 'role default'}${DIFFICULTY_ROUTING_ENABLED ? '' : '. Difficulty routing is archived; this is what this call actually ran with'}`}>
              {p.difficulty.replace('_', ' ')}{p.modelSource === 'difficulty' ? ' tier' : ''}
            </span>
          )}
          {p.status === 'failed' && <span className="text-err">failed</span>}
          {p.status === 'stopped' && <span className="text-dim">stopped</span>}
        </span>
      }
      meta={
        <span className="inline-flex items-center gap-2">
          <span className="mono text-[11px]">{p.model}</span>
          {p.durationMs != null && <span>{fmtDuration(p.durationMs)}</span>}
        </span>
      }
    >
      <div className="space-y-2.5">
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          <KV k="role" v={role.label} />
          <KV k="provider" v={`${providerName(p.provider)} (${p.provider} CLI)`} />
          <KV k="model" v={p.model} mono />
          <KV k="effort" v={p.effort} />
          <KV k="status" v={p.status + (p.simulated ? ' · simulated (mock mode)' : '')} />
          {p.response?.usage && (
            <KV k="tokens" v={`${fmtTokens(p.response.usage.inputTokens)} in · ${fmtTokens(p.response.usage.outputTokens)} out`} />
          )}
          {p.durationMs != null && <KV k="duration" v={fmtDuration(p.durationMs)} />}
          {p.cli && <KV k="cli" v={p.cli.command} mono />}
          {p.cli && <KV k="cwd" v={p.cli.cwd} mono />}
          {p.cli && p.cli.exitCode != null && <KV k="exit" v={String(p.cli.exitCode)} />}
        </div>
        <PromptBlock title="Request" text={p.request.prompt} />
        {p.response && <PromptBlock title="Response" text={p.response.text} />}
        {p.tools && p.tools.length > 0 && <ToolsAvailable tools={p.tools} />}
        {p.error && (
          <div className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-[12.5px] text-[#ffb3ae]">{p.error}</div>
        )}
      </div>
    </ActivityRow>
  );
}

function ToolsAvailable({ tools }: { tools: { name: string; description: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-linesoft bg-bg1">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] font-medium uppercase tracking-wide text-dim transition-colors hover:bg-bg2"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>›</span>
        Tandem tools available · {tools.length}
        {!open && (
          <span className="mono min-w-0 flex-1 truncate text-[11px] normal-case tracking-normal text-dim">
            {tools.map((t) => t.name).join(' · ')}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-linesoft px-3 py-2">
          {tools.map((t) => (
            <div key={t.name}>
              <div className="mono text-[12px] text-ink">{t.name}</div>
              <p className="text-[12px] leading-relaxed text-mut">{t.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-linesoft bg-[#0e1013]">
      <div className="flex items-center justify-between border-b border-linesoft px-3 py-1.5">
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-dim">{title}</span>
        <CopyButton text={text} />
      </div>
      <pre className="mono max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[12px] leading-[1.6] text-[#c3c9d4]">{text}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- findings

const reviewerLabel = (r: FindingsPayload['reviewer']) => (r === 'director_reviewer' ? 'Director Reviewer' : r === 'builder_reviewer' ? 'Builder Reviewer' : 'Reviewer');

export function FindingsRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as FindingsPayload;
  if (p.verdict === 'pass') {
    return (
      <div className="fade-up rounded-lg px-2 py-[5px]">
        <div className="flex items-center gap-2">
          <span className="w-[13px]" />
          <CircleCheck size={14} className="text-ok" />
          <span className="text-[13px] text-ok">{reviewerLabel(p.reviewer)} verdict · PASS</span>
          <span className="text-[11.5px] text-dim">round {p.round}</span>
        </div>
        {(p.verifiedEvidence?.length ?? 0) > 0 && (
          <div className="ml-[37px] mt-0.5 space-y-0.5 text-[12.5px] text-mut">
            {p.verifiedEvidence!.map((v) => <div key={v.id}><span className="mono text-dim">{v.id}</span> verified — {v.evidence}</div>)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="fade-up ml-[21px] my-1.5 overflow-hidden rounded-xl border border-warn/25 bg-[#191510]">
      <div className="flex items-center gap-2 border-b border-warn/15 px-3.5 py-2">
        <AlertTriangle size={14} className="text-warn" />
        <span className="text-[13px] font-medium text-warn">{reviewerLabel(p.reviewer)} findings · round {p.round}</span>
        <span className="text-[11.5px] text-dim">{p.round === 1 ? 'advisory — the Builder answers each one' : 'new findings and failed repairs only'}</span>
        {(p.repairSkippedAtCap || p.finalRepairNotReviewed) && (
          <span className="ml-auto rounded-full border border-line px-2 py-[1px] text-[10.5px] text-dim">
            {p.repairSkippedAtCap ? 'no further review — the Director decides on the final state' : 'final repair not re-reviewed'}
          </span>
        )}
      </div>
      <div className="space-y-3 px-3.5 py-2.5">
        {(p.verified?.length || p.repairFailed?.length || p.folded?.length) ? (
          <div className="space-y-1 text-[12.5px]">
            {p.verified?.map((id) => <div key={id} className="text-ok"><CircleCheck size={12} className="mr-1 inline" />{id} — repair verified, resolved</div>)}
            {p.repairFailed?.map((r) => <div key={r.id} className="text-err"><AlertTriangle size={12} className="mr-1 inline" />{r.id} — repair failed: <span className="text-mut">{r.evidence}</span></div>)}
            {p.folded?.map((r) => <div key={r.id} className="text-dim">{r.id} — restated by the Reviewer, not a new finding</div>)}
          </div>
        ) : null}
        {p.items.map((f, i) => (
          <div key={i} className="text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              {f.id && <span className="mono text-[11px] text-dim">{f.id}</span>}
              <span className={`rounded-full px-2 py-[1px] text-[10.5px] font-semibold uppercase tracking-wide ${
                f.severity === 'major' ? 'bg-err/15 text-err' : 'bg-warn/15 text-warn'
              }`}>{f.severity}</span>
              <span dir="auto" className="font-medium text-ink">{f.title}</span>
              {f.file && (
                <span className="mono text-[11.5px] text-accent/90">{f.file}{f.line ? `:${f.line}` : ''}</span>
              )}
            </div>
            <p dir="auto" className="mt-1 leading-relaxed text-mut">{f.detail}</p>
            {f.evidence && <p dir="auto" className="mt-0.5 text-[12.5px] text-dim"><span className="text-mut">Evidence:</span> {f.evidence}</p>}
            {f.category && <span className="mt-1 inline-block rounded-full border border-line px-2 py-[1px] text-[10.5px] text-dim">{f.category.replace('_', ' ')}</span>}
            {f.recommendation && <p dir="auto" className="mt-0.5 text-[12.5px] italic text-dim">Recommendation: {f.recommendation}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- project sessions (live block)

const SESSION_TONE: Record<string, string> = {
  running: 'text-accent', completed: 'text-ok', paused: 'text-dim',
  timeout: 'text-warn', failed: 'text-err', needs_attention: 'text-warn', planned: 'text-dim', abandoned: 'text-dim',
  awaiting_review: 'text-warn',
};

export function SessionsRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as SessionsPayload;
  const total = p.sessions.length;
  const done = p.sessions.filter((s) => s.status === 'completed').length;
  const running = p.sessions.filter((s) => s.status === 'running').length;
  const attention = p.sessions.some((s) => s.status === 'timeout' || s.status === 'needs_attention' || s.status === 'failed');

  const label = p.done
    ? <span className="text-ok">{done === total ? `${total} sessions completed` : `Sessions settled · ${done}/${total} completed`}</span>
    : attention
      ? <span>{running} running · <span className="text-warn">needs attention</span></span>
      : <span>{running} session{running === 1 ? '' : 's'} running{done > 0 ? ` · ${done} completed` : ''}</span>;

  return (
    <ActivityRow
      icon={attention ? <AlertTriangle size={14} /> : <Boxes size={14} />}
      running={!p.done}
      tone={attention ? 'warn' : 'default'}
      label={<span className="inline-flex items-center gap-2">{p.milestoneKey && <span className="text-dim">{p.milestoneKey} —</span>}{label}</span>}
      meta={p.milestoneName || undefined}
      defaultOpen={!p.done}
    >
      <div className="space-y-1.5">
        {p.sessions.map((s) => {
          const tone = SESSION_TONE[s.status] ?? 'text-mut';
          const dot = s.status === 'running' ? '●' : s.status === 'completed' ? '✓' : s.status === 'planned' ? '○' : s.status === 'paused' ? '⏸' : s.status === 'awaiting_review' ? '⏳' : '⚠';
          const inner = (
            <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
              <span className={`shrink-0 ${tone}`}>{dot}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="mono shrink-0 text-[12px] text-ink">{s.key}</span>
                  <span className="min-w-0 truncate text-[12.5px] text-mut">{s.name}</span>
                  {s.startedAt && s.status === 'running' && <span className="shrink-0 text-[11px] text-dim">{fmtDuration(Date.now() - s.startedAt)}</span>}
                  <span className={`ml-auto shrink-0 text-[11px] ${tone}`}>{s.status.replace(/_/g, ' ')}</span>
                </div>
                {s.agent && (
                  <div className="mt-0.5 text-[11px] text-dim">{s.agent.name} <span className="text-dim/70">· {s.agent.model} · {s.agent.effort}</span></div>
                )}
                {(s.builderState || s.reviewerState) && (
                  <div className="mt-0.5 flex flex-wrap gap-x-4 text-[11px] text-dim">
                    {s.builderState && <span>Builder <span className="text-mut">{s.builderState}</span></span>}
                    {s.reviewerState && <span>Reviewer <span className="text-mut">{s.reviewerState}</span></span>}
                  </div>
                )}
                {s.note && <div className="mt-0.5 truncate text-[11.5px] text-dim">{s.note}</div>}
              </div>
            </div>
          );
          return s.chatId
            ? <Link key={s.key} to={`/c/${s.chatId}`} className="block transition-colors hover:bg-bg2" title="Open this session">{inner}</Link>
            : <div key={s.key} className="opacity-80">{inner}</div>;
        })}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- integration tool call

export function ToolCallRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as ToolCallPayload;
  const failed = p.status === 'failed';
  const argsText = JSON.stringify(p.args ?? {});
  return (
    <ActivityRow
      icon={<Plug size={14} />}
      tone={failed ? 'error' : 'default'}
      label={
        <span>
          Tool · <span className="mono text-[12.5px]">{p.tool}</span>
          {p.status === 'running' && <span className="ml-2 text-dim">running…</span>}
        </span>
      }
      meta={`${p.integration}${p.durationMs != null ? ` · ${fmtDuration(p.durationMs)}` : ''}`}
    >
      <div className="space-y-2.5">
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          <KV k="source" v={p.integrationType ? `${p.integration} (${p.integrationType})` : p.integration} />
          <KV k="role" v={p.role} />
          <KV k="status" v={p.status} />
          {p.durationMs != null && <KV k="duration" v={fmtDuration(p.durationMs)} />}
        </div>
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">Arguments</div>
          <pre className="mono max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-[#c3c9d4]">{argsText}</pre>
        </div>
        {p.error && (
          <div className="rounded-lg border border-err/25 bg-err/[0.06] px-3 py-2 text-[12.5px] text-[#ffb3ae]">{p.error}</div>
        )}
        {p.resultPreview && (
          <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
            <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">
              Result{(p.resultBytes ?? 0) > p.resultPreview.length ? ` · preview of ${fmtTokens(p.resultBytes!)} chars` : ''}
            </div>
            <pre className="mono max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-[#c3c9d4]">{p.resultPreview}</pre>
          </div>
        )}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- compaction

export function CompactionRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as CompactionPayload;
  const est = p.source === 'estimated' ? '~' : '';
  const delta = p.beforeTokens != null && p.afterTokens != null
    ? `${est}${fmtTokens(p.beforeTokens)} → ${est}${fmtTokens(p.afterTokens)} tokens`
    : p.beforeTokens != null ? `was ${est}${fmtTokens(p.beforeTokens)} tokens` : null;
  return (
    <ActivityRow
      icon={<Archive size={14} />}
      label={
        <span>
          Context compacted{p.reason === 'provider-auto' ? ' automatically' : ''} · {providerName(p.provider)}
          {delta && <span className="ml-2 tabular-nums text-compactor">{delta}</span>}
        </span>
      }
      meta={p.model}
    >
      <div className="space-y-2.5">
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          {p.beforeTokens != null && <KV k="before" v={`${est}${fmtTokens(p.beforeTokens)} tokens`} />}
          {p.afterTokens != null && <KV k="after" v={`${est}${fmtTokens(p.afterTokens)} tokens`} />}
          {p.windowTokens != null && <KV k="provider window" v={`${fmtTokens(p.windowTokens)} tokens`} />}
          <KV k="compacted by" v={`${providerName(p.provider)} · ${p.model}${p.summary ? ' (legacy Compactor call)' : ' (provider-native)'}${p.simulated ? ' · simulated (mock mode)' : ''}`} />
          {p.reason && <KV k="reason" v={p.reason === 'manual' ? 'manual (Compact context)' : p.reason === 'auto' ? 'automatic (Tandem threshold)' : 'provider compacted on its own'} />}
          {p.source && <KV k="values" v={p.source === 'provider' ? 'provider-reported' : 'estimated'} />}
          {p.sessionId && <KV k="session" v={`${p.sessionId.slice(0, 8)}… (continues unchanged)`} />}
          {p.durationMs != null && <KV k="duration" v={fmtDuration(p.durationMs)} />}
        </div>
        {p.preserved && p.preserved.length > 0 && (
          <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
            <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">Preserved</div>
            <ul className="space-y-0.5">
              {p.preserved.map((x, i) => (
                <li key={i} className="text-[12.5px] text-mut">· {x}</li>
              ))}
            </ul>
          </div>
        )}
        {p.summary && (
          <div className="rounded-lg border border-linesoft bg-bg1 px-3.5 py-2.5">
            <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-dim">Compacted context</div>
            <Markdown text={p.summary} />
          </div>
        )}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- browser

const BROWSER_ICONS: Record<string, typeof Globe> = {
  navigate: Globe, back: Globe, forward: Globe, reload: Globe,
  click: MousePointerClick, type: Keyboard, select: Keyboard, press: Keyboard,
  scroll: MoveVertical, wait: Clock, screenshot: Camera, resize: Scan,
  console: SquareTerminal, snapshot: ListTree, evaluate: Braces,
};

export function BrowserGroupRow({ events }: { events: ChatEvent[] }) {
  const acts = events.map((e) => ({ id: e.chatId, ev: e, p: e.payload as BrowserActionPayload }));
  const failed = acts.filter((a) => a.p.status === 'failed').length;
  const elapsed = groupElapsed(events, false);
  const reviewer = acts[0].p.role === 'reviewer';
  const label = acts.length === 1
    ? <>Browser · {truncate(acts[0].p.detail, 62)}</>
    : <>Browser activity · {acts.length} actions</>;

  return (
    <ActivityRow
      icon={<Globe size={14} />}
      tone={failed > 0 ? 'error' : 'default'}
      label={
        <span className="inline-flex items-center gap-2">
          <span>{label}</span>
          {reviewer && <span className="inline-block h-[6px] w-[6px] rounded-full bg-reviewer" title="Driven by the Reviewer" />}
          {failed > 0 && <span className="text-err">{failed} failed</span>}
        </span>
      }
      meta={fmtDuration(elapsed)}
    >
      <div className="space-y-1.5">
        <ElapsedNote events={events} running={false} />
        {acts.map(({ ev, p }) => <BrowserActionDetail key={ev.id} chatId={ev.chatId} p={p} />)}
      </div>
    </ActivityRow>
  );
}

function BrowserActionDetail({ chatId, p }: { chatId: string; p: BrowserActionPayload }) {
  const Icon = BROWSER_ICONS[p.action] ?? Globe;
  return (
    <div className={`rounded-lg border px-3 py-2 ${p.status === 'failed' ? 'border-err/30 bg-err/[0.06]' : 'border-linesoft bg-bg1'}`}>
      <div className="flex items-baseline gap-2">
        <Icon size={13} className={`shrink-0 translate-y-[2px] ${p.status === 'failed' ? 'text-err' : 'text-dim'}`} />
        <span className="min-w-0 flex-1 text-[12.5px] text-ink">{p.detail}</span>
        {p.durationMs != null && <span className="shrink-0 text-[11px] tabular-nums text-dim">{fmtDuration(p.durationMs)}</span>}
      </div>
      {(p.url || p.viewport) && (
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 pl-[21px] text-[11.5px] text-dim">
          {p.url && <span className="mono min-w-0 max-w-full truncate" title={p.title}>{p.url}</span>}
          {p.viewport && <span className="shrink-0 tabular-nums">{p.viewport.width}×{p.viewport.height}{p.viewport.deviceScaleFactor && p.viewport.deviceScaleFactor !== 1 ? ` @${p.viewport.deviceScaleFactor}x` : ''}</span>}
        </div>
      )}
      {p.value && <div className="mono mt-0.5 pl-[21px] text-[11.5px] text-mut">↳ {p.value}</div>}
      {p.error && <div className="mt-1 pl-[21px] text-[12px] text-[#ffb3ae]">{p.error}</div>}
      {p.console && p.console.length > 0 && (
        <pre className="mono mt-1.5 ml-[21px] max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-linesoft bg-[#0e1013] px-2.5 py-1.5 text-[11.5px] leading-[1.55] text-[#c3c9d4]">
          {p.console.map((c, i) => <span key={i} className={c.level === 'error' ? 'text-[#ff9a94]' : c.level === 'warning' ? 'text-warn' : ''}>[{c.level}] {c.text}{'\n'}</span>)}
        </pre>
      )}
      {p.screenshotFile && (
        <a
          href={`/api/chats/${chatId}/shots/${p.screenshotFile}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 block pl-[21px]"
          title="Open full size"
        >
          <img
            src={`/api/chats/${chatId}/shots/${p.screenshotFile}`}
            alt={p.detail}
            loading="lazy"
            className="max-h-[260px] max-w-full rounded-lg border border-linesoft transition-opacity hover:opacity-90"
          />
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- git checkpoints

export function CheckpointRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as CheckpointPayload;
  const meta: Record<CheckpointPayload['action'], { icon: typeof GitCommitHorizontal; label: React.ReactNode }> = {
    commit: { icon: GitCommitHorizontal, label: <>Checkpoint saved{p.files?.length ? <> · {plural(p.files.length, 'file')}</> : null}</> },
    preserve: { icon: GitBranch, label: <>Uncommitted changes preserved · {plural(p.files?.length ?? 0, 'file')}</> },
    merge: { icon: GitMerge, label: <>Merged to <span className="mono text-[12px]">{p.target}</span></> },
    push: { icon: CloudUpload, label: <>Pushed to <span className="mono text-[12px]">origin/{p.target}</span></> },
  };
  const m = meta[p.action] ?? meta.commit;
  return (
    <ActivityRow
      icon={<m.icon size={14} />}
      label={m.label}
      meta={p.commit ? <span className="mono">{p.commit}</span> : undefined}
    >
      <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
        <KV k="branch" v={p.branch} mono />
        {p.target && <KV k="target" v={p.target} mono />}
        {p.commit && <KV k="commit" v={p.commit} mono />}
        {p.message && <KV k="message" v={p.message} />}
        {p.files && p.files.length > 0 && (
          <div className="mt-1.5 border-t border-linesoft pt-1.5">
            {p.files.map((f) => <div key={f} className="mono py-[1px] text-[11.5px] text-mut">{f}</div>)}
          </div>
        )}
      </div>
    </ActivityRow>
  );
}

// ---------------------------------------------------------------- error / status / run

export function ErrorRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as ErrorPayload;
  return (
    <div className="fade-up ml-[21px] my-1.5 rounded-xl border border-err/30 bg-[#1c1214] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <OctagonX size={14} className="shrink-0 text-err" />
        <span className="text-[13px] font-medium text-[#ffb3ae]">{p.message}</span>
        {p.source && <span className="ml-auto text-[11px] uppercase tracking-wide text-dim">{p.source}</span>}
      </div>
      {p.detail && <p dir="auto" className="mt-1 pl-[22px] text-[12.5px] leading-relaxed text-mut">{p.detail}</p>}
    </div>
  );
}

export function StatusLine({ ev }: { ev: ChatEvent }) {
  return (
    <div dir="auto" className="fade-up px-2 py-[3px] pl-[47px] text-[12.5px] italic text-dim">
      {(ev.payload as StatusPayload).text}
    </div>
  );
}

export function RunMarker({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as RunPayload;
  if (p.phase !== 'stopped' && p.phase !== 'failed') return null;
  return (
    <div className={`fade-up flex items-center gap-2 px-2 py-1 pl-[26px] text-[12.5px] ${p.phase === 'failed' ? 'text-err' : 'text-dim'}`}>
      <CircleSlash size={13} />
      {p.phase === 'stopped' ? 'Run stopped' : 'Run failed'}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function matchCount(n: number): string {
  return `${n} ${n === 1 ? 'match' : 'matches'}`;
}


// ---------------------------------------------------------------- dispositions & arbitration

const DISPOSITION_STYLE: Record<string, string> = {
  accepted: 'bg-ok/15 text-ok',
  partially_accepted: 'bg-ok/10 text-ok',
  rejected: 'bg-err/15 text-err',
  cannot_address: 'bg-warn/15 text-warn',
};

/** The Builder's answer to each finding — what it fixed, what it rejected and why. */
export function DispositionsRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as DispositionsPayload;
  return (
    <div className="fade-up ml-[21px] my-1.5 overflow-hidden rounded-xl border border-line bg-[#131417]">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
        <span className="h-[8px] w-[8px] rounded-full bg-builder" />
        <span className="text-[13px] font-medium">Builder&apos;s response to the findings · round {p.round}</span>
        {p.final && <span className="text-[11.5px] text-dim">final pass — nothing after this is re-reviewed</span>}
      </div>
      <div className="space-y-2.5 px-3.5 py-2.5">
        {p.items.map((r) => (
          <div key={r.index} className="text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-[1px] text-[10.5px] font-semibold uppercase tracking-wide ${DISPOSITION_STYLE[r.disposition] ?? 'bg-line text-dim'}`}>
                {r.disposition.replace('_', ' ')}
              </span>
              <span dir="auto" className="font-medium text-ink">{r.id ?? `${r.index}.`} {r.title}</span>
              {r.source === 'assumed' && <span className="text-[11px] text-dim">(not answered — recorded as accepted)</span>}
            </div>
            <p dir="auto" className="mt-0.5 leading-relaxed text-mut">{r.reason}</p>
            {r.evidence && <p dir="auto" className="mt-0.5 text-[12.5px] text-dim"><span className="text-mut">Evidence:</span> {r.evidence}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

const DECISION_LABEL: Record<string, { label: string; cls: string }> = {
  builder_upheld: { label: 'Builder upheld', cls: 'bg-ok/15 text-ok' },
  reviewer_upheld: { label: 'Reviewer upheld', cls: 'bg-err/15 text-err' },
  non_blocking: { label: 'Non-blocking', cls: 'bg-line text-dim' },
  deferred: { label: 'Deferred', cls: 'bg-line text-dim' },
  different_resolution_required: { label: 'Different resolution required', cls: 'bg-warn/15 text-warn' },
  unresolved: { label: 'Undecided — stands open', cls: 'bg-err/15 text-err' },
};

/** The Director's decision on each disputed finding, with its reasoning. */
export function ArbitrationRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as ArbitrationPayload;
  return (
    <div className="fade-up ml-[21px] my-1.5 overflow-hidden rounded-xl border border-accent/25 bg-[#12141a]">
      <div className="flex items-center gap-2 border-b border-accent/15 px-3.5 py-2">
        <span className="h-[8px] w-[8px] rounded-full bg-accent" />
        <span className="text-[13px] font-medium text-accent">{p.final ? 'Director\'s final decision' : 'Director\'s decision'} · round {p.round}</span>
        {p.final && <span className={`text-[11.5px] ${p.proceed === false ? 'text-err' : 'text-ok'}`}>{p.proceed === false ? 'may not proceed as it stands' : p.proceed ? 'may proceed' : ''}</span>}
        {p.failed && <span className="ml-auto text-[11.5px] text-err">the Director could not decide: {p.failed}</span>}
      </div>
      <div className="space-y-2.5 px-3.5 py-2.5">
        {p.summary && <p dir="auto" className="text-[12.5px] text-mut">{p.summary}</p>}
        {p.items.map((a) => {
          const d = DECISION_LABEL[a.decision] ?? { label: a.decision, cls: 'bg-line text-dim' };
          return (
            <div key={a.index} className="text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-[1px] text-[10.5px] font-semibold uppercase tracking-wide ${d.cls}`}>{d.label}</span>
                <span dir="auto" className="font-medium text-ink">{a.id ?? `${a.index}.`} {a.title}</span>
                {a.disposition && <span className="text-[11px] text-dim">Builder said: {a.disposition.replace('_', ' ')}</span>}
                {a.repairStatus && <span className="text-[11px] text-dim">repair {a.repairStatus}</span>}
                <span className={`ml-auto text-[11px] ${a.blocking ? 'text-err' : 'text-dim'}`}>{a.blocking ? 'blocking' : 'not blocking'}</span>
              </div>
              <p dir="auto" className="mt-0.5 leading-relaxed text-mut">{a.reason}</p>
              {a.required && <p dir="auto" className="mt-0.5 text-[12.5px] text-dim"><span className="text-mut">Required:</span> {a.required}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
