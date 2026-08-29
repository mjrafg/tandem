import { ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ToolInfo } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Spinner } from '../ui';

interface Draft {
  description: string;
  params: Record<string, string>;
}

export function ToolsSection() {
  const toast = useStore((s) => s.toast);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    api.tools()
      .then(setTools)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load tools'));
  }, []);

  const byServer = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const t of tools ?? []) map.set(t.serverLabel, [...(map.get(t.serverLabel) ?? []), t]);
    return map;
  }, [tools]);

  const keyOf = (t: ToolInfo) => `${t.server}.${t.name}`;

  const applyUpdated = (updated: ToolInfo) => {
    setTools((list) => (list ?? []).map((t) => (t.server === updated.server && t.name === updated.name ? updated : t)));
    setDrafts((d) => {
      const copy = { ...d };
      delete copy[`${updated.server}.${updated.name}`];
      return copy;
    });
  };

  async function save(t: ToolInfo) {
    const draft = drafts[keyOf(t)];
    if (!draft) return;
    setBusyKey(keyOf(t));
    try {
      applyUpdated(await api.saveTool(t.server, t.name, { description: draft.description, params: draft.params }));
      toast(`Saved — ${t.name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function reset(t: ToolInfo) {
    setBusyKey(keyOf(t));
    try {
      applyUpdated(await api.resetTool(t.server, t.name));
      toast(`Reset to default — ${t.name}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Reset failed', 'error');
    } finally {
      setBusyKey(null);
    }
  }

  if (error) {
    return <div className="card px-4 py-3 text-[12.5px] text-[#ffb3ae]">{error}</div>;
  }
  if (!tools) {
    return <div className="card flex justify-center px-4 py-8"><Spinner size={16} /></div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-dim">
        The tools Tandem itself exposes to the AIs over MCP, discovered live from the production servers — exactly what
        Claude and Codex are served. The human-written descriptions are editable and take effect on the next AI
        invocation; names, parameter types, required/enum structure, and the tools' actual behavior stay in code.
      </p>

      {[...byServer.entries()].map(([label, list]) => {
        const customized = list.filter((t) => t.customized).length;
        return (
          <div key={label} className="card overflow-hidden">
            <div className="border-b border-linesoft px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[13.5px] font-semibold">{label}</span>
                <span className="text-[11.5px] text-dim">{list.length} tool{list.length === 1 ? '' : 's'} · sent to: {list[0].roles.join(', ')}</span>
                {customized > 0 && <span className="ml-auto text-[11.5px] text-warn">{customized} customized</span>}
              </div>
            </div>
            <div className="divide-y divide-linesoft/60">
              {list.map((t) => (
                <ToolRow
                  key={keyOf(t)}
                  tool={t}
                  open={open === keyOf(t)}
                  onToggle={() => setOpen(open === keyOf(t) ? null : keyOf(t))}
                  draft={drafts[keyOf(t)]}
                  onDraft={(d) => setDrafts((all) => ({ ...all, [keyOf(t)]: d }))}
                  onSave={() => void save(t)}
                  onReset={() => void reset(t)}
                  busy={busyKey === keyOf(t)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolRow({ tool, open, onToggle, draft, onDraft, onSave, onReset, busy }: {
  tool: ToolInfo;
  open: boolean;
  onToggle: () => void;
  draft: Draft | undefined;
  onDraft: (d: Draft) => void;
  onSave: () => void;
  onReset: () => void;
  busy: boolean;
}) {
  const current: Draft = draft ?? {
    description: tool.description,
    params: Object.fromEntries(tool.params.map((p) => [p.name, p.description])),
  };
  const dirty = draft !== undefined && (
    draft.description !== tool.description
    || tool.params.some((p) => (draft.params[p.name] ?? '') !== p.description)
  );

  return (
    <div>
      <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-bg2" onClick={onToggle}>
        <ChevronRight size={13} className={`shrink-0 text-dim transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
        <span className="mono shrink-0 text-[12.5px] text-ink">{tool.name}</span>
        {tool.customized && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-warn" title="Customized — differs from the default" />}
        {!open && <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{tool.description}</span>}
      </button>

      {open && (
        <div className="px-4 pb-4 pl-[30px]">
          <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-dim">Description (sent to the model)</div>
          <textarea
            className="input min-h-[56px] resize-y text-[12.5px] leading-relaxed"
            rows={Math.min(8, Math.max(2, current.description.split('\n').length + 1))}
            value={current.description}
            spellCheck={false}
            onChange={(e) => onDraft({ ...current, description: e.target.value })}
          />

          {tool.params.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-dim">Parameters</div>
              {tool.params.map((p) => (
                <div key={p.name} className="rounded-lg border border-linesoft bg-bg0 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mono text-[12px] text-ink">{p.name}</span>
                    <span className="chip bg-bg3 py-0 text-[10.5px]">{p.type}</span>
                    <span className={`chip py-0 text-[10.5px] ${p.required ? 'bg-warn/15 text-warn' : 'bg-bg3'}`}>{p.required ? 'required' : 'optional'}</span>
                    {p.enumValues && <span className="mono text-[10.5px] text-dim">{p.enumValues.join(' | ')}</span>}
                    {p.customized && <span className="h-[5px] w-[5px] rounded-full bg-warn" />}
                  </div>
                  <input
                    className="input mt-1.5 rounded-md px-2 py-1 text-[12px]"
                    placeholder="(no description sent for this parameter)"
                    value={current.params[p.name] ?? ''}
                    spellCheck={false}
                    onChange={(e) => onDraft({ ...current, params: { ...current.params, [p.name]: e.target.value } })}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-2">
            {(tool.customized || dirty) && (
              <button className="btn-ghost text-[12px]" onClick={onReset} disabled={busy} title="Restore the built-in description text">
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
