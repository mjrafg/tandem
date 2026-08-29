import { Braces, Download, FileCode, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const formats = [
  { key: 'markdown', label: 'Markdown (.md)', icon: FileText, note: 'human-readable' },
  { key: 'json', label: 'JSON (.json)', icon: Braces, note: 'machine-readable, everything' },
  { key: 'html', label: 'HTML (.html)', icon: FileCode, note: 'self-contained page' },
] as const;

export function ExportMenu({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost px-2 py-1.5" onClick={() => setOpen((o) => !o)} title="Export chat">
        <Download size={15} />
      </button>
      {open && (
        <div className="card absolute right-0 top-[34px] z-40 w-[250px] py-1.5 shadow-2xl shadow-black/50 fade-up">
          <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-dim">Export full history</div>
          {formats.map((f) => (
            <a
              key={f.key}
              href={api.exportUrl(chatId, f.key)}
              download
              className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-mut transition-colors hover:bg-bg2 hover:text-ink"
              onClick={() => setOpen(false)}
            >
              <f.icon size={14} className="shrink-0" />
              <span className="flex-1">{f.label}</span>
              <span className="text-[10.5px] text-dim">{f.note}</span>
            </a>
          ))}
          <p className="border-t border-linesoft px-3 pb-1 pt-1.5 text-[10.5px] leading-snug text-dim">
            Includes prompts, responses, commands, diffs, findings and compactions — nothing collapsed away.
          </p>
        </div>
      )}
    </div>
  );
}
