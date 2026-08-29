import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Modal({
  open, onClose, title, children, width = 560, footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 backdrop-blur-[2px] p-6 pt-[9vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card fade-up w-full shadow-2xl shadow-black/50" style={{ maxWidth: width }} role="dialog" aria-modal>
        {title != null && (
          <div className="flex items-center justify-between border-b border-linesoft px-5 py-3.5">
            <div className="text-[14px] font-semibold">{title}</div>
            <button className="btn-ghost -mr-2 px-1.5 py-1.5" onClick={onClose} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
        {footer != null && <div className="flex items-center justify-end gap-2 border-t border-linesoft px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative box-content h-[20px] w-[36px] shrink-0 cursor-pointer overflow-hidden rounded-full transition-colors duration-150 ${
        checked ? 'bg-accent hover:brightness-110' : 'bg-bg3 ring-1 ring-inset ring-line hover:ring-[#333b48]'
      }`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[16px] w-[16px] rounded-full shadow-sm transition-all duration-150 ${
          checked ? 'translate-x-[16px] bg-[#0b1428]' : 'translate-x-0 bg-[#9aa3af]'
        }`}
      />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium text-mut">{label}</span>
        {hint && <span className="text-[11.5px] text-dim">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export function SelectBox({ value, onChange, options, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className="input appearance-none cursor-pointer bg-[right_10px_center] bg-no-repeat pr-8"
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239aa3af' fill='none' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E")` }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-bg1 text-ink">{o.label}</option>
      ))}
    </select>
  );
}

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`fade-up rounded-lg border px-4 py-2 text-[13px] shadow-xl shadow-black/40 ${
            t.kind === 'error' ? 'border-err/40 bg-[#241416] text-[#ffb3ae]' : 'border-line bg-bg2 text-ink'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function Logo({ size = 20, withWord = true }: { size?: number; withWord?: boolean }) {
  return (
    <span className="inline-flex select-none items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <rect x="4" y="6" width="10" height="20" rx="3.5" fill="var(--color-accent)" />
        <rect x="18" y="6" width="10" height="20" rx="3.5" fill="var(--color-reviewer)" />
      </svg>
      {withWord && <span className="text-[15px] font-semibold tracking-[-0.01em]">tandem</span>}
    </span>
  );
}
