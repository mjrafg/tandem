import { Archive, ChevronRight, Plus, RotateCcw, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AgentProfile } from '@shared/types';
import { api } from '../../../api';
import { useStore } from '../../../store';
import { Spinner, Toggle } from '../../ui';
import { PageHeader } from '../SettingsLayout';

/**
 * Builder Agents — list surface over agent_profiles.
 *
 * Rendered entirely from server records: no per-agent component, no four-card
 * assumption, no client knowledge of what any agent means. Editing happens on a
 * dedicated route so the list stays scannable as profiles accumulate.
 */
export function AgentsPage() {
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(archived = showArchived) {
    try {
      setAgents(await api.agents(archived));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agents.');
      setAgents([]);
    }
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
    <>
      <PageHeader
        title="Builder Agents"
        action={<button className="btn-primary gap-1.5 py-[7px] text-[12.5px]" onClick={() => navigate('new')}><Plus size={14} /> Add agent</button>}
      >
        The Project Director assigns one of these to every session it plans. Agents are configuration, not code — add a
        specialist here and it appears in the Director&apos;s catalog immediately, with no restart or deploy. Profile
        changes apply to new sessions only; running sessions keep the configuration they started with.
      </PageHeader>

      <div className="mb-2.5 flex items-center gap-3 px-1">
        <span className="text-[12px] text-dim">{agents === null ? 'Loading…' : `${enabledCount} enabled · ${active.length} total`}</span>
        <button className="btn-ghost ml-auto text-[12px]" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>

      {error && <div className="card mb-3 px-4 py-3 text-[12.5px] text-err">{error}</div>}
      {agents === null && <div className="card flex items-center gap-2 px-4 py-6 text-[12.5px] text-dim"><Spinner size={14} /> Loading agents…</div>}
      {agents !== null && active.length === 0 && !error && (
        <div className="card px-4 py-8 text-center text-[12.5px] text-dim">
          No Builder Agents yet. <Link to="new" className="text-accent hover:underline">Add the first one</Link>.
        </div>
      )}

      <div className="space-y-2">
        {active.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            busy={busyId === a.id}
            onToggle={() => void act(a.id, () => api.updateAgent(a.id, { enabled: !a.enabled }), a.enabled ? `${a.name} disabled` : `${a.name} enabled`)}
            onDefault={() => void act(a.id, () => api.setDefaultAgent(a.id), `${a.name} is now the default agent`)}
            onArchive={() => void act(a.id, () => api.archiveAgent(a.id), `${a.name} archived`)}
          />
        ))}
      </div>

      {showArchived && archived.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Archived</h2>
          <div className="space-y-2">
            {archived.map((a) => (
              <div key={a.id} className="card flex flex-wrap items-center gap-2 px-3.5 py-2.5 opacity-70">
                <span className="min-w-0 flex-1 truncate text-[13px]">{a.name} <span className="mono text-[11.5px] text-dim">{a.slug}</span></span>
                <span className="text-[11.5px] text-dim">history preserved</span>
                <button className="btn-ghost gap-1.5 text-[12px]" disabled={busyId === a.id} onClick={() => void act(a.id, () => api.restoreAgent(a.id), `${a.name} restored`)}>
                  <RotateCcw size={13} /> Restore
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function AgentRow({ agent, busy, onToggle, onDefault, onArchive }: {
  agent: AgentProfile; busy: boolean; onToggle: () => void; onDefault: () => void; onArchive: () => void;
}) {
  return (
    <div className={`card overflow-hidden ${agent.enabled ? '' : 'opacity-70'}`}>
      <Link to={agent.id} className="block px-3.5 py-3 transition-colors hover:bg-bg2" aria-label={`Edit ${agent.name}`}>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">{agent.name}</span>
          <span className="mono shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[11px] text-dim">{agent.slug}</span>
          {agent.isDefault && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">
              <Star size={10} /> Default
            </span>
          )}
          {!agent.enabled && <span className="shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-dim">Disabled</span>}
          <ChevronRight size={15} className="ml-auto shrink-0 text-dim" />
        </div>
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-dim">{agent.description || 'No description.'}</p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-dim">
          <span>Claude Code CLI</span>
          <span className="mono text-mut">{agent.model}</span>
          <span className="mono text-mut">{agent.effort}</span>
        </div>
      </Link>
      <div className="flex items-center gap-1 border-t border-linesoft px-2.5 py-1.5">
        {busy && <Spinner size={13} />}
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
        <span className="ml-auto flex items-center gap-2 pr-1">
          <span className="text-[11.5px] text-dim">{agent.enabled ? 'Enabled' : 'Disabled'}</span>
          <Toggle checked={agent.enabled} onChange={onToggle} label={`${agent.name} enabled`} />
        </span>
      </div>
    </div>
  );
}
