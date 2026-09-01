import { useEffect, useMemo } from 'react';
import type { AppSettings } from '@shared/types';
import { api } from '../../api';
import { useStore } from '../../store';

/**
 * The editing model for the categories backed by AppSettings (Roles, Context).
 *
 * The draft lives OUTSIDE the page component. Admin is now a place you move
 * around in, so an unsaved edit must survive switching category — losing a
 * half-written instruction because you checked another page would be the
 * refactor's own bug. The layout renders one save bar for the draft wherever
 * you are, and the draft is only re-seeded from the server when it is clean.
 */
const draftStore = {
  get: () => useStore.getState().settingsDraft,
  set: (d: AppSettings | null) => useStore.setState({ settingsDraft: d }),
};

/** Fields whose value differs from the loaded baseline — the patch to send. */
function diffPatch(base: AppSettings, draft: AppSettings): Partial<AppSettings> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof AppSettings)[]) {
    if (JSON.stringify(base[key]) !== JSON.stringify(draft[key])) patch[key] = draft[key];
  }
  return patch as Partial<AppSettings>;
}

export function useSettingsDraft() {
  const settings = useStore((s) => s.settings);
  const draft = useStore((s) => s.settingsDraft);
  const savingSettings = useStore((s) => s.savingSettings);
  const loadSettings = useStore((s) => s.loadSettings);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  // seed once, and re-seed only when the user has nothing in flight — a save
  // landing (or another tab's update) must never overwrite what is being typed
  useEffect(() => {
    if (!settings) return;
    const current = draftStore.get();
    if (!current || JSON.stringify(current) === JSON.stringify(settings)) return;
    if (!useStore.getState().settingsDirty) draftStore.set(structuredClone(settings));
  }, [settings]);

  useEffect(() => {
    if (settings && !draftStore.get()) draftStore.set(structuredClone(settings));
  }, [settings]);

  const dirty = useMemo(
    () => !!settings && !!draft && JSON.stringify(settings) !== JSON.stringify(draft),
    [settings, draft],
  );

  // the layout's save bar reads this without needing the page's own state
  useEffect(() => { useStore.setState({ settingsDirty: dirty }); }, [dirty]);

  const set = (fn: (d: AppSettings) => void) => {
    const current = draftStore.get();
    if (!current) return;
    const copy = structuredClone(current);
    fn(copy);
    draftStore.set(copy);
  };

  return { draft, dirty, saving: savingSettings, set };
}

/** Save/discard live in the store so the layout's single save bar can call them. */
export async function saveSettingsDraft(): Promise<void> {
  const { settings, settingsDraft, toast } = useStore.getState();
  if (!settings || !settingsDraft) return;
  useStore.setState({ savingSettings: true });
  try {
    // send only what changed: a full-object PUT would resend a stale snapshot
    // of every OTHER field and silently revert edits made elsewhere
    const saved = await api.saveSettings(diffPatch(settings, settingsDraft));
    const stillDirty = JSON.stringify(useStore.getState().settingsDraft) !== JSON.stringify(settingsDraft);
    useStore.setState({ settings: saved, ...(stillDirty ? {} : { settingsDraft: structuredClone(saved) }) });
    toast('Settings saved');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Save failed', 'error');
  } finally {
    useStore.setState({ savingSettings: false });
  }
}

export function discardSettingsDraft(): void {
  const { settings } = useStore.getState();
  if (settings) useStore.setState({ settingsDraft: structuredClone(settings) });
}
