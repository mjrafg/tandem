import { ArrowLeft, Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentProfile, Effort } from '@shared/types';
import { CLAUDE_MODELS, EFFORTS, MAX_AGENT_PROMPT_CHARS } from '@shared/types';
import { api } from '../../../api';
import { useStore } from '../../../store';
import { Field, SelectBox, Spinner, Toggle } from '../../ui';

const BLANK = {
  name: '', slug: '', description: '', systemPrompt: '',
  model: CLAUDE_MODELS[1] as string, effort: 'high' as Effort, enabled: true,
};

/**
 * One agent, on its own route — grouped into identity, runtime and the
 * specialist prompt rather than one undifferentiated form. Provider is shown
 * but never editable: Builder execution is Claude Code only in this version,
 * and the server rejects anything else regardless of what the UI sends.
 */
export function AgentEditorPage() {
  const { agentId } = useParams();
  const isNew = agentId === 'new';
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);

  const [agent, setAgent] = useState<AgentProfile | null>(null);
  // the draft lives in the store, keyed by agent id: Admin is a place you
  // navigate around, and losing a long prompt to a stray nav click would be
  // this refactor's own bug
  const stored = useStore((s) => s.agentDrafts[agentId ?? '']) as typeof BLANK | undefined;
  const [draft, setDraftLocal] = useState(stored ?? { ...BLANK });
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(!isNew && !stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(!isNew);

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api.agents(true)
      .then((list) => {
        if (cancelled) return;
        const found = list.find((a) => a.id === agentId) ?? null;
        setAgent(found);
        if (!found) { setNotFound(true); return; }
        // an in-progress edit wins over the server copy
        if (!useStore.getState().agentDrafts[agentId!]) {
          setDraftLocal({
            name: found.name, slug: found.slug, description: found.description,
            systemPrompt: found.systemPrompt, model: found.model, effort: found.effort, enabled: found.enabled,
          });
        }
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the agent.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, isNew]);

  const set = (patch: Partial<typeof draft>) => setDraftLocal((d) => {
    const next = { ...d, ...patch };
    useStore.setState((s) => ({ agentDrafts: { ...s.agentDrafts, [agentId ?? '']: next } }));
    return next;
  });

  const clearDraft = () => useStore.setState((s) => {
    const rest = { ...s.agentDrafts };
    delete rest[agentId ?? ''];
    return { agentDrafts: rest };
  });
  const autoSlug = useMemo(
    () => draft.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
    [draft.name],
  );
  const slug = slugTouched ? draft.slug : autoSlug;

  const dirty = agent
    ? agent.name !== draft.name || agent.slug !== slug || agent.description !== draft.description
      || agent.systemPrompt !== draft.systemPrompt || agent.model !== draft.model
      || agent.effort !== draft.effort || agent.enabled !== draft.enabled
    : !!(draft.name || draft.description || draft.systemPrompt);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...draft, slug };
      if (isNew) await api.createAgent(payload);
      else await api.updateAgent(agentId!, payload);
      toast(isNew ? `${draft.name} created` : `${draft.name} saved`);
      clearDraft();
      navigate('/settings/agents');
    } catch (err) {
      // never navigate away or claim success on a failed persist
      setError(err instanceof Error ? err.message : 'Could not save the agent.');
    } finally {
      setSaving(false);
    }
  }

  function back() {
    if (dirty && !window.confirm('Discard unsaved changes to this agent?')) return;
    clearDraft();
    navigate('/settings/agents');
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner size={18} /></div>;

  // an unknown id must never look like a blank create form with a live Save
  if (notFound) {
    return (
      <div className="card px-4 py-8 text-center">
        <p className="text-[13px] text-mut">This Builder Agent no longer exists.</p>
        <p className="mt-1 text-[12px] text-dim">It may have been removed, or the link may be out of date.</p>
        <button className="btn-outline mt-3" onClick={() => navigate('/settings/agents')}>Back to Builder Agents</button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <button className="btn-ghost -ml-2 gap-1.5 px-2 text-[12.5px]" onClick={back}><ArrowLeft size={15} /> Builder Agents</button>
      </div>
      <h1 className="mb-4 text-[16px] font-semibold">{isNew ? 'New Builder Agent' : agent?.name ?? 'Agent'}</h1>

      {error && <div className="card mb-3 border-err/40 px-4 py-3 text-[12.5px] text-err">{error}</div>}

      <div className="space-y-3">
        <section className="card px-4 py-3.5">
          <h2 className="mb-3 text-[13px] font-semibold">Identity</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className="input" value={draft.name} autoFocus={isNew} placeholder="e.g. Database Specialist" onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Slug" hint="lowercase, digits and hyphens">
              <input
                className="input mono text-[12.5px]"
                value={slug}
                placeholder="database"
                onChange={(e) => { setSlugTouched(true); set({ slug: e.target.value }); }}
              />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Description" hint="shown to the Director when it chooses an agent">
              <textarea
                className="input min-h-[52px] resize-y text-[13px]"
                value={draft.description}
                placeholder="What kind of work this agent is best at."
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>
          </div>
        </section>

        <section className="card px-4 py-3.5">
          <h2 className="mb-3 text-[13px] font-semibold">Runtime</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Provider / CLI" hint="fixed">
              <input className="input mono text-[12.5px] opacity-60" value="Claude Code CLI" disabled aria-label="Agent provider (fixed)" />
            </Field>
            <Field label="Model" hint="type any model the CLI accepts">
              <>
                {/* free text, not a picker: new models ship faster than Tandem
                    releases, and the known ones are only suggestions */}
                <input
                  className="input mono text-[12.5px]"
                  list="agent-models"
                  value={draft.model}
                  aria-label="Agent model"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="claude-sonnet-5"
                  onChange={(e) => set({ model: e.target.value })}
                />
                <datalist id="agent-models">
                  {CLAUDE_MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
              </>
            </Field>
            <Field label="Reasoning effort">
              <SelectBox ariaLabel="Agent reasoning effort" value={draft.effort} onChange={(v) => set({ effort: v as Effort })} options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))} />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2.5 border-t border-linesoft pt-3">
            <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Agent enabled" />
            <span className="text-[12.5px] text-mut">Enabled — the Director may choose this agent for new sessions</span>
          </div>
        </section>

        <section className="card px-4 py-3.5">
          <h2 className="text-[13px] font-semibold">System prompt</h2>
          <p className="mb-2.5 mt-1 text-[12px] leading-relaxed text-dim">
            Appended to Tandem&apos;s Builder instructions — it specializes the Builder, it never replaces the engine&apos;s
            rules. {draft.systemPrompt.length.toLocaleString()} / {MAX_AGENT_PROMPT_CHARS.toLocaleString()} characters.
          </p>
          <textarea
            className="input mono min-h-[46vh] resize-y whitespace-pre text-[12.5px] leading-relaxed"
            value={draft.systemPrompt}
            spellCheck={false}
            placeholder="You are Tandem's …"
            onChange={(e) => set({ systemPrompt: e.target.value })}
          />
        </section>

        <p className="rounded-md bg-bg2 px-3 py-2 text-[12px] leading-relaxed text-dim">
          Profile changes apply to new sessions only. Existing sessions retain the Agent configuration they started with.
        </p>
      </div>

      <div className="pointer-events-none sticky bottom-0 z-30 flex justify-center pb-4 pt-3">
        <div className="pointer-events-auto card flex items-center gap-3 px-4 py-2.5 shadow-2xl shadow-black/50">
          {dirty && <span className="text-[12.5px] text-mut">Unsaved changes</span>}
          <button className="btn-ghost" onClick={back} disabled={saving}>Cancel</button>
          <button className="btn-primary gap-2" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner size={13} /> : <Check size={14} />} {isNew ? 'Create agent' : 'Save agent'}
          </button>
        </div>
      </div>
    </>
  );
}
