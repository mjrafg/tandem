// Shared contracts between server and web.

export type Provider = 'claude-code' | 'codex';
export type RoleName = 'builder' | 'reviewer';
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
  /**
   * All thresholds are percentages of the PROVIDER'S reported context window
   * for the active session — Tandem has no fixed token limit of its own.
   */
  /** % at which the meter turns amber and the banner appears */
  warnPct: number;
  /** % at which auto-compact (when enabled) triggers */
  compactPct: number;
  /** % at which the meter turns red */
  critPct: number;
  autoCompact: boolean;
  /** recent conversation seeded verbatim when a brand-new provider session starts (tokens) */
  preserveRecentTokens: number;
}

export interface AppSettings {
  roles: { builder: RoleConfig; reviewer: RoleConfig };
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

export type GitFlowMode = 'working-branch' | 'auto-merge' | 'direct' | 'none';

export interface GitFlowState {
  mode: GitFlowMode;
  workBranch: string;
  targetBranch: string;
  push: 'auto' | 'never';
  repoPath: string;
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  running: boolean;
  lastCompactionEventId: string | null;
  gitState?: GitFlowState | null;
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
  | 'error'
  | 'browser'
  | 'checkpoint';

export type StepStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  /** server-side location, shown in AI-call transparency */
  path?: string;
}

export interface UserMessagePayload { text: string; attachments?: AttachmentMeta[] }

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

export interface AiUsage {
  /** total tokens consumed by the call (summed across its internal turns) */
  inputTokens: number;
  outputTokens: number;
  /**
   * size of the conversation context at the END of the call (final turn's
   * input + cache + output) — the honest anchor for the context meter.
   * Cumulative inputTokens would multiple-count re-read context.
   */
  contextTokens?: number;
  /** the provider-reported context window of the model that served this call */
  contextWindow?: number;
}

export interface AiCallPayload {
  /** 'compactor' appears only in historical events from the removed Compactor role */
  role: RoleName | 'final_repair' | 'compactor';
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
  /** Tandem-owned tools served to this invocation (name + description as served) */
  tools?: { name: string; description: string }[];
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
  provider: Provider;
  model: string;
  /** active provider context before / after — absent when not observable */
  beforeTokens?: number;
  afterTokens?: number;
  /** provider context window at the time, when reported */
  windowTokens?: number;
  /** whether before/after come from the provider or from Tandem estimates */
  source?: 'provider' | 'estimated';
  /** manual = user clicked Compact · auto = Tandem threshold · provider-auto = the provider compacted on its own */
  reason?: 'manual' | 'auto' | 'provider-auto';
  /** provider session the compaction applied to */
  sessionId?: string;
  durationMs?: number;
  /** legacy Compactor-role events only */
  summary?: string;
  preserved?: string[];
  simulated?: boolean;
}

export interface RunPayload {
  phase: 'started' | 'finished' | 'stopped' | 'failed';
  label?: string;
  /** the user's per-request Reviewer choice, captured at send time (immutable for the run) */
  review?: boolean;
}

export interface ErrorPayload {
  message: string;
  detail?: string;
  source?: string;
  retryable?: boolean;
}

export interface BrowserActionPayload {
  /** navigate | snapshot | click | type | select | press | scroll | wait | screenshot | resize | console | evaluate */
  action: string;
  /** one human-readable line describing what happened */
  detail: string;
  /** page URL after the action */
  url?: string;
  title?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  /** element ref / selector that was interacted with */
  ref?: string;
  /** entered value (already redacted for password fields / sensitive input) */
  value?: string;
  /** screenshot file name (served via /api/chats/:id/shots/:file) */
  screenshotFile?: string;
  console?: { level: string; text: string }[];
  error?: string;
  durationMs?: number;
  status: 'done' | 'failed';
  /** which role drove the browser (builder / reviewer) */
  role?: string;
}

export interface CheckpointPayload {
  /** commit = Tandem checkpoint · preserve = uncommitted work saved before branch adoption · merge / push */
  action: 'commit' | 'preserve' | 'merge' | 'push';
  branch: string;
  target?: string;
  commit?: string;
  message?: string;
  files?: string[];
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
  browser: BrowserActionPayload;
  checkpoint: CheckpointPayload;
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

/**
 * Best available representation of the ACTIVE provider context for the chat's
 * conversation session. Provider-reported values and Tandem estimates are
 * never mixed silently — `source` says where `usedTokens` comes from, and
 * `pendingTokens` is always an estimate, shown as one.
 */
export interface ContextUsage {
  /** provider that owns the conversation session (follows configuration, not role name) */
  provider: Provider;
  model: string | null;
  sessionId: string | null;
  /** last known active context (provider-reported unless source says otherwise) */
  usedTokens: number | null;
  /** provider-reported context window for the model; null = unknown */
  windowTokens: number | null;
  /** Tandem estimate of activity since the last provider report (enters the next turn) */
  pendingTokens: number;
  /** (usedTokens + pendingTokens) / windowTokens — null when either side is unknown */
  pct: number | null;
  /** where usedTokens comes from: provider report · estimate · nothing yet */
  source: 'provider' | 'estimated' | 'none';
}

/** result of a provider-native compaction request */
export interface CompactOutcome {
  ok: boolean;
  provider: Provider;
  model: string;
  beforeTokens?: number;
  afterTokens?: number;
  windowTokens?: number;
  source?: 'provider' | 'estimated';
  durationMs: number;
  error?: string;
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
  /** whether the current directory allows creating folders */
  writable: boolean;
}

// ---------------------------------------------------------------- prompts

export type PromptGroup = 'builder' | 'reviewer' | 'repair';

export interface PromptEntry {
  key: string;
  name: string;
  description: string;
  group: PromptGroup;
  roles: string[];
  placeholders: string[];
  default: string;
  value: string;
  customized: boolean;
}

// ---------------------------------------------------------------- AI tools

export interface ToolParamInfo {
  name: string;
  type: string;
  required: boolean;
  enumValues?: string[];
  defaultDescription: string;
  description: string;
  customized: boolean;
}

export interface ToolInfo {
  server: string;
  serverLabel: string;
  name: string;
  roles: string[];
  defaultDescription: string;
  description: string;
  customized: boolean;
  params: ToolParamInfo[];
}

// ---------------------------------------------------------------- SSE

export type ServerMsg =
  | { type: 'event'; event: ChatEvent }
  | { type: 'delta'; chatId: string; eventId: string; text: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'context'; chatId: string; usage: ContextUsage }
  | { type: 'project'; project: Project };
