import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Spinner } from '../ui';

export function ActivityRow({
  icon, label, meta, children, defaultOpen = false, running = false, tone = 'default',
}: {
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  running?: boolean;
  tone?: 'default' | 'warn' | 'error' | 'ok';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneCls =
    tone === 'warn' ? 'text-warn' : tone === 'error' ? 'text-err' : tone === 'ok' ? 'text-ok' : 'text-mut';

  return (
    <div className="fade-up">
      <button
        className={`group flex w-full items-center gap-2 rounded-lg px-2 py-[5px] text-left transition-colors hover:bg-bg2 ${open ? 'bg-bg2/60' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={!children}
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-dim transition-transform duration-150 ${open ? 'rotate-90' : ''} ${children ? '' : 'invisible'}`}
        />
        <span className={`shrink-0 ${toneCls}`}>{icon}</span>
        <span className={`min-w-0 flex-1 truncate text-[13px] ${toneCls} transition-colors group-hover:text-ink`}>
          {label}
        </span>
        {running ? (
          <Spinner size={12} />
        ) : (
          meta != null && <span className="shrink-0 text-[11.5px] tabular-nums text-dim">{meta}</span>
        )}
      </button>
      {open && children && <div className="mb-1.5 ml-[26px] mt-0.5 pr-1">{children}</div>}
    </div>
  );
}

/** key/value line used inside expanded rows */
export function KV({ k, v, mono = false }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2 py-[1.5px] text-[12px]">
      <span className="w-[86px] shrink-0 text-dim">{k}</span>
      <span className={`min-w-0 break-all text-mut ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}
