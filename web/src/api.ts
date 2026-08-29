import type {
  AppSettings, Chat, ChatEvent, CompactPreview, ContextUsage, DirListing, GitStatus, Project,
} from '@shared/types';

export class ApiError extends Error {
  status: number;
  output?: string;
  constructor(status: number, message: string, output?: string) {
    super(message);
    this.status = status;
    this.output = output;
  }
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let output: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (body?.output) output = body.output;
    } catch { /* non-JSON error */ }
    throw new ApiError(res.status, message, output);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // auth
  login: (email: string, password: string) =>
    j<{ ok: true; email: string }>('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => j<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => j<{ email: string }>('/api/me'),
  changePassword: (current: string, next: string) =>
    j<{ ok: true }>('/api/account/password', { method: 'POST', body: JSON.stringify({ current, next }) }),

  // projects
  projects: () => j<Project[]>('/api/projects'),
  openProject: (id: string) => j<{ ok: true }>('/api/projects/open', { method: 'POST', body: JSON.stringify({ id }) }),
  addDirectory: (dirPath: string) => j<Project>('/api/projects/directory', { method: 'POST', body: JSON.stringify({ dirPath }) }),
  listDir: (path: string) => j<DirListing>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  importZip: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return j<Project & { imported: { files: number; bytes: number } }>('/api/projects/zip', { method: 'POST', body: form });
  },
  gitClone: (url: string) => j<Project & { cloneOutput: string }>('/api/projects/git', { method: 'POST', body: JSON.stringify({ url }) }),
  gitStatus: (projectId: string) => j<GitStatus>(`/api/projects/${projectId}/git`),

  // chats
  chats: () => j<Chat[]>('/api/chats'),
  newChat: (projectId: string) => j<Chat>('/api/chats', { method: 'POST', body: JSON.stringify({ projectId }) }),
  renameChat: (id: string, title: string) => j<Chat>(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => j<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  chatEvents: (id: string) => j<{ chat: Chat; events: ChatEvent[]; usage: ContextUsage }>(`/api/chats/${id}/events`),
  send: (id: string, text: string) => j<{ ok: true }>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  stop: (id: string) => j<{ ok: true; stopped: boolean }>(`/api/chats/${id}/stop`, { method: 'POST' }),

  // context
  compactPreview: (id: string) => j<CompactPreview>(`/api/chats/${id}/compact/preview`, { method: 'POST' }),
  compactApply: (id: string, previewId: string) =>
    j<{ ok: true }>(`/api/chats/${id}/compact/apply`, { method: 'POST', body: JSON.stringify({ previewId }) }),

  // settings
  settings: () => j<AppSettings>('/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => j<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  effectivePrompt: (role: string) => j<{ role: string; prompt: string }>(`/api/settings/effective-prompt?role=${role}`),

  exportUrl: (chatId: string, format: 'markdown' | 'json' | 'html') => `/api/chats/${chatId}/export?format=${format}`,
};
