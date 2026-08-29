import { Archive } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ContextUsage } from '@shared/types';
import { fmtTokens } from '../lib/format';
import { useStore } from '../store';

function pctTone(pct: number | null, settings: AppSettings | null): 'ok' | 'warn' | 'crit' {
  if (pct == null) return 'ok';
  const warn = settings?.context.warnPct ?? 70;
  const crit = settings?.context.critPct ?? 88;
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'ok';
}

const toneColor = { ok: 'var(--color-mut)', warn: 'var(--color-warn)', crit: 'var(--color-err)' } as const;

const providerName = (p: ContextUsage['provider']) => (p === 'claude-code' ? 'Claude Code' : 'Codex');

/** total the meter tracks: last provider report + estimated pending activity */
function totalTokens(u: ContextUsage): number | null {
  return u.usedTokens == null ? null : u.usedTokens + u.pendingTokens;
}

export function ContextMeter({ usage, onCompact }: { usage: ContextUsage | undefined; onCompact: () => void }) {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!usage) return null;
  const total = totalTokens(usage);
  const tone = pctTone(usage.pct, settings);
  const color = toneColor[tone];
  const ringPct = Math.min(100, usage.pct ?? 0);
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const approx = usage.source !== 'provider' || usage.pendingTokens > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        className="chip cursor-pointer rounded-lg py-1 transition-colors hover:bg-bg3"
        onClick={() => setOpen((o) => !o)}
        title="Active provider context"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
          {usage.pct != null && (
            <circle
              cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(ringPct / 100) * c} ${c}`}
            />
          )}
        </svg>
        <span className="tabular-nums" style={{ color: tone === 'ok' ? undefined : color }}>
          {total == null ? '—' : `${approx ? '~' : ''}${fmtTokens(total)}`} / {usage.windowTokens ? fmtTokens(usage.windowTokens) : '?'}
        </span>
      </button>

      {open && (
        <div className="card absolute right-0 top-[34px] z-40 w-[300px] p-3.5 shadow-2xl shadow-black/50 fade-up">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[13px] font-medium">Context</span>
            {usage.pct != null && <span className="text-[12px] tabular-nums" style={{ color }}>{usage.pct}%</span>}
          </div>
          <div className="mb-2.5 h-[6px] overflow-hidden rounded-full bg-bg3">
            <div className="h-full rounded-full transition-all" style={{ width: `${ringPct}%`, background: usage.pct != null ? color : 'transparent' }} />
          </div>
          <div className="space-y-1 text-[12px] text-mut">
            <Row
              k="Used"
              v={usage.usedTokens == null ? 'no provider report yet' : `${usage.source === 'provider' ? '' : '~'}${fmtTokens(usage.usedTokens)} tokens`}
            />
            {usage.pendingTokens > 0 && usage.usedTokens != null && (
              <Row k="Since last report" v={`+ ~${fmtTokens(usage.pendingTokens)} (estimate)`} />
            )}
            <Row k="Provider window" v={usage.windowTokens ? `${fmtTokens(usage.windowTokens)} tokens` : 'unknown'} />
            {settings?.context.autoCompact && <Row k="Auto compact" v={`at ${settings.context.compactPct}%`} />}
            <div className="my-1.5 border-t border-linesoft" />
            <Row k="Source" v={usage.source === 'provider' ? providerName(usage.provider) : usage.source === 'estimated' ? 'estimated' : '—'} />
            {usage.model && <Row k="Model" v={usage.model} />}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-dim">
            {usage.source === 'provider'
              ? `Used is the ${providerName(usage.provider)}-reported size of the active session context; activity since then is a separate estimate.`
              : usage.source === 'estimated'
                ? 'No exact provider report is available for this state — values marked ~ are Tandem estimates.'
                : 'The provider reports real context numbers once the conversation has its first call.'}
          </p>
          <button className="btn-outline mt-3 w-full" onClick={() => { setOpen(false); onCompact(); }}>
            <Archive size={13} /> Compact context…
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

export function ContextBanner({ usage, onCompact }: { usage: ContextUsage | undefined; onCompact: () => void }) {
  const settings = useStore((s) => s.settings);
  if (!usage || !settings || usage.pct == null) return null;
  const tone = pctTone(usage.pct, settings);
  if (tone === 'ok') return null;
  const crit = tone === 'crit';
  return (
    <div className={`flex items-center justify-center gap-3 border-b px-4 py-[7px] text-[12.5px] ${
      crit ? 'border-err/25 bg-err/10 text-[#ffb3ae]' : 'border-warn/20 bg-warn/[0.07] text-warn'
    }`}>
      <span>
        {crit ? 'Context is nearly full' : 'Context is getting large'} — {usage.pct}% of the {usage.windowTokens ? fmtTokens(usage.windowTokens) : ''} provider window
        {settings.context.autoCompact ? ' · auto-compact is on' : ''}
      </span>
      <button
        className={`rounded-md px-2.5 py-[3px] text-[12px] font-medium transition-colors ${
          crit ? 'bg-err/20 hover:bg-err/30 text-[#ffc9c5]' : 'bg-warn/15 hover:bg-warn/25'
        }`}
        onClick={onCompact}
      >
        Compact
      </button>
    </div>
  );
}
