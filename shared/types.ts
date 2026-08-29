// Shared contracts between server and web.

export type Provider = 'claude-code' | 'codex';
export type RoleName = 'builder' | 'reviewer' | 'compactor';
export type Effort = 'low' | 'medium' | 'high';

export interface RoleConfig {
  provider: Provider;
  model: string;
  effort: Effort;
  instructions: string;
  /** reviewer only — whether review runs after code changes */
  enabled?: boolean;
}

export interface ContextConfig {
  /** app-level context budget for the builder conversation (tokens) */
  builderLimit: number;
  reviewerLimit: number;
  /** % at which the meter turns amber and the banner appears */
  warnPct: number;
  /** % at which Compact becomes prominent */
  compactPct: number;
  /** % at which the meter turns red */
  critPct: number;
  /** tokens reserved for the model's reply */
  outputReserve: number;
  autoCompact: boolean;
  /** target size after compaction (tokens) */
  autoTargetTokens: number;
  /** most recent conversation kept verbatim through compaction (tokens) */
  preserveRecentTokens: number;
}

export interface AppSettings {
  roles: { builder: RoleConfig; reviewer: RoleConfig; compactor: RoleConfig };
  finalRepairInstructions: string;
  sharedInstructions: string;
  context: ContextConfig;
}

export type ProjectSource = 'directory' | 'zip' | 'git';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  source: ProjectSource;
  createdAt: number;
  lastOpenedAt: number;
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  lastCompactionEventId: string | null;
}

// ---------------------------------------------------------------- events

export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'status'
  | 'command'
  | 'file_read'
  | 'search'
  | 'file_change'
  | 'ai_call'
  | 'findings'
  | 'compaction'
  | 'run'
  | 'error';

export type StepStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface UserMessagePayload { text: string }

export interface AssistantMessagePayload { text: string; streaming?: boolean }

export interface StatusPayload { text: string }

export interface CommandPayload {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  status: StepStatus;
}

export interface FileReadPayload { path: string; lines?: number }

export interface SearchMatch { path: string; line: number; preview: string }
export interface SearchPayload { query: string; tool: string; matches: SearchMatch[] }

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
}
export interface FileChangePayload { files: ChangedFile[] }

export interface AiUsage { inputTokens: number; outputTokens: number }

export interface AiCallPayload {
  role: RoleName | 'final_repair';
  provider: Provider;
  model: string;
  effort: Effort;
  status: StepStatus;
  request: { prompt: string; system?: string };
  response?: { text: string; usage?: AiUsage };
  cli?: { command: string; cwd: string; exitCode: number | null };
  startedAt: number;
  durationMs?: number;
  /** true while the engine is a simulation (milestone 1) */
  simulated?: boolean;
  error?: string;
}

export interface Finding {
  severity: 'major' | 'minor';
  title: string;
  file?: string;
  line?: number;
  detail: string;
  recommendation?: string;
}
export interface FindingsPayload {
  verdict: 'pass' | 'findings';
  round: number;
  items: Finding[];
  /** set on the event that closes the loop after the un-reviewed final repair */
  finalRepairNotReviewed?: boolean;
}

export interface CompactionPayload {
  beforeTokens: number;
  afterTokens: number;
  provider: Provider;
  model: string;
  summary: string;
  preserved: string[];
  durationMs: number;
  simulated?: boolean;
}

export interface RunPayload {
  phase: 'started' | 'finished' | 'stopped' | 'failed';
  label?: string;
}

export interface ErrorPayload {
  message: string;
  detail?: string;
  source?: string;
  retryable?: boolean;
}

export type EventPayloadMap = {
  user_message: UserMessagePayload;
  assistant_message: AssistantMessagePayload;
  status: StatusPayload;
  command: CommandPayload;
  file_read: FileReadPayload;
  search: SearchPayload;
  file_change: FileChangePayload;
  ai_call: AiCallPayload;
  findings: FindingsPayload;
  compaction: CompactionPayload;
  run: RunPayload;
  error: ErrorPayload;
};

export interface ChatEvent<K extends EventKind = EventKind> {
  id: string;
  chatId: string;
  seq: number;
  ts: number;
  runId?: string;
  kind: K;
  payload: EventPayloadMap[K];
}

// ---------------------------------------------------------------- context

export interface ContextUsage {
  usedTokens: number;
  limit: number;
  pct: number;
  estimated: true;
  breakdown: { overhead: number; carried: number; recent: number };
}

export interface CompactPreview {
  previewId: string;
  beforeTokens: number;
  afterTokens: number;
  provider: Provider;
  model: string;
  summary: string;
  preserved: string[];
}

// ---------------------------------------------------------------- git

export interface GitFileStat { path: string; additions: number; deletions: number; status: string }
export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  files?: GitFileStat[];
}

// ---------------------------------------------------------------- fs browse

export interface DirEntry { name: string; path: string }
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  quickLinks: DirEntry[];
}

// ---------------------------------------------------------------- SSE

export type ServerMsg =
  | { type: 'event'; event: ChatEvent }
  | { type: 'delta'; chatId: string; eventId: string; text: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'context'; chatId: string; usage: ContextUsage }
  | { type: 'project'; project: Project };
