import { FileDiff, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitFlowState, GitStatus } from '@shared/types';
import { api } from '../api';

function workflowLabel(g: GitFlowState): string {
  const push = g.push === 'auto' ? ' · push on' : '';
  if (g.mode === 'auto-merge') return `Auto merge → ${g.targetBranch}${push}`;
  if (g.mode === 'direct') return `Direct on ${g.targetBranch}${push}`;
  return `Working branch → target ${g.targetBranch}${push}`;
}

export function GitChip({ projectId, gitState, onOpenChanges }: {
  projectId: string; gitState?: GitFlowState | null; onOpenChanges?: () => void;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.gitStatus(projectId).then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus(null); });
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!status?.isRepo) return null;
  const dirty = (status.changedFiles ?? 0) > 0;

  return (
    <div className="relative min-w-0 shrink sm:shrink-0" ref={ref}>
      <button className="chip min-w-0 max-w-full cursor-pointer rounded-lg py-1 transition-colors hover:bg-bg3" onClick={() => setOpen((o) => !o)}>
        <GitBranch size={12.5} />
        <span className="min-w-0 truncate sm:max-w-[140px]">{status.branch}</span>
        {dirty && (
          <span className="hidden shrink-0 tabular-nums sm:inline">
            <span className="text-ok">+{status.additions}</span>{' '}
            <span className="text-err">−{status.deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="card fade-up fixed left-3 right-3 top-[54px] z-40 p-3 shadow-2xl shadow-black/50 sm:absolute sm:left-auto sm:right-0 sm:top-[34px] sm:w-[300px]">
          <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 font-medium"><GitBranch size={13} /> {status.branch}</span>
            <span className="text-dim">{dirty ? `${status.changedFiles} changed` : 'clean'}</span>
          </div>
          {dirty ? (
            <div className="max-h-[240px] space-y-0.5 overflow-y-auto">
              {status.files?.map((f) => (
                <div key={f.path} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="mono min-w-0 truncate text-mut" title={f.path}>{f.path}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="text-ok">+{f.additions}</span>{' '}
                    <span className="text-err">−{f.deletions}</span>
                    {f.status === 'untracked' && <span className="ml-1.5 text-[10px] uppercase text-dim">new</span>}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-dim">Working tree is clean.</p>
          )}
          {onOpenChanges && (
            <button className="btn-outline mt-2.5 w-full justify-center py-1.5 text-[12.5px]" onClick={() => { setOpen(false); onOpenChanges(); }}>
              <FileDiff size={13} /> {dirty ? 'See the changes' : 'Files, changes and branches'}
            </button>
          )}
          <p className="mt-2 border-t border-linesoft pt-2 text-[11px] leading-snug text-dim">
            {gitState && gitState.mode !== 'none'
              ? <>Git workflow: <span className="text-mut">{workflowLabel(gitState)}</span> — checkpoints are committed automatically; nothing merges or pushes beyond this policy.</>
              : 'Tandem never merges, pushes, or deploys unless you ask for it.'}
          </p>
        </div>
      )}
    </div>
  );
}
