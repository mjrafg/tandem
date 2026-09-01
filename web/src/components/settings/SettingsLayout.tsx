import { ArrowLeft, Bot, Gauge, KeyRound, Plug, SlidersHorizontal, Sparkles, UserRound, Wrench, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useStore } from '../../store';
import { MenuButton } from '../ui';
import { discardSettingsDraft, saveSettingsDraft } from './useSettingsDraft';

/**
 * The Admin shell: one settings category at a time, with persistent navigation
 * on desktop and a drawer on mobile. Categories are declared once here — the
 * router derives its child routes from the same list, so adding a category is
 * one entry plus one page component.
 */
export interface AdminCategory {
  path: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
}

export const ADMIN_CATEGORIES: AdminCategory[] = [
  { path: 'roles', label: 'Roles', blurb: 'Builder, Reviewer and Director — models, effort and instructions', icon: SlidersHorizontal },
  { path: 'agents', label: 'Builder Agents', blurb: 'Specialist profiles the Project Director assigns to sessions', icon: Bot },
  { path: 'instructions', label: 'Prompts & Skills', blurb: "Every instruction Tandem sends, and the skills appended to a role's prompt", icon: Sparkles },
  { path: 'tools', label: 'Tools', blurb: 'How each tool is described to the AI', icon: Wrench },
  { path: 'integrations', label: 'Integrations', blurb: 'External capabilities and the credentials that authenticate them', icon: Plug },
  { path: 'context', label: 'Context', blurb: 'Window thresholds and provider-native compaction', icon: Gauge },
  { path: 'account', label: 'Account', blurb: 'Sign-in and workspace details', icon: UserRound },
];

export function SettingsLayout() {
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const settingsDirty = useStore((s) => s.settingsDirty);
  const savingSettings = useStore((s) => s.savingSettings);
  const current = ADMIN_CATEGORIES.find((c) => location.pathname.startsWith(`/settings/${c.path}`));

  // picking a category dismisses the mobile drawer, and the new category starts
  // at its own top — the shared scroll container would otherwise keep the
  // previous page's offset and look like nothing happened
  useEffect(() => {
    setNavOpen(false);
    scroller.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* one header for the whole area: app menu on mobile, back to chats, current category */}
      <header className="flex shrink-0 items-center gap-2 border-b border-linesoft px-3 py-2.5 sm:px-4">
        <MenuButton />
        <Link to="/" className="btn-ghost px-1.5 py-1.5" title="Back to chats" aria-label="Back to chats"><ArrowLeft size={16} /></Link>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[14px] font-semibold">Admin</span>
            {current && <span className="truncate text-[13px] text-mut lg:hidden">· {current.label}</span>}
          </div>
        </div>
        {/* the md:hidden lives on a plain wrapper: the unlayered .btn-outline
            display rules would otherwise out-cascade the utility on the button */}
        <span className="ml-auto shrink-0 lg:hidden">
          <button
            className="btn-outline gap-1.5 py-[6px] text-[12.5px]"
            onClick={() => setNavOpen(true)}
            aria-expanded={navOpen}
            aria-haspopup="menu"
          >
            <SlidersHorizontal size={14} /> Sections
          </button>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* desktop: persistent, quiet, compact */}
        {/* from lg only: below that the app's own 264px chat sidebar is already
            in flow, and a second fixed column would squeeze the forms */}
        <nav className="hidden w-[212px] shrink-0 overflow-y-auto border-r border-linesoft px-2 py-3 lg:block lg:w-[236px]" aria-label="Admin sections">
          {ADMIN_CATEGORIES.map((c) => <NavItem key={c.path} category={c} />)}
        </nav>

        {/* mobile: drawer over the content */}
        {navOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-black/55 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />
            <nav
              className="fade-up fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-y-auto rounded-t-2xl border-t border-linesoft bg-bg1 px-2 pb-[max(14px,env(safe-area-inset-bottom))] pt-2 shadow-2xl shadow-black/50 lg:hidden"
              aria-label="Admin sections"
            >
              <div className="mb-1 flex items-center justify-between px-2 py-1.5">
                <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Admin sections</span>
                <button className="btn-ghost px-1.5 py-1.5" onClick={() => setNavOpen(false)} aria-label="Close sections menu"><X size={15} /></button>
              </div>
              {ADMIN_CATEGORIES.map((c) => <NavItem key={c.path} category={c} showBlurb />)}
            </nav>
          </>
        )}

        <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-3 pb-24 pt-4 sm:px-5 sm:pt-5">
            <Outlet />
            {/* the settings draft outlives category navigation, so its save bar
                belongs to the area, not to whichever page happens to be open */}
            <SaveBar
              dirty={settingsDirty}
              saving={savingSettings}
              onSave={() => void saveSettingsDraft()}
              onDiscard={discardSettingsDraft}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({ category, showBlurb }: { category: AdminCategory; showBlurb?: boolean }) {
  const Icon = category.icon;
  return (
    <NavLink
      to={category.path}
      className={({ isActive }) => `mb-0.5 flex items-start gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors ${
        isActive ? 'bg-bg3 text-ink' : 'text-mut hover:bg-bg2 hover:text-ink'
      }`}
    >
      {({ isActive }) => (
        <>
          <Icon size={15} className={`mt-[1px] shrink-0 ${isActive ? 'text-accent' : 'text-dim'}`} />
          <span className="min-w-0">
            <span className="block truncate">{category.label}</span>
            {showBlurb && <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{category.blurb}</span>}
          </span>
        </>
      )}
    </NavLink>
  );
}

/** Shared page furniture so every category reads the same way. */
export function PageHeader({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[16px] font-semibold">{title}</h1>
        {children && <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{children}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The save bar for the categories backed by AppSettings. */
export function SaveBar({ dirty, saving, onSave, onDiscard }: {
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void;
}) {
  if (!dirty) return null;
  return (
    <div className="pointer-events-none sticky bottom-0 z-30 flex justify-center pb-4 pt-2">
      <div className="pointer-events-auto card flex items-center gap-3 px-4 py-2.5 shadow-2xl shadow-black/50">
        <span className="text-[12.5px] text-mut">Unsaved changes</span>
        <button className="btn-ghost" onClick={onDiscard}>Discard</button>
        <button className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}
