import { GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '@shared/types';
import { api } from '../api';

export function GitChip({ projectId }: { projectId: string }) {
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
    <div className="relative" ref={ref}>
      <button className="chip cursor-pointer rounded-lg py-1 transition-colors hover:bg-bg3" onClick={() => setOpen((o) => !o)}>
        <GitBranch size={12.5} />
        <span className="max-w-[140px] truncate">{status.branch}</span>
        {dirty && (
          <span className="tabular-nums">
            <span className="text-ok">+{status.additions}</span>{' '}
            <span className="text-err">−{status.deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="card absolute right-0 top-[34px] z-40 w-[300px] p-3 shadow-2xl shadow-black/50 fade-up">
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
          <p className="mt-2 border-t border-linesoft pt-2 text-[11px] leading-snug text-dim">
            Tandem never commits, pushes, or deploys unless you ask for it.
          </p>
        </div>
      )}
    </div>
  );
}
