import { ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PromptEntry, PromptGroup } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Spinner } from '../ui';

const GROUPS: { key: PromptGroup; title: string; blurb: string }[] = [
  { key: 'builder', title: 'Builder', blurb: 'Instructions and message templates for every Builder call.' },
  { key: 'reviewer', title: 'Reviewer', blurb: 'Instructions, evidence sections, and the PASS/FINDINGS contract.' },
  { key: 'repair', title: 'Repair', blurb: 'How reviewer findings are handed back, and the final repair round.' },
  { key: 'compactor', title: 'Compactor', blurb: 'Context compaction instructions and the digest wrapper.' },
];

export function PromptsSection() {
  const toast = useStore((s) => s.toast);
  const [entries, setEntries] = useState<PromptEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    api.prompts()
      .then(setEntries)
      .catch((err) => toast(err instanceof Error ? err.message : 'Failed to load prompts', 'error'));
  }, [toast]);

  const byGroup = useMemo(() => {
    const map = new Map<PromptGroup, PromptEntry[]>();
    for (const e of entries ?? []) {
      map.set(e.group, [...(map.get(e.group) ?? []), e]);
    }
    return map;
  }, [entries]);

  const applyUpdated = (updated: PromptEntry) => {
    setEntries((list) => (list ?? []).map((e) => (e.key === updated.key ? updated : e)));
    setDrafts((d) => {
      const copy = { ...d };
      delete copy[updated.key];
      return copy;
    });
  };

  async function save(entry: PromptEntry) {
    const draft = drafts[entry.key];
    if (draft === undefined) return;
    setBusyKey(entry.key);
    try {
      applyUpdated(await api.savePrompt(entry.key, draft));
      toast(`Saved — ${entry.name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(entry: PromptEntry) {
    setBusyKey(entry.key);
    try {
      applyUpdated(await api.resetPrompt(entry.key));
      toast(`Reset to default — ${entry.name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Reset failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  if (!entries) {
    return (
      <div className="card flex justify-center px-4 py-8">
        <Spinner size={16} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-dim">
        Every static instruction Tandem itself sends to Claude or Codex — the runtime values in{' '}
        <code className="mono text-[11px] text-mut">{'{{placeholders}}'}</code> are filled in by the application at
        call time. Editing wording never weakens code-enforced boundaries (Reviewer stays filesystem-read-only, the
        review loop stays capped, Stop still kills processes). The exact assembled request of every call remains
        inspectable in the chat timeline.
      </p>

      {GROUPS.map((g) => {
        const list = byGroup.get(g.key) ?? [];
        if (list.length === 0) return null;
        const customized = list.filter((e) => e.customized).length;
        return (
          <div key={g.key} className="card overflow-hidden">
            <div className="border-b border-linesoft px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[13.5px] font-semibold">{g.title}</span>
                <span className="text-[11.5px] text-dim">{list.length} prompts</span>
                {customized > 0 && <span className="ml-auto text-[11.5px] text-warn">{customized} customized</span>}
              </div>
              <p className="mt-0.5 text-[12px] text-dim">{g.blurb}</p>
            </div>
            <div className="divide-y divide-linesoft/60">
              {list.map((entry) => (
                <PromptRow
                  key={entry.key}
                  entry={entry}
                  open={open === entry.key}
                  onToggle={() => setOpen(open === entry.key ? null : entry.key)}
                  draft={drafts[entry.key]}
                  onDraft={(v) => setDrafts((d) => ({ ...d, [entry.key]: v }))}
                  onSave={() => void save(entry)}
                  onReset={() => void reset(entry)}
                  busy={busyKey === entry.key}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PromptRow({ entry, open, onToggle, draft, onDraft, onSave, onReset, busy }: {
  entry: PromptEntry;
  open: boolean;
  onToggle: () => void;
  draft: string | undefined;
  onDraft: (v: string) => void;
  onSave: () => void;
  onReset: () => void;
  busy: boolean;
}) {
  const value = draft ?? entry.value;
  const dirty = draft !== undefined && draft !== entry.value;
  const rows = Math.min(16, Math.max(3, value.split('\n').length + 1));

  return (
    <div>
      <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-bg2" onClick={onToggle}>
        <ChevronRight size={13} className={`shrink-0 text-dim transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 text-[13px] text-ink">{entry.name}</span>
        {entry.customized && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn" title="Customized — differs from the default" />}
        {!open && <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{entry.description}</span>}
      </button>

      {open && (
        <div className="px-4 pb-4 pl-[30px]">
          <p className="mb-2 text-[12px] leading-relaxed text-dim">
            {entry.description}
            <span className="text-mut"> · sent to: {entry.roles.join(', ')}</span>
          </p>
          {entry.placeholders.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-dim">Runtime values:</span>
              {entry.placeholders.map((ph) => (
                <code key={ph} className="mono rounded-md bg-bg3 px-1.5 py-[1px] text-[11px] text-compactor">{`{{${ph}}}`}</code>
              ))}
            </div>
          )}
          <textarea
            className="input mono min-h-[72px] resize-y text-[12px] leading-[1.6]"
            rows={rows}
            value={value}
            spellCheck={false}
            onChange={(e) => onDraft(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            {(entry.customized || dirty) && (
              <button className="btn-ghost text-[12px]" onClick={onReset} disabled={busy} title="Restore the built-in default">
                <RotateCcw size={12} /> Reset to default
              </button>
            )}
            <span className="flex-1" />
            {dirty && <span className="text-[11.5px] text-dim">unsaved</span>}
            <button className="btn-primary px-3 py-1" onClick={onSave} disabled={!dirty || busy}>
              {busy ? <Spinner size={12} /> : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
