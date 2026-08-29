import { Archive } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ContextUsage } from '@shared/types';
import { fmtTokens } from '../lib/format';
import { useStore } from '../store';

function pctTone(pct: number, settings: AppSettings | null): 'ok' | 'warn' | 'crit' {
  const warn = settings?.context.warnPct ?? 70;
  const crit = settings?.context.critPct ?? 88;
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'ok';
}

const toneColor = { ok: 'var(--color-mut)', warn: 'var(--color-warn)', crit: 'var(--color-err)' } as const;

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
  const tone = pctTone(usage.pct, settings);
  const color = toneColor[tone];
  const pct = Math.min(100, usage.pct);
  const r = 6.5;
  const c = 2 * Math.PI * r;

  return (
    <div className="relative" ref={ref}>
      <button
        className="chip cursor-pointer rounded-lg py-1 transition-colors hover:bg-bg3"
        onClick={() => setOpen((o) => !o)}
        title="Context usage (estimated)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-line)" strokeWidth="2.5" />
          <circle
            cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * c} ${c}`}
          />
        </svg>
        <span className="tabular-nums" style={{ color: tone === 'ok' ? undefined : color }}>
          {fmtTokens(usage.usedTokens)} / {fmtTokens(usage.limit)}
        </span>
      </button>

      {open && (
        <div className="card absolute right-0 top-[34px] z-40 w-[280px] p-3.5 shadow-2xl shadow-black/50 fade-up">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[13px] font-medium">Context</span>
            <span className="text-[12px] tabular-nums" style={{ color }}>{usage.pct}%</span>
          </div>
          <div className="mb-2.5 h-[6px] overflow-hidden rounded-full bg-bg3">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
          </div>
          <div className="space-y-1 text-[12px] text-mut">
            <Row k="Effective context" v={`~${fmtTokens(usage.usedTokens)} tokens`} />
            <Row k="Configured limit" v={`${fmtTokens(usage.limit)} tokens`} />
            <div className="my-1.5 border-t border-linesoft" />
            <Row k="Carried (last call / compaction)" v={fmtTokens(usage.breakdown.carried)} />
            <Row k="Recent activity" v={fmtTokens(usage.breakdown.recent)} />
            <Row k="Role instructions & overhead" v={fmtTokens(usage.breakdown.overhead)} />
          </div>
          <p className="mt-2 text-[11px] leading-snug text-dim">
            Estimated from stored events and the last reported provider usage — not an exact provider number.
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
  if (!usage || !settings) return null;
  const tone = pctTone(usage.pct, settings);
  if (tone === 'ok') return null;
  const crit = tone === 'crit';
  return (
    <div className={`flex items-center justify-center gap-3 border-b px-4 py-[7px] text-[12.5px] ${
      crit ? 'border-err/25 bg-err/10 text-[#ffb3ae]' : 'border-warn/20 bg-warn/[0.07] text-warn'
    }`}>
      <span>
        {crit ? 'Context is nearly full' : 'Context is getting large'} — {usage.pct}% of {fmtTokens(usage.limit)} tokens
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
