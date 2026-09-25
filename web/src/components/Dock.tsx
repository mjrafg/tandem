import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type DockId = 'project' | 'files' | 'browser';

/** at this width and up, docks sit beside the chat and several can be open */
const WIDE_QUERY = '(min-width: 1024px)';
/** the chat never gets narrower than this while docks are open */
export const CHAT_MIN = 320;

export const DOCK_SIZES: Record<DockId, { initial: number; min: number }> = {
  project: { initial: 300, min: 220 },
  files: { initial: 440, min: 260 },
  browser: { initial: 560, min: 300 },
};

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

// widths are a per-browser preference: storage may be unavailable, so every
// read and write is guarded and the defaults always work without it
const KEY = 'tandem.dockWidths';
export function loadDockWidths(): Record<DockId, number> {
  const out = { project: DOCK_SIZES.project.initial, files: DOCK_SIZES.files.initial, browser: DOCK_SIZES.browser.initial };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<DockId, unknown>>;
    for (const id of Object.keys(out) as DockId[]) {
      const v = Number(raw[id]);
      if (Number.isFinite(v) && v >= DOCK_SIZES[id].min) out[id] = Math.round(v);
    }
  } catch { /* storage unavailable */ }
  return out;
}
export function saveDockWidths(w: Record<DockId, number>): void {
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* storage unavailable */ }
}

/**
 * A side panel beside the chat. On a wide screen it sits in the row with the
 * chat and any other open docks, and its left edge drags to resize it
 * (double-click resets; arrow keys work on the focused edge). On a narrower
 * screen it is one overlay at a time, as before.
 */
export function Dock({ id, label, wide, width, maxWidth, onResize, onClose, children }: {
  id: DockId; label: string; wide: boolean; width: number; maxWidth: number;
  onResize: (w: number) => void; onClose: () => void; children: ReactNode;
}) {
  const min = DOCK_SIZES[id].min;
  const clamp = useCallback((w: number) => Math.round(Math.max(min, Math.min(w, Math.max(min, maxWidth)))), [min, maxWidth]);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  if (!wide) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden />
        <aside aria-label={label} className="fixed inset-0 z-50 flex flex-col bg-bg1 sm:inset-y-0 sm:left-auto sm:w-[520px] sm:max-w-[94vw] sm:border-l sm:border-linesoft sm:shadow-2xl sm:shadow-black/40">
          {children}
        </aside>
      </>
    );
  }

  return (
    <aside aria-label={label} style={{ width: clamp(width) }} className="relative flex shrink-0 flex-col border-l border-linesoft bg-bg1">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${label.toLowerCase()}`}
        aria-valuenow={clamp(width)}
        aria-valuemin={min}
        aria-valuemax={Math.max(min, maxWidth)}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        className={`group absolute inset-y-0 -left-[4px] z-20 w-[8px] cursor-col-resize touch-none outline-none`}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, w: clamp(width) };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          // the handle is on the left edge: dragging left widens the dock
          onResize(clamp(drag.current.w + (drag.current.x - e.clientX)));
        }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
        onDoubleClick={() => onResize(clamp(DOCK_SIZES[id].initial))}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 80 : 20;
          if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(clamp(width + step)); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); onResize(clamp(width - step)); }
        }}
      >
        <span className={`absolute inset-y-0 left-[3px] w-[2px] transition-colors ${dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent'}`} />
      </div>
      {/* while dragging, a page inside (the live browser picture) must not swallow the pointer */}
      {dragging && <div className="fixed inset-0 z-10 cursor-col-resize" aria-hidden />}
      {children}
    </aside>
  );
}
