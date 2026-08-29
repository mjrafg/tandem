import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CompactOutcome } from '@shared/types';
import { api } from '../api';
import { fmtTokens } from '../lib/format';
import { useStore } from '../store';
import { Modal, Spinner } from './ui';

/**
 * Provider-native compaction: the provider that owns this chat's session
 * compacts its own context (e.g. Claude Code `/compact` on the resumed
 * session). No separate Compactor model, no summary to approve — the dialog
 * confirms, runs, and shows the provider-reported before/after.
 */
export function CompactDialog({ chatId, open, onClose }: { chatId: string; open: boolean; onClose: () => void }) {
  const usage = useStore((s) => s.usage[chatId]);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done' | 'error'>('confirm');
  const [outcome, setOutcome] = useState<CompactOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPhase('confirm');
      setOutcome(null);
      setError(null);
    }
  }, [open]);

  const provider = usage?.provider ?? 'claude-code';
  const providerLabel = provider === 'claude-code' ? 'Claude' : 'Codex';

  async function run() {
    setPhase('running');
    try {
      const out = await api.compact(chatId);
      setOutcome(out);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compaction failed');
      setPhase('error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={phase === 'running' ? () => {} : onClose}
      title="Compact context"
      width={520}
      footer={
        phase === 'confirm' ? (
          <>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={() => void run()}>Compact via {providerLabel}</button>
          </>
        ) : phase === 'running' ? (
          <span className="text-[12px] text-dim">This can take a while on large sessions…</span>
        ) : (
          <button className="btn-primary" onClick={onClose}>Done</button>
        )
      }
    >
      {phase === 'confirm' && (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-mut">
            {providerLabel} will compact its own active session context — the provider summarizes internally and the
            same session continues. Nothing is sent to any other model.
          </p>
          {usage && usage.usedTokens != null && (
            <p className="text-[12.5px] text-dim">
              Current context: {usage.source === 'provider' ? '' : '~'}{fmtTokens(usage.usedTokens + usage.pendingTokens)}
              {usage.windowTokens ? ` of ${fmtTokens(usage.windowTokens)}` : ''} tokens
              {usage.source === 'provider' ? ` (${providerLabel}-reported)` : ' (estimated)'}.
            </p>
          )}
          <p className="text-[12px] leading-relaxed text-dim">
            The full chat history in Tandem — messages, activity, exports — stays complete either way.
          </p>
        </div>
      )}

      {phase === 'running' && (
        <div className="flex items-center justify-center gap-3 py-8 text-[13px] text-mut">
          <Spinner size={16} />
          {providerLabel} is compacting its own session context…
        </div>
      )}

      {phase === 'error' && (
        <p className="rounded-md bg-err/10 px-3 py-2 text-[12.5px] leading-relaxed text-[#ffb3ae]">{error}</p>
      )}

      {phase === 'done' && outcome && (
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-5 py-2">
            <TokenStat label="Before" value={outcome.beforeTokens} />
            <ArrowRight size={18} className="text-dim" />
            <TokenStat label="After" value={outcome.afterTokens} accent />
          </div>
          <p className="text-center text-[12px] leading-relaxed text-dim">
            Compacted natively by {providerLabel} · {outcome.model}
            {outcome.source ? ` — values ${outcome.source === 'provider' ? `${providerLabel}-reported` : 'estimated'}` : ''}.
            The session continues; full history remains stored and exportable.
          </p>
        </div>
      )}
    </Modal>
  );
}

function TokenStat({ label, value, accent = false }: { label: string; value?: number; accent?: boolean }) {
  return (
    <div className="text-center">
      <div className={`text-[22px] font-semibold tabular-nums ${accent ? 'text-compactor' : 'text-ink'}`}>
        {value == null ? '—' : fmtTokens(value)}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-dim">{label}</div>
    </div>
  );
}
