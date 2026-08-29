import type {
  AppSettings, AttachmentMeta, Chat, ChatEvent, CompactPreview, ContextUsage, DirListing, GitStatus, Project, PromptEntry, ToolInfo,
} from '@shared/types';

export class ApiError extends Error {
  status: number;
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
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
    let data: Record<string, unknown> | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      data = body;
    } catch { /* non-JSON error */ }
    throw new ApiError(res.status, message, data);
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
  gitStatus: (projectId: string) => j<GitStatus>(`/api/projects/${projectId}/git`),

  // filesystem (New chat browser)
  listDir: (path: string) => j<DirListing>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  mkdir: (parent: string, name: string) => j<{ name: string; path: string }>('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ parent, name }) }),
  renameDir: (dirPath: string, name: string) => j<{ path: string }>('/api/fs/rename', { method: 'POST', body: JSON.stringify({ dirPath, name }) }),
  deleteDir: (dirPath: string, force = false) => j<{ ok: true; wasEmpty: boolean }>('/api/fs/delete', { method: 'POST', body: JSON.stringify({ dirPath, force }) }),

  // attachments
  uploadAttachment: (chatId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return j<AttachmentMeta>(`/api/chats/${chatId}/attachments`, { method: 'POST', body: form });
  },
  deleteAttachment: (id: string) => j<{ ok: true }>(`/api/attachments/${id}`, { method: 'DELETE' }),

  // chats
  chats: () => j<Chat[]>('/api/chats'),
  newChat: (projectId: string) => j<Chat>('/api/chats', { method: 'POST', body: JSON.stringify({ projectId }) }),
  renameChat: (id: string, title: string) => j<Chat>(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => j<{ ok: true }>(`/api/chats/${id}`, { method: 'DELETE' }),
  chatEvents: (id: string) => j<{ chat: Chat; events: ChatEvent[]; usage: ContextUsage }>(`/api/chats/${id}/events`),
  send: (id: string, text: string, attachmentIds?: string[]) =>
    j<{ ok: true }>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, attachmentIds }) }),
  stop: (id: string) => j<{ ok: true; stopped: boolean }>(`/api/chats/${id}/stop`, { method: 'POST' }),

  // context
  compactPreview: (id: string) => j<CompactPreview>(`/api/chats/${id}/compact/preview`, { method: 'POST' }),
  compactApply: (id: string, previewId: string) =>
    j<{ ok: true }>(`/api/chats/${id}/compact/apply`, { method: 'POST', body: JSON.stringify({ previewId }) }),

  // AI prompts
  prompts: () => j<PromptEntry[]>('/api/prompts'),
  promptsExportUrl: '/api/prompts/export',
  importPrompts: (data: unknown) =>
    j<{ summary: { applied: string[]; resetToDefault: string[]; unchanged: string[]; skipped: string[] }; prompts: PromptEntry[] }>(
      '/api/prompts/import', { method: 'POST', body: JSON.stringify(data) }),
  savePrompt: (key: string, value: string) =>
    j<PromptEntry>(`/api/prompts/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  resetPrompt: (key: string) => j<PromptEntry>(`/api/prompts/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // AI tools
  tools: () => j<ToolInfo[]>('/api/tools'),
  saveTool: (server: string, tool: string, patch: { description?: string; params?: Record<string, string> }) =>
    j<ToolInfo>(`/api/tools/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  resetTool: (server: string, tool: string) =>
    j<ToolInfo>(`/api/tools/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`, { method: 'DELETE' }),

  // settings
  settings: () => j<AppSettings>('/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => j<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  effectivePrompt: (role: string) => j<{ role: string; prompt: string }>(`/api/settings/effective-prompt?role=${role}`),

  exportUrl: (chatId: string, format: 'markdown' | 'json' | 'html') => `/api/chats/${chatId}/export?format=${format}`,
};
