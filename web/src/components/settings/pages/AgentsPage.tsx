import { Archive, ChevronRight, Download, Plus, RotateCcw, Star, Upload, Lock } from 'lucide-react';
import { DIFFICULTY_ROUTING_ENABLED } from '@shared/features';
import { useEffect, useRef, useState } from 'react';
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
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function runImport(file: File) {
    setImporting(true);
    try {
      const { summary } = await api.importAgents(JSON.parse(await file.text()));
      await load();
      const parts = [
        summary.created.length ? `${summary.created.length} created` : '',
        summary.updated.length ? `${summary.updated.length} updated` : '',
        summary.skipped.length ? `${summary.skipped.length} skipped` : '',
      ].filter(Boolean).join(' · ') || 'nothing to import';
      toast(`Import: ${parts}`, summary.skipped.length ? 'error' : 'info');
      if (summary.skipped.length) {
        // say WHICH ones and why, instead of a silent partial success
        setError(`Skipped: ${summary.skipped.map((s) => `${s.slug} (${s.reason})`).join(' · ')}`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
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

      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span className="text-[12px] text-dim">{agents === null ? 'Loading…' : `${enabledCount} enabled · ${active.length} total`}</span>
        <span className="ml-auto flex items-center gap-1">
          <button className="btn-ghost text-[12px]" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <a
            href={`${api.agentsExportUrl}${showArchived ? '?archived=1' : ''}`}
            download
            className="btn-ghost gap-1.5 text-[12px]"
            title="Download these agents as JSON — portable between Tandem instances"
          >
            <Download size={13} /> Export
          </a>
          <button className="btn-ghost gap-1.5 text-[12px]" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? <Spinner size={13} /> : <Upload size={13} />} Import
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void runImport(f); }}
          />
        </span>
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
            onToggleEnforce={() => void act(a.id, () => api.updateAgent(a.id, { enforceModel: !a.enforceModel }), a.enforceModel ? `${a.name} no longer pins its own model` : `${a.name} always runs on its own model`)}
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

function AgentRow({ agent, busy, onToggle, onToggleEnforce, onDefault, onArchive }: {
  agent: AgentProfile; busy: boolean; onToggle: () => void; onToggleEnforce: () => void; onDefault: () => void; onArchive: () => void;
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
          {agent.enforceModel && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-mut" title={DIFFICULTY_ROUTING_ENABLED ? 'Always runs on its own model — difficulty tiers do not override it' : 'Pinned to its own model. Nothing overrides it today; difficulty tiers, which could, are archived'}>
              <Lock size={10} /> Model enforced
            </span>
          )}
          {!agent.enabled && <span className="shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-dim">Disabled</span>}
          <ChevronRight size={15} className="ml-auto shrink-0 text-dim" />
        </div>
        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-dim">{agent.description || 'No description.'}</p>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-dim">
          <span>{agent.provider === 'codex' ? 'Codex CLI' : 'Claude Code CLI'}</span>
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
        <span className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-1 pr-1">
          <span
            className="flex items-center gap-2"
            title={agent.enforceModel
              ? `On: this agent always runs on its own provider, model and effort${DIFFICULTY_ROUTING_ENABLED ? ' — difficulty tiers do not override it' : ''}`
              : (DIFFICULTY_ROUTING_ENABLED
                ? 'Off: a configured difficulty tier decides the model; this agent contributes its instructions only'
                : 'Off. Difficulty tiers, the only thing that overrode an agent\'s model, are archived, so this changes nothing today')}
          >
            <span className="text-[11.5px] text-dim">Enforce model</span>
            <Toggle checked={agent.enforceModel} onChange={onToggleEnforce} label={`${agent.name} enforces its model`} />
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[11.5px] text-dim">{agent.enabled ? 'Enabled' : 'Disabled'}</span>
            <Toggle checked={agent.enabled} onChange={onToggle} label={`${agent.name} enabled`} />
          </span>
        </span>
      </div>
    </div>
  );
}
