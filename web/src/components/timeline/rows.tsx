import {
  AlertTriangle, Archive, CircleCheck, CircleSlash, FileDiff, FileText, OctagonX, Search as SearchIcon, Sparkles, Terminal,
} from 'lucide-react';
import type {
  AiCallPayload, ChatEvent, CommandPayload, CompactionPayload, ErrorPayload, FileChangePayload,
  FileReadPayload, FindingsPayload, RunPayload, SearchPayload, StatusPayload,
} from '@shared/types';
import { fmtDuration, fmtTokens, plural } from '../../lib/format';
import { DiffView } from '../DiffView';
import { CopyButton, Markdown } from '../Markdown';
import { ActivityRow, KV } from './ActivityRow';

const roleMeta: Record<string, { label: string; dot: string }> = {
  builder: { label: 'Builder', dot: 'bg-builder' },
  reviewer: { label: 'Reviewer', dot: 'bg-reviewer' },
  compactor: { label: 'Compactor', dot: 'bg-compactor' },
  final_repair: { label: 'Final repair', dot: 'bg-builder' },
};

const providerName = (p: string) => (p === 'claude-code' ? 'Claude' : p === 'codex' ? 'Codex' : p);

// ---------------------------------------------------------------- commands

export function CommandGroupRow({ events }: { events: ChatEvent[] }) {
  const cmds = events.map((e) => e.payload as CommandPayload);
  const running = cmds.some((c) => c.status === 'running');
  const failed = cmds.filter((c) => c.status === 'done' && (c.exitCode ?? 0) !== 0).length;
  const total = cmds.reduce((n, c) => n + (c.durationMs || 0), 0);
  const label = cmds.length === 1
    ? <>Ran <code className="mono text-[12px] text-mut">{truncate(cmds[0].command, 60)}</code></>
    : <>Ran {plural(cmds.length, 'command')}</>;

  return (
    <ActivityRow
      icon={<Terminal size={14} />}
      label={<>{label}{failed > 0 && <span className="ml-2 text-err">{failed} failed</span>}</>}
      meta={fmtDuration(total)}
      running={running}
      tone={failed > 0 ? 'error' : 'default'}
    >
      <div className="space-y-2">
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
            {r.lines != null && <span className="shrink-0 text-[11px] tabular-nums text-dim">{r.lines} lines</span>}
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
        {p.error && (
          <div className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-[12.5px] text-[#ffb3ae]">{p.error}</div>
        )}
      </div>
    </ActivityRow>
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

export function FindingsRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as FindingsPayload;
  if (p.verdict === 'pass') {
    return (
      <div className="fade-up flex items-center gap-2 rounded-lg px-2 py-[5px]">
        <span className="w-[13px]" />
        <CircleCheck size={14} className="text-ok" />
        <span className="text-[13px] text-ok">Reviewer verdict · PASS</span>
        <span className="text-[11.5px] text-dim">round {p.round}</span>
      </div>
    );
  }
  return (
    <div className="fade-up ml-[21px] my-1.5 overflow-hidden rounded-xl border border-warn/25 bg-[#191510]">
      <div className="flex items-center gap-2 border-b border-warn/15 px-3.5 py-2">
        <AlertTriangle size={14} className="text-warn" />
        <span className="text-[13px] font-medium text-warn">Reviewer findings · round {p.round}</span>
        {p.finalRepairNotReviewed && (
          <span className="ml-auto rounded-full border border-line px-2 py-[1px] text-[10.5px] text-dim">
            final repair not re-reviewed
          </span>
        )}
      </div>
      <div className="space-y-3 px-3.5 py-2.5">
        {p.items.map((f, i) => (
          <div key={i} className="text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-[1px] text-[10.5px] font-semibold uppercase tracking-wide ${
                f.severity === 'major' ? 'bg-err/15 text-err' : 'bg-warn/15 text-warn'
              }`}>{f.severity}</span>
              <span className="font-medium text-ink">{f.title}</span>
              {f.file && (
                <span className="mono text-[11.5px] text-accent/90">{f.file}{f.line ? `:${f.line}` : ''}</span>
              )}
            </div>
            <p className="mt-1 leading-relaxed text-mut">{f.detail}</p>
            {f.recommendation && <p className="mt-0.5 text-[12.5px] italic text-dim">Recommendation: {f.recommendation}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- compaction

export function CompactionRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as CompactionPayload;
  return (
    <ActivityRow
      icon={<Archive size={14} />}
      label={
        <span>
          Context compacted
          <span className="ml-2 tabular-nums text-compactor">{fmtTokens(p.beforeTokens)} → {fmtTokens(p.afterTokens)} tokens</span>
        </span>
      }
      meta={p.model}
    >
      <div className="space-y-2.5">
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          <KV k="before" v={`~${fmtTokens(p.beforeTokens)} tokens`} />
          <KV k="after" v={`~${fmtTokens(p.afterTokens)} tokens`} />
          <KV k="compactor" v={`${providerName(p.provider)} · ${p.model}${p.simulated ? ' · simulated (mock mode)' : ''}`} />
          <KV k="duration" v={fmtDuration(p.durationMs)} />
        </div>
        <div className="rounded-lg border border-linesoft bg-bg1 px-3 py-2">
          <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">Preserved</div>
          <ul className="space-y-0.5">
            {p.preserved.map((x, i) => (
              <li key={i} className="text-[12.5px] text-mut">· {x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-linesoft bg-bg1 px-3.5 py-2.5">
          <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-dim">Compacted context</div>
          <Markdown text={p.summary} />
        </div>
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
      {p.detail && <p className="mt-1 pl-[22px] text-[12.5px] leading-relaxed text-mut">{p.detail}</p>}
    </div>
  );
}

export function StatusLine({ ev }: { ev: ChatEvent }) {
  return (
    <div className="fade-up px-2 py-[3px] pl-[47px] text-[12.5px] italic text-dim">
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
