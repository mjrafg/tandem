import { Check, CircleDollarSign, Library, Repeat, X } from 'lucide-react';
import { useState } from 'react';
import type { ApprovalPayload, ChatEvent } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Spinner } from '../ui';

/**
 * A decision only the user makes: the production plan and its cost, adding a
 * project asset to the channel, moving a video to another channel version.
 * The agents can ask; nothing happens until someone clicks here.
 */
export function ApprovalRow({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as ApprovalPayload;
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);

  async function decide(decision: 'approve' | 'decline') {
    setBusy(decision);
    try {
      await api.decideApproval(p.id, decision);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record the decision', 'error');
    } finally {
      setBusy(null);
    }
  }

  const Icon = p.kind === 'production' ? CircleDollarSign : p.kind === 'promotion' ? Library : Repeat;
  const lines = Array.isArray(p.detail.lines) ? (p.detail.lines as { label: string; usd: number }[]) : [];
  const total = typeof p.detail.totalUsd === 'number' ? p.detail.totalUsd : null;
  const reused = Array.isArray(p.detail.reusedAssets) ? p.detail.reusedAssets.length : null;

  return (
    <div className={`my-2 overflow-hidden rounded-xl border ${p.status === 'pending' ? 'border-warn/40 bg-warn/[0.05]' : 'border-linesoft bg-bg1'}`}>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg3 text-mut"><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-semibold">{p.title}</span>
            <span className={`text-[11.5px] ${p.status === 'approved' ? 'text-ok' : p.status === 'declined' ? 'text-err' : 'text-warn'}`}>
              {p.status === 'pending' ? 'waiting for you' : p.status}
            </span>
          </div>
          {p.summary && <p dir="auto" className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-mut">{p.summary}</p>}
        </div>
      </div>

      {p.kind === 'production' && lines.length > 0 && (
        <div className="border-t border-linesoft px-3.5 py-2.5">
          <table className="w-full text-[12.5px] tabular-nums">
            <tbody>
              {lines.map((l) => (
                <tr key={l.label}><td className="py-0.5 text-mut">{l.label}</td><td className="py-0.5 text-right">${l.usd.toFixed(2)}</td></tr>
              ))}
              {total !== null && (
                <tr className="border-t border-linesoft font-semibold"><td className="pt-1.5">Estimated total</td><td className="pt-1.5 text-right">${total.toFixed(2)}</td></tr>
              )}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11.5px] text-dim">
            {reused !== null ? `${reused} existing asset${reused === 1 ? '' : 's'} reused. ` : ''}
            {typeof p.detail.narrationSeconds === 'number' ? `About ${Math.round(p.detail.narrationSeconds as number)} s of narration. ` : ''}
            An estimate from the rates in Settings → Video production — provider bills may differ. Approving sets this as the budget; going over it needs another approval.
          </p>
        </div>
      )}

      {p.status === 'pending' && (
        <div className="flex justify-end gap-2 border-t border-linesoft px-3.5 py-2.5">
          <button className="btn-ghost gap-1.5 text-[12.5px]" disabled={!!busy} onClick={() => void decide('decline')}>
            {busy === 'decline' ? <Spinner size={12} /> : <X size={13} />} Decline
          </button>
          <button className="btn-primary gap-1.5 text-[12.5px]" disabled={!!busy} onClick={() => void decide('approve')}>
            {busy === 'approve' ? <Spinner size={12} /> : <Check size={13} />} Approve
          </button>
        </div>
      )}
    </div>
  );
}
