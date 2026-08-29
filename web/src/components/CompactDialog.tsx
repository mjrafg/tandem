import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CompactPreview } from '@shared/types';
import { api } from '../api';
import { fmtTokens } from '../lib/format';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { Modal, Spinner } from './ui';

export function CompactDialog({ chatId, open, onClose }: { chatId: string; open: boolean; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [preview, setPreview] = useState<CompactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
      setShowSummary(false);
      return;
    }
    let cancelled = false;
    api.compactPreview(chatId)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed'); });
    return () => { cancelled = true; };
  }, [open, chatId]);

  async function apply() {
    if (!preview) return;
    setApplying(true);
    try {
      await api.compactApply(chatId, preview.previewId);
      toast('Context compacted');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compact context"
      width={620}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => void apply()} disabled={!preview || applying}>
            {applying ? <Spinner size={13} /> : 'Apply'}
          </button>
        </>
      }
    >
      {error && <p className="rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-[#ffb3ae]">{error}</p>}
      {!preview && !error && (
        <div className="flex items-center gap-3 py-8 justify-center text-[13px] text-mut">
          <Spinner size={16} />
          {settings ? `${settings.roles.compactor.model} is summarizing the conversation…` : 'Preparing preview…'}
        </div>
      )}
      {preview && (
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-5 py-2">
            <TokenStat label="Before" value={preview.beforeTokens} />
            <ArrowRight size={18} className="text-dim" />
            <TokenStat label="After (approx.)" value={preview.afterTokens} accent />
          </div>
          <p className="text-center text-[12px] text-dim">
            Compacted by {preview.provider === 'claude-code' ? 'Claude' : 'Codex'} · {preview.model}. The full
            conversation history stays intact — only the context supplied to future AI calls shrinks.
          </p>
          <div className="rounded-lg border border-linesoft bg-bg0 px-3.5 py-2.5">
            <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">Preserved</div>
            <ul className="space-y-0.5 text-[12.5px] text-mut">
              {preview.preserved.map((p, i) => <li key={i}>· {p}</li>)}
            </ul>
          </div>
          <div>
            <button className="btn-ghost -ml-2 text-[12.5px]" onClick={() => setShowSummary((s) => !s)}>
              {showSummary ? 'Hide compacted context' : 'View compacted context'}
            </button>
            {showSummary && (
              <div className="mt-1 max-h-[300px] overflow-y-auto rounded-lg border border-linesoft bg-bg0 px-3.5 py-2.5">
                <Markdown text={preview.summary} />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function TokenStat({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="text-center">
      <div className={`text-[22px] font-semibold tabular-nums ${accent ? 'text-compactor' : 'text-ink'}`}>
        {fmtTokens(value)}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-dim">{label}</div>
    </div>
  );
}
