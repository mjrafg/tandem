import { Boxes, ChevronRight, Pause, Play, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PdActivity, PdMilestone, PdSession, ProjectRunState } from '@shared/types';
import { api } from '../api';
import { fmtDuration } from '../lib/format';
import { useStore } from '../store';
import { Spinner } from './ui';

const STATE_TONE: Record<ProjectRunState, string> = {
  PLANNING: 'text-accent', RUNNING: 'text-ok', PAUSING: 'text-warn', PAUSED: 'text-dim',
  RESUMING: 'text-accent', COMPLETED: 'text-ok', NEEDS_USER: 'text-warn', FAILED: 'text-err',
};

const MS_DOT: Record<string, string> = {
  planned: '○', ready: '○', running: '●', integrating: '◐', completed: '✓', blocked: '⚠',
};

/**
 * The complete STRUCTURAL view of a project run. It slides in from the right;
 * the Project Chat stays the primary surface. On desktop it can sit open beside
 * the chat and collapse; on mobile it overlays.
 */
export function ProjectDrawer({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const run = useStore((s) => s.projectRuns[runId]);
  const loadProjectRun = useStore((s) => s.loadProjectRun);
  const toast = useStore((s) => s.toast);
  const [activity, setActivity] = useState<PdActivity[]>([]);
  const [tab, setTab] = useState<'milestones' | 'activity'>('milestones');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadProjectRun(runId);
    api.projectRun(runId).then((r) => setActivity(r.activity)).catch(() => undefined);
  }, [open, runId, loadProjectRun, run?.updatedAt]);

  async function pauseResume() {
    if (!run) return;
    setBusy(true);
    try {
      if (run.state === 'PAUSED' || run.state === 'NEEDS_USER') await api.resumeProjectRun(runId);
      else await api.pauseProjectRun(runId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryReviews() {
    setBusy(true);
    try {
      const { requeued, runState } = await api.retryProjectReviews(runId);
      const live = ['RUNNING', 'RESUMING', 'PLANNING'].includes(runState);
      toast(requeued === 0
        ? 'No reviews were waiting to retry'
        : live
          ? `${requeued} waiting review${requeued === 1 ? '' : 's'} retrying now`
          // paused/needs-user: the retry was brought forward but the engine only
          // fires it once the project is running again — say so honestly
          : `${requeued} review${requeued === 1 ? '' : 's'} re-queued — will retry when the project resumes`);
      void loadProjectRun(runId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Retry failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const canPause = run && ['RUNNING', 'RESUMING', 'PLANNING'].includes(run.state);
  const canResume = run && ['PAUSED', 'NEEDS_USER'].includes(run.state);
  // sessions blocked on a provider outage (e.g. Codex usage limit) — the user
  // can force their scheduled retry now, e.g. after lifting the limit
  const waitingReviews = run
    ? run.milestones.flatMap((m) => m.sessions).filter((s) => s.status === 'awaiting_review').length
    : 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-[320px] max-w-[88vw] flex-col border-l border-linesoft bg-bg1 shadow-2xl shadow-black/40 lg:static lg:z-auto lg:w-[300px] lg:shadow-none">
        <div className="flex items-center justify-between gap-2 border-b border-linesoft px-3.5 py-3">
          <span className="inline-flex min-w-0 items-center gap-2">
            <Boxes size={15} className="shrink-0 text-dim" />
            <span className="min-w-0 truncate text-[13.5px] font-semibold">{run?.title || 'Project'}</span>
          </span>
          <button className="btn-ghost -mr-1 px-1.5 py-1.5 lg:hidden" onClick={onClose} aria-label="Close project panel"><X size={15} /></button>
        </div>

        {!run ? (
          <div className="flex flex-1 items-center justify-center"><Spinner size={16} /></div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-linesoft px-3.5 py-2.5">
              <span className={`text-[12px] font-medium ${STATE_TONE[run.state]}`}>{run.state}</span>
              <div className="flex items-center gap-1.5">
                {waitingReviews > 0 && (
                  <button
                    className="btn-outline px-2.5 py-1 text-[12px]"
                    disabled={busy}
                    onClick={() => void retryReviews()}
                    title="Retry reviews waiting on a provider limit now (e.g. after upgrading Codex)"
                  >
                    <RotateCw size={12} /> Retry {waitingReviews} review{waitingReviews === 1 ? '' : 's'}
                  </button>
                )}
                {(canPause || canResume) && (
                  <button className="btn-outline px-2.5 py-1 text-[12px]" disabled={busy} onClick={() => void pauseResume()}>
                    {busy ? <Spinner size={12} /> : canResume ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
                  </button>
                )}
              </div>
            </div>

            {run.providerWait && run.providerWait.retryAt > Date.now() && (
              // a project blocked on a provider limit used to look identical to
              // one that had simply stopped — say what it is waiting for. Only
              // a live project picks itself back up: the sweeper leaves paused
              // ones alone, so promising them an automatic resume would lie.
              <div className="border-b border-linesoft bg-warn/5 px-3.5 py-2 text-[11.5px] leading-snug text-warn">
                Waiting on the {run.providerWait.reason}
                <span className="text-dim">
                  {' · work is preserved · '}
                  {['RUNNING', 'RESUMING', 'PLANNING'].includes(run.state)
                    ? `resumes automatically at ${new Date(run.providerWait.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : 'picked up when you resume the project'}
                </span>
              </div>
            )}

            <div className="flex gap-1 border-b border-linesoft px-3 py-1.5 text-[12px]">
              {(['milestones', 'activity'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`rounded-md px-2.5 py-1 capitalize transition-colors ${tab === t ? 'bg-bg3 text-ink' : 'text-dim hover:text-mut'}`}>
                  {t}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {tab === 'milestones'
                ? (run.milestones.length === 0
                  ? <p className="px-2 py-3 text-[12px] text-dim">Planning the project…</p>
                  : run.milestones.map((m) => <MilestoneBlock key={m.id} milestone={m} />))
                : <ActivityList activity={activity} />}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function MilestoneBlock({ milestone: m }: { milestone: PdMilestone }) {
  const [open, setOpen] = useState(m.status === 'running' || m.status === 'integrating');
  const tone = m.status === 'completed' ? 'text-ok' : m.status === 'running' || m.status === 'integrating' ? 'text-accent' : m.status === 'blocked' ? 'text-warn' : 'text-dim';
  return (
    <div className="mb-1">
      <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2" onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={13} className={`shrink-0 text-dim transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`shrink-0 ${tone}`}>{MS_DOT[m.status] ?? '○'}</span>
        <span className="mono shrink-0 text-[12px] text-ink">{m.key}</span>
        <span className="min-w-0 truncate text-[12.5px] text-mut">{m.name}</span>
        {m.dependsOn.length > 0 && m.status === 'planned' && <span className="ml-auto shrink-0 text-[10.5px] text-dim">after {m.dependsOn.join(',')}</span>}
      </button>
      {open && (
        <div className="ml-[26px] mb-1 space-y-1 border-l border-linesoft pl-2.5">
          <p className="py-1 text-[11.5px] leading-snug text-dim">{m.goal}</p>
          {m.sessions.length === 0
            ? <p className="pb-1 text-[11.5px] text-dim">{m.status === 'planned' ? 'Not yet decomposed.' : 'Planning sessions…'}</p>
            : m.sessions.map((s) => <SessionLine key={s.id} session={s} />)}
        </div>
      )}
    </div>
  );
}

function SessionLine({ session: s }: { session: PdSession }) {
  const tone = s.status === 'completed' ? 'text-ok' : s.status === 'running' ? 'text-accent'
    : s.status === 'timeout' || s.status === 'needs_attention' || s.status === 'failed' || s.status === 'awaiting_review' ? 'text-warn'
      : s.status === 'paused' ? 'text-dim' : 'text-dim';
  const dot = s.status === 'completed' ? '✓' : s.status === 'running' ? '●' : s.status === 'planned' ? '○' : s.status === 'paused' ? '⏸' : s.status === 'awaiting_review' ? '⏳' : '⚠';
  const inner = (
    <div className="rounded-md px-1.5 py-1">
      <div className="flex items-center gap-2">
        <span className={`shrink-0 ${tone}`}>{dot}</span>
        <span className="mono shrink-0 text-[11.5px] text-ink">{s.key}</span>
        <span className="min-w-0 truncate text-[12px] text-mut">{s.name}</span>
        {s.status === 'running' && s.startedAt && <span className="ml-auto shrink-0 text-[10.5px] text-dim">{fmtDuration(Date.now() - s.startedAt)}</span>}
      </div>
      {s.difficulty && (
        <span className="ml-1 rounded-full border border-line px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-dim" title="difficulty — set by the Director, changeable at any time">
          {s.difficulty.replace('_', ' ')}
        </span>
      )}
      {s.reviewRequired === false && (
        <span className="ml-1 rounded-full border border-warn/40 px-1.5 py-[1px] text-[10px] uppercase tracking-wide text-warn" title="the Director decided this session needs no independent review">
          review waived
        </span>
      )}
      {s.agent && (
        <div className="mt-0.5 pl-[18px] text-[11px] text-dim">
          {s.agent.profileName} <span className="text-dim/70">· {s.agent.model} · {s.agent.effort}</span>
        </div>
      )}
      {s.resultSummary && s.status === 'completed' && <div className="mt-0.5 pl-[18px] text-[11px] leading-snug text-dim">{s.resultSummary}{s.reviewVerdict ? ` · reviewer: ${s.reviewVerdict === 'pass' ? 'accepted' : 'findings'}` : ''}</div>}
      {s.status === 'planned' && s.dependsOn.length > 0 && <div className="mt-0.5 pl-[18px] text-[11px] text-dim">Waiting for {s.dependsOn.join(', ')}</div>}
      {s.status === 'paused' && s.stopReason === 'provider_outage' && (
        <div className="mt-0.5 pl-[18px] text-[11px] leading-snug text-warn">Paused by a provider limit — work preserved, not a failure</div>
      )}
      {s.status === 'awaiting_review' && (
        <div className="mt-0.5 pl-[18px] text-[11px] leading-snug">
          <span className="text-dim">Implementation complete · </span>
          <span className="text-warn">Waiting for Reviewer{s.reviewWait ? ` — ${s.reviewWait.reason}` : ''}</span>
          {s.reviewWait && <span className="text-dim"> · Retry at {new Date(s.reviewWait.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
      )}
      {(s.status === 'timeout' || s.status === 'needs_attention' || s.status === 'failed') && <div className="mt-0.5 pl-[18px] text-[11px] text-warn">{s.status.replace('_', ' ')} — Director deciding</div>}
    </div>
  );
  return s.chatId
    ? <Link to={`/c/${s.chatId}`} className="block transition-colors hover:bg-bg2" title="Open this session">{inner}</Link>
    : <div>{inner}</div>;
}

function ActivityList({ activity }: { activity: PdActivity[] }) {
  if (activity.length === 0) return <p className="px-2 py-3 text-[12px] text-dim">No activity yet.</p>;
  return (
    <div className="space-y-0.5">
      {activity.map((a) => (
        <div key={a.id} className="flex gap-2 rounded-md px-2 py-1 text-[12px]">
          <span className="shrink-0 tabular-nums text-dim">{new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="min-w-0 text-mut">{a.text}</span>
        </div>
      ))}
    </div>
  );
}
