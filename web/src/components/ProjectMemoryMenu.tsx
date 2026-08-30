import { Brain, Check, Copy, FileCode, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Spinner } from './ui';

/**
 * Read-only access point for the PROJECT's shared memory. It lives in the chat
 * header for convenience, but the data belongs to the project: two chats of the
 * same project open exactly the same set.
 */
export function ProjectMemoryMenu({ projectId }: { projectId: string }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.projectMemories(projectId)
      .then((r) => { if (alive) setCount(r.count); })
      .catch(() => { if (alive) setCount(null); });
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => { alive = false; window.removeEventListener('mousedown', close); };
  }, [open, projectId]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copyText(key: string, textPromise: Promise<string>, label: string) {
    setBusy(key);
    try {
      // Safari keeps the user gesture only when the write is issued immediately
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })) }),
        ]);
      } else {
        await navigator.clipboard.writeText(await textPromise);
      }
      setCopied(key);
    } catch {
      toast(`Could not copy ${label}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  const shortId = projectId.length > 18 ? `${projectId.slice(0, 14)}…` : projectId;

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost px-2 py-1.5" onClick={() => setOpen((o) => !o)} title="Project Memory">
        <Brain size={15} />
      </button>
      {open && (
        <div className="card fade-up absolute right-0 top-[34px] z-40 w-[286px] max-w-[calc(100vw-24px)] py-1.5 shadow-2xl shadow-black/50">
          <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-dim">Project Memory</div>

          <div className="px-3 pb-2 pt-1">
            <div className="text-[11px] text-dim">Project ID</div>
            <div className="flex items-center gap-1.5">
              <span className="mono min-w-0 flex-1 truncate text-[12px] text-mut" title={projectId}>{shortId}</span>
              <button
                className={`shrink-0 rounded p-1 transition-colors ${copied === 'id' ? 'text-ok' : 'text-dim hover:bg-bg3 hover:text-ink'}`}
                onClick={() => void copyText('id', Promise.resolve(projectId), 'the project ID')}
                title="Copy project ID"
                aria-label="Copy project ID"
              >
                {copied === 'id' ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
            <div className="mt-1.5 text-[12px] text-mut">
              {count == null ? 'loading…' : `${count} ${count === 1 ? 'memory' : 'memories'} stored`}
            </div>
          </div>

          <div className="border-t border-linesoft" />

          <button
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-mut transition-colors hover:bg-bg2 hover:text-ink"
            onClick={() => void copyText('all', api.projectMemoryText(projectId), 'the project memory')}
            disabled={busy === 'all' || count === 0}
          >
            {busy === 'all' ? <Spinner size={13} /> : copied === 'all' ? <Check size={14} className="shrink-0 text-ok" /> : <Copy size={14} className="shrink-0" />}
            <span>Copy all</span>
          </button>

          <a
            href={api.projectMemoryExportUrl(projectId, 'md')}
            download
            className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-mut transition-colors hover:bg-bg2 hover:text-ink"
            onClick={() => setOpen(false)}
          >
            <FileText size={14} className="shrink-0" />
            <span className="flex-1">Markdown (.md)</span>
          </a>
          <a
            href={api.projectMemoryExportUrl(projectId, 'json')}
            download
            className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-mut transition-colors hover:bg-bg2 hover:text-ink"
            onClick={() => setOpen(false)}
          >
            <FileCode size={14} className="shrink-0" />
            <span className="flex-1">JSON (.json)</span>
          </a>

          <p className="border-t border-linesoft px-3 pb-1 pt-1.5 text-[10.5px] leading-snug text-dim">
            Shared across all chats in this project.
          </p>
        </div>
      )}
    </div>
  );
}
