import { Archive, Bot, Check, Pencil, Plus, RotateCcw, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile, Effort } from '@shared/types';
import { CLAUDE_MODELS, EFFORTS, MAX_AGENT_PROMPT_CHARS } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';
import { Field, Modal, SelectBox, Spinner, Toggle } from '../ui';

/**
 * Builder Agents — the admin surface over agent_profiles.
 *
 * Everything here renders from server records: there is no per-agent component,
 * no four-card assumption and no client-side knowledge of what any agent means.
 * Provider is shown but never editable — Builder execution is Claude Code only
 * in this version, and the server rejects anything else regardless of the UI.
 */
export function AgentsSection() {
  const toast = useStore((s) => s.toast);
  const [agents, setAgents] = useState<AgentProfile[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(archived = showArchived) {
    setAgents(await api.agents(archived));
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showArchived]);

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusyId(id);
    try {
      await fn();
      await load();
      toast(ok);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const active = (agents ?? []).filter((a) => !a.archivedAt);
  const archived = (agents ?? []).filter((a) => a.archivedAt);
  const enabledCount = active.filter((a) => a.enabled).length;

  return (
    <div className="space-y-3">
      <div className="card px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex items-center gap-2 text-[13.5px] font-semibold"><Bot size={15} className="text-builder" /> Builder Agents</span>
          <span className="text-[12px] text-dim">
            {agents === null ? 'Loading…' : `${enabledCount} enabled · ${active.length} total`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-ghost text-[12px]" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide archived' : 'Show archived'}
            </button>
            <button className="btn-outline gap-1.5 py-[6px] text-[12.5px]" onClick={() => setEditing('new')}>
              <Plus size={14} /> Add agent
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-dim">
          The Project Director picks one of these for every session it plans. Agents are configuration, not code —
          add a specialist here and it appears in the Director&apos;s catalog immediately, with no restart or deploy.
          Profile changes apply to new sessions only; running sessions keep the configuration they started with.
        </p>
      </div>

      {agents === null && <div className="card flex items-center gap-2 px-4 py-6 text-[12.5px] text-dim"><Spinner size={14} /> Loading agents…</div>}
      {agents !== null && active.length === 0 && (
        <div className="card px-4 py-6 text-center text-[12.5px] text-dim">
          No Builder Agents yet. <button className="text-accent hover:underline" onClick={() => setEditing('new')}>Add the first one</button>.
        </div>
      )}

      {active.map((a) => (
        <AgentCard
          key={a.id}
          agent={a}
          busy={busyId === a.id}
          onEdit={() => setEditing(a)}
          onToggle={() => void act(a.id, () => api.updateAgent(a.id, { enabled: !a.enabled }), a.enabled ? `${a.name} disabled` : `${a.name} enabled`)}
          onDefault={() => void act(a.id, () => api.setDefaultAgent(a.id), `${a.name} is now the default agent`)}
          onArchive={() => void act(a.id, () => api.archiveAgent(a.id), `${a.name} archived`)}
        />
      ))}

      {showArchived && archived.length > 0 && (
        <>
          <p className="px-1 pt-2 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-dim">Archived</p>
          {archived.map((a) => (
            <div key={a.id} className="card flex items-center gap-3 px-4 py-3 opacity-70">
              <span className="min-w-0 flex-1 truncate text-[13px]">{a.name} <span className="mono text-[11.5px] text-dim">{a.slug}</span></span>
              <span className="text-[11.5px] text-dim">archived · history preserved</span>
              <button className="btn-ghost gap-1.5 text-[12px]" disabled={busyId === a.id} onClick={() => void act(a.id, () => api.restoreAgent(a.id), `${a.name} restored`)}>
                <RotateCcw size={13} /> Restore
              </button>
            </div>
          ))}
        </>
      )}

      {editing && (
        <AgentEditor
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); await load(); toast(msg); }}
        />
      )}
    </div>
  );
}

function AgentCard({ agent, busy, onEdit, onToggle, onDefault, onArchive }: {
  agent: AgentProfile; busy: boolean;
  onEdit: () => void; onToggle: () => void; onDefault: () => void; onArchive: () => void;
}) {
  return (
    <div className={`card px-4 py-3.5 ${agent.enabled ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="truncate text-[13.5px] font-semibold">{agent.name}</span>
        <span className="mono rounded bg-bg3 px-1.5 py-0.5 text-[11px] text-dim">{agent.slug}</span>
        {agent.isDefault && (
          <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
            <Star size={10} /> Default
          </span>
        )}
        {!agent.enabled && <span className="rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-dim">Disabled</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {busy && <Spinner size={13} />}
          <button className="btn-ghost gap-1.5 text-[12px]" onClick={onEdit}><Pencil size={13} /> Edit</button>
          {!agent.isDefault && (
            <button className="btn-ghost gap-1.5 text-[12px]" disabled={busy || !agent.enabled} title={agent.enabled ? 'Make this the default agent' : 'Enable the agent first'} onClick={onDefault}>
              <Star size={13} /> Set default
            </button>
          )}
          {!agent.isDefault && (
            <button className="btn-ghost gap-1.5 text-[12px] text-mut hover:text-err" disabled={busy} onClick={onArchive}>
              <Archive size={13} /> Archive
            </button>
          )}
          <Toggle checked={agent.enabled} onChange={onToggle} label={`${agent.name} enabled`} />
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-dim">{agent.description || 'No description.'}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-dim">
        <span>Provider <span className="mono text-mut">Claude Code CLI</span></span>
        <span>Model <span className="mono text-mut">{agent.model}</span></span>
        <span>Reasoning <span className="mono text-mut">{agent.effort}</span></span>
      </div>
    </div>
  );
}

const BLANK = {
  name: '', slug: '', description: '', systemPrompt: '',
  model: CLAUDE_MODELS[1] as string, effort: 'high' as Effort, enabled: true,
};

function AgentEditor({ agent, onClose, onSaved }: {
  agent: AgentProfile | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(() => (agent
    ? { name: agent.name, slug: agent.slug, description: agent.description, systemPrompt: agent.systemPrompt, model: agent.model, effort: agent.effort, enabled: agent.enabled }
    : { ...BLANK }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  // a new agent's slug follows its name until the admin types one deliberately
  const [slugTouched, setSlugTouched] = useState(!!agent);
  const autoSlug = useMemo(
    () => draft.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40),
    [draft.name],
  );
  const slug = slugTouched ? draft.slug : autoSlug;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = { ...draft, slug };
      if (agent) await api.updateAgent(agent.id, payload);
      else await api.createAgent(payload);
      await onSaved(agent ? `${draft.name} saved` : `${draft.name} created`);
    } catch (err) {
      // never report success on a failed persist
      setError(err instanceof Error ? err.message : 'Could not save the agent.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={agent ? `Edit ${agent.name}` : 'New Builder Agent'} width={760}>
      <div className="space-y-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={draft.name} autoFocus placeholder="e.g. Database Specialist" onChange={(e) => set({ name: e.target.value })} />
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

        <Field label="Description" hint="shown to the Director when it chooses an agent">
          <textarea
            className="input min-h-[52px] resize-y text-[13px]"
            value={draft.description}
            placeholder="What kind of work this agent is best at."
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Provider / CLI" hint="fixed">
            <input className="input mono text-[12.5px] opacity-60" value="Claude Code CLI" disabled aria-label="Agent provider (fixed)" />
          </Field>
          <Field label="Model">
            <SelectBox
              ariaLabel="Agent model"
              value={draft.model}
              onChange={(v) => set({ model: v })}
              options={CLAUDE_MODELS.map((m) => ({ value: m, label: m }))}
            />
          </Field>
          <Field label="Reasoning effort">
            <SelectBox
              ariaLabel="Agent reasoning effort"
              value={draft.effort}
              onChange={(v) => set({ effort: v as Effort })}
              options={EFFORTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))}
            />
          </Field>
        </div>

        <Field
          label="System prompt"
          hint={`appended to Tandem's Builder instructions — ${draft.systemPrompt.length.toLocaleString()} / ${MAX_AGENT_PROMPT_CHARS.toLocaleString()} characters`}
        >
          <textarea
            className="input mono min-h-[320px] resize-y whitespace-pre text-[12.5px] leading-relaxed"
            value={draft.systemPrompt}
            spellCheck={false}
            placeholder="You are Tandem's …"
            onChange={(e) => set({ systemPrompt: e.target.value })}
          />
        </Field>

        <div className="flex items-center gap-2.5">
          <Toggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Agent enabled" />
          <span className="text-[12.5px] text-mut">Enabled — the Director may choose this agent</span>
        </div>

        <p className="rounded-md bg-bg2 px-3 py-2 text-[12px] leading-relaxed text-dim">
          Profile changes apply to new sessions only. Existing sessions retain the Agent configuration they started with.
        </p>

        {error && <p className="rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-err">{error}</p>}

        <div className="flex justify-end gap-2 pt-0.5">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary gap-2" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner size={13} /> : <Check size={14} />} {agent ? 'Save agent' : 'Create agent'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
