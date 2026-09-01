import { create } from 'zustand';
import type {
  ProjectRun,
  AppSettings, Chat, ChatEvent, ContextUsage, Project, ServerMsg,
} from '@shared/types';
import { api, ApiError } from './api';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface State {
  authChecked: boolean;
  email: string | null;
  projects: Project[];
  chats: Chat[];
  events: Record<string, ChatEvent[]>;
  usage: Record<string, ContextUsage>;
  loaded: Record<string, boolean>;
  loadError: Record<string, string>;
  settings: AppSettings | null;
  /** Admin's in-progress settings edit — outlives category navigation */
  settingsDraft: AppSettings | null;
  settingsDirty: boolean;
  savingSettings: boolean;
  /** Admin's in-progress Builder Agent edits, keyed by agent id ('new' = create) */
  agentDrafts: Record<string, unknown>;
  toasts: Toast[];
  newProjectOpen: boolean;
  /** New chat vs New project — which flow the shared dialog is running */
  newProjectMode: 'chat' | 'project';
  projectRuns: Record<string, ProjectRun>;
  /** mobile drawer state; ignored by the static desktop sidebar */
  sidebarOpen: boolean;

  setNewProjectOpen: (open: boolean, mode?: 'chat' | 'project') => void;
  loadProjectRun: (id: string) => Promise<void>;
  setSidebarOpen: (open: boolean) => void;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAll: () => Promise<void>;
  loadChat: (id: string) => Promise<void>;
  send: (id: string, text: string, attachmentIds?: string[], review?: boolean) => Promise<void>;
  stop: (id: string) => Promise<void>;
  loadSettings: () => Promise<void>;
  toast: (text: string, kind?: 'info' | 'error') => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
let source: EventSource | null = null;

export const useStore = create<State>((set, get) => ({
  authChecked: false,
  email: null,
  projects: [],
  chats: [],
  events: {},
  usage: {},
  loaded: {},
  loadError: {},
  settings: null,
  settingsDraft: null,
  settingsDirty: false,
  savingSettings: false,
  agentDrafts: {},
  toasts: [],
  newProjectOpen: false,
  newProjectMode: 'chat',
  projectRuns: {},
  sidebarOpen: false,

  // opening the project dialog dismisses the mobile drawer beneath it
  setNewProjectOpen: (open, mode = 'chat') => set(open ? { newProjectOpen: open, newProjectMode: mode, sidebarOpen: false } : { newProjectOpen: open }),
  loadProjectRun: async (id) => {
    try { const { run } = await api.projectRun(id); set((s) => ({ projectRuns: { ...s.projectRuns, [run.id]: run } })); }
    catch { /* ignore */ }
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  init: async () => {
    try {
      const me = await api.me();
      set({ email: me.email, authChecked: true });
      await get().refreshAll();
      connectStream();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ email: null, authChecked: true });
      } else {
        set({ authChecked: true });
        get().toast('Cannot reach the server. Retrying…', 'error');
        setTimeout(() => void get().init(), 4000);
      }
    }
  },

  login: async (email, password) => {
    await api.login(email, password);
    set({ email });
    await get().refreshAll();
    connectStream();
  },

  logout: async () => {
    try { await api.logout(); } catch { /* session gone anyway */ }
    source?.close();
    source = null;
    set({ email: null, chats: [], projects: [], events: {}, usage: {}, loaded: {} });
  },

  refreshAll: async () => {
    const [projects, chats] = await Promise.all([api.projects(), api.chats()]);
    set({ projects, chats });
  },

  loadChat: async (id) => {
    try {
      const { chat, events, usage } = await api.chatEvents(id);
      set((s) => ({
        events: { ...s.events, [id]: events },
        usage: { ...s.usage, [id]: usage },
        loaded: { ...s.loaded, [id]: true },
        loadError: { ...s.loadError, [id]: '' },
        chats: upsert(s.chats, chat),
      }));
    } catch (err) {
      set((s) => ({ loadError: { ...s.loadError, [id]: err instanceof Error ? err.message : 'Failed to load chat' } }));
    }
  },

  send: async (id, text, attachmentIds, review = true) => {
    try {
      await api.send(id, text, attachmentIds, review);
    } catch (err) {
      get().toast(err instanceof Error ? err.message : 'Failed to send', 'error');
      throw err;
    }
  },

  stop: async (id) => {
    try { await api.stop(id); } catch (err) {
      get().toast(err instanceof Error ? err.message : 'Failed to stop', 'error');
    }
  },

  loadSettings: async () => {
    const settings = await api.settings();
    set({ settings });
  },

  toast: (text, kind = 'info') => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const copy = [...list];
  copy[i] = item;
  return copy;
}

function applyMsg(msg: ServerMsg): void {
  const { setState, getState } = useStore;
  switch (msg.type) {
    case 'event': {
      const { chatId } = msg.event;
      const s = getState();
      if (!s.loaded[chatId]) return; // will load on open
      const list = s.events[chatId] ?? [];
      const i = list.findIndex((e) => e.id === msg.event.id);
      const next = i === -1 ? [...list, msg.event].sort((a, b) => a.seq - b.seq) : list.map((e, k) => (k === i ? msg.event : e));
      setState({ events: { ...s.events, [chatId]: next } });
      break;
    }
    case 'delta': {
      const s = getState();
      const list = s.events[msg.chatId];
      if (!list) return;
      const i = list.findIndex((e) => e.id === msg.eventId);
      if (i === -1) return;
      const ev = list[i];
      const payload = { ...(ev.payload as any), text: ((ev.payload as any).text ?? '') + msg.text };
      const next = [...list];
      next[i] = { ...ev, payload } as ChatEvent;
      setState({ events: { ...s.events, [msg.chatId]: next } });
      break;
    }
    case 'chat': {
      const s = getState();
      setState({ chats: upsert(s.chats, msg.chat) });
      break;
    }
    case 'chat_deleted': {
      const s = getState();
      setState({ chats: s.chats.filter((c) => c.id !== msg.chatId) });
      break;
    }
    case 'context': {
      const s = getState();
      setState({ usage: { ...s.usage, [msg.chatId]: msg.usage } });
      break;
    }
    case 'project': {
      const s = getState();
      setState({ projects: upsert(s.projects, msg.project) });
      break;
    }
    case 'project_run': {
      const s = getState();
      setState({ projectRuns: { ...s.projectRuns, [msg.run.id]: msg.run } });
      break;
    }
  }
}

function connectStream(): void {
  if (source) return;
  openStream();
}

function openStream(): void {
  source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    try {
      applyMsg(JSON.parse(e.data) as ServerMsg);
    } catch { /* malformed frame */ }
  };
  source.onopen = () => {
    // catch up on anything missed while disconnected
    const s = useStore.getState();
    void s.refreshAll();
    for (const [chatId, isLoaded] of Object.entries(s.loaded)) {
      if (isLoaded) void s.loadChat(chatId);
    }
  };
  source.onerror = () => {
    // EventSource retries transient failures itself, but a non-stream response
    // (e.g. a proxy error page during a server restart) closes it for good —
    // supervise and reopen so live updates always come back.
    if (source && source.readyState === EventSource.CLOSED) {
      source.close();
      source = null;
      setTimeout(() => {
        if (!source && useStore.getState().email) openStream();
      }, 2500);
    }
  };
}

// convenient selectors
export const selectChat = (id: string | undefined) => (s: State) =>
  id ? s.chats.find((c) => c.id === id) : undefined;
export const selectProject = (id: string | undefined) => (s: State) =>
  id ? s.projects.find((p) => p.id === id) : undefined;
export type { ContextUsage, Chat, Project, AppSettings };
