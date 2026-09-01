import type {
  AgentProfile, ObservabilityKey,
  AppSettings, AttachmentMeta, Chat, ChatEvent, CompactOutcome, ContextUsage, CredentialMeta, CredentialType,
  DirListing, GitStatus, Integration, IntegrationTool, IntegrationType, Project, ProjectMemory, ProjectRun, PdActivity, PromptEntry, RoleName, Skill, ToolInfo,
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
  send: (id: string, text: string, attachmentIds?: string[], review = true) =>
    j<{ ok: true }>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, attachmentIds, review }) }),
  stop: (id: string) => j<{ ok: true; stopped: boolean }>(`/api/chats/${id}/stop`, { method: 'POST' }),

  // context — provider-native compaction of the chat's active session
  compact: (id: string) => j<CompactOutcome>(`/api/chats/${id}/compact`, { method: 'POST' }),

  // credentials (secret material is write-only — never returned)
  credentials: () => j<CredentialMeta[]>('/api/credentials'),
  credentialFields: (type: CredentialType) => j<{ fields: string[] }>(`/api/credentials/fields/${type}`),
  createCredential: (name: string, type: CredentialType, data: Record<string, string>) =>
    j<CredentialMeta>('/api/credentials', { method: 'POST', body: JSON.stringify({ name, type, data }) }),
  updateCredential: (id: string, patch: { name?: string; data?: Record<string, string> }) =>
    j<CredentialMeta>(`/api/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCredential: (id: string) => j<{ ok: true }>(`/api/credentials/${id}`, { method: 'DELETE' }),

  // integrations
  integrations: () => j<Integration[]>('/api/integrations'),
  createIntegration: (body: { name: string; type: IntegrationType; config: unknown; credentialId?: string | null }) =>
    j<Integration>('/api/integrations', { method: 'POST', body: JSON.stringify(body) }),
  updateIntegration: (id: string, patch: Record<string, unknown>) =>
    j<Integration>(`/api/integrations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteIntegration: (id: string) => j<{ ok: true }>(`/api/integrations/${id}`, { method: 'DELETE' }),
  testIntegration: (id: string) => j<{ ok: boolean; detail: string; integration: Integration }>(`/api/integrations/${id}/test`, { method: 'POST' }),
  refreshIntegrationTools: (id: string) =>
    j<{ ok: boolean; discovered: number; integration: Integration }>(`/api/integrations/${id}/refresh-tools`, { method: 'POST' }),
  updateIntegrationTool: (id: string, toolId: string, patch: { description?: string; enabled?: boolean; roles?: RoleName[] }) =>
    j<IntegrationTool>(`/api/integrations/${id}/tools/${toolId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  createIntegrationTool: (id: string, body: unknown) =>
    j<IntegrationTool>(`/api/integrations/${id}/tools`, { method: 'POST', body: JSON.stringify(body) }),
  replaceIntegrationTool: (id: string, toolId: string, body: unknown) =>
    j<IntegrationTool>(`/api/integrations/${id}/tools/${toolId}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteIntegrationTool: (id: string, toolId: string) =>
    j<{ ok: true }>(`/api/integrations/${id}/tools/${toolId}`, { method: 'DELETE' }),
  integrationsExportUrl: '/api/integrations/export',
  importIntegrations: (data: unknown) =>
    j<{ imported: string[]; skipped: string[]; missingCredentials: string[]; integrations: Integration[] }>(
      '/api/integrations/import', { method: 'POST', body: JSON.stringify(data) }),

  // project memory (scoped by the project id, shared by all its chats)
  projectMemories: (projectId: string) =>
    j<{ projectId: string; count: number; memories: ProjectMemory[] }>(`/api/projects/${projectId}/memories`),
  projectMemoryExportUrl: (projectId: string, format: 'md' | 'json') =>
    `/api/projects/${projectId}/memories/export?format=${format}`,
  projectMemoryText: (projectId: string) =>
    fetch(`/api/projects/${projectId}/memories/export?format=text`, { credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error(`Export failed (${r.status})`); return r.text(); }),

  // project director
  createProjectRun: (dirPath: string) =>
    j<{ run: ProjectRun; chat: Chat }>('/api/project-runs', { method: 'POST', body: JSON.stringify({ dirPath }) }),
  projectRun: (id: string) => j<{ run: ProjectRun; activity: PdActivity[] }>(`/api/project-runs/${id}`),
  pauseProjectRun: (id: string) => j<{ ok: true; run: ProjectRun }>(`/api/project-runs/${id}/pause`, { method: 'POST' }),
  resumeProjectRun: (id: string) => j<{ ok: true; run: ProjectRun }>(`/api/project-runs/${id}/resume`, { method: 'POST' }),

  // skills
  skills: () => j<Skill[]>('/api/skills'),
  saveSkills: (skills: Skill[]) => j<{ skills: Skill[] }>('/api/skills', { method: 'PUT', body: JSON.stringify({ skills }) }),

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

  // builder agents
  agents: (includeArchived = false) => j<AgentProfile[]>(`/api/agents${includeArchived ? '?archived=1' : ''}`),
  createAgent: (input: Partial<AgentProfile>) => j<AgentProfile>('/api/agents', { method: 'POST', body: JSON.stringify(input) }),
  updateAgent: (id: string, input: Partial<AgentProfile>) => j<AgentProfile>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  setDefaultAgent: (id: string) => j<AgentProfile>(`/api/agents/${id}/default`, { method: 'POST' }),
  archiveAgent: (id: string) => j<AgentProfile>(`/api/agents/${id}/archive`, { method: 'POST' }),
  restoreAgent: (id: string) => j<AgentProfile>(`/api/agents/${id}/restore`, { method: 'POST' }),
  agentsExportUrl: '/api/agents/export',
  importAgents: (data: unknown) =>
    j<{ summary: { created: string[]; updated: string[]; skipped: { slug: string; reason: string }[]; defaultChanged: string | null }; agents: AgentProfile[] }>(
      '/api/agents/import', { method: 'POST', body: JSON.stringify(data) }),

  // observability api keys (admin-authenticated; the API itself uses bearer keys)
  observabilityKeys: () => j<{ keys: ObservabilityKey[]; keyPrefix: string }>('/api/observability/keys'),
  createObservabilityKey: (name: string) =>
    j<{ key: ObservabilityKey; secret: string }>('/api/observability/keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeObservabilityKey: (id: string) =>
    j<{ key: ObservabilityKey }>(`/api/observability/keys/${id}/revoke`, { method: 'POST', body: JSON.stringify({}) }),

  // settings
  settings: () => j<AppSettings>('/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => j<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  effectivePrompt: (role: string) => j<{ role: string; prompt: string }>(`/api/settings/effective-prompt?role=${role}`),

  exportUrl: (chatId: string, format: 'markdown' | 'json' | 'html') => `/api/chats/${chatId}/export?format=${format}`,
};
