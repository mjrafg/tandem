import { Braces, Check, Copy, Download, FileCode, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Spinner } from './ui';

const formats = [
  { key: 'markdown', label: 'Markdown (.md)', icon: FileText, note: 'human-readable' },
  { key: 'json', label: 'JSON (.json)', icon: Braces, note: 'machine-readable, everything' },
  { key: 'html', label: 'HTML (.html)', icon: FileCode, note: 'self-contained page' },
] as const;

export function ExportMenu({ chatId }: { chatId: string }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  async function copyExport(key: (typeof formats)[number]['key'], label: string) {
    setBusy(key);
    const textPromise = fetch(api.exportUrl(chatId, key), { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        return res.text();
      });
    try {
      // Safari only keeps the user gesture alive if the clipboard write is
      // issued immediately — hand it the pending text as a promise rather than
      // awaiting the fetch first.
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })) }),
        ]);
      } else {
        await navigator.clipboard.writeText(await textPromise);
      }
      setCopied(key);
    } catch {
      // older / restricted browsers: fall back to a temporary selection
      try {
        const text = await textPromise;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('rejected');
        setCopied(key);
      } catch {
        toast(`Could not copy the ${label} export — download it instead`, 'error');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost px-2 py-1.5" onClick={() => setOpen((o) => !o)} title="Export chat">
        <Download size={15} />
      </button>
      {open && (
        <div className="card fade-up absolute right-0 top-[34px] z-40 w-[286px] max-w-[calc(100vw-24px)] py-1.5 shadow-2xl shadow-black/50">
          <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-dim">Export full history</div>
          {formats.map((f) => (
            <div key={f.key} className="flex items-stretch transition-colors hover:bg-bg2">
              <a
                href={api.exportUrl(chatId, f.key)}
                download
                className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-[12.5px] text-mut hover:text-ink"
                onClick={() => setOpen(false)}
                title={`Download ${f.label}`}
              >
                <f.icon size={14} className="shrink-0" />
                <span className="shrink-0">{f.label}</span>
                <span className="ml-auto min-w-0 truncate text-right text-[10.5px] text-dim">{f.note}</span>
              </a>
              <button
                className={`flex w-9 shrink-0 items-center justify-center border-l border-linesoft transition-colors ${
                  copied === f.key ? 'text-ok' : 'text-dim hover:bg-bg3 hover:text-ink'
                }`}
                onClick={() => void copyExport(f.key, f.label)}
                disabled={busy === f.key}
                aria-label={`Copy ${f.label} to clipboard`}
                title={`Copy ${f.label} to clipboard`}
              >
                {busy === f.key ? <Spinner size={12} /> : copied === f.key ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          ))}
          <p className="border-t border-linesoft px-3 pb-1 pt-1.5 text-[10.5px] leading-snug text-dim">
            Includes prompts, responses, commands, diffs, findings and compactions — nothing collapsed away.
            Download the file, or copy it straight to the clipboard.
          </p>
        </div>
      )}
    </div>
  );
}
