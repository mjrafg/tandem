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
  /** 'project' = a Project Director chat; absent/'chat' = a normal session */
  kind?: 'chat' | 'project';
  /** for kind='project': the run this chat directs */
  projectRunId?: string | null;
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
  | 'checkpoint'
  | 'tool_call'
  | 'sessions';

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
  role: RoleName | 'final_repair' | 'compactor' | 'director';
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

/** an AI invocation of a Tandem-executed tool (integration-backed or built-in); args/results sanitized — never credentials */
export interface ToolCallPayload {
  tool: string;
  /** the source shown in the timeline: an integration name, or "Project Memory" */
  integration: string;
  /** absent for Tandem's own built-in tools */
  integrationType?: IntegrationType;
  role: string;
  args: Record<string, unknown>;
  status: StepStatus;
  /** truncated, sanitized result preview stored with the event */
  resultPreview?: string;
  resultBytes?: number;
  error?: string;
  startedAt: number;
  durationMs?: number;
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
  tool_call: ToolCallPayload;
  sessions: SessionsPayload;
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

export type PromptGroup = 'builder' | 'reviewer' | 'repair' | 'director';

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
  /** built-in Tandem MCP server tool vs. Admin-configured integration tool */
  source?: 'builtin' | 'integration';
  integrationId?: string;
  toolId?: string;
  enabled?: boolean;
  /** integration tools: roles are editable checkboxes, enforced at serve+execute time */
  rolesEditable?: boolean;
}

// ---------------------------------------------------------------- integrations

export type IntegrationType = 'mcp' | 'openapi' | 'http' | 'ssh';

export type CredentialType =
  | 'bearer_token'    // Authorization: Bearer <token>
  | 'api_key_header'  // <header>: <value>
  | 'basic_auth'      // Authorization: Basic base64(user:pass)
  | 'header_set'      // arbitrary secret headers
  | 'env_set'         // secret env vars for stdio MCP servers
  | 'ssh_private_key';

/** credential metadata — secret material never leaves the server */
export interface CredentialMeta {
  id: string;
  name: string;
  type: CredentialType;
  createdAt: number;
  updatedAt: number;
  /** integration names currently referencing this credential */
  usedBy: string[];
}

export interface HttpToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  in: 'path' | 'query' | 'body';
  required: boolean;
  description?: string;
}

/** execution facts for one tool — immutable through description editing */
export interface IntegrationToolSpec {
  kind: 'http' | 'mcp' | 'ssh';
  // http / openapi-derived
  method?: string;
  path?: string;
  baseUrl?: string;
  fixedQuery?: Record<string, string>;
  fixedHeaders?: Record<string, string>;
  bodyMode?: 'none' | 'json';
  params?: HttpToolParam[];
  // mcp: the tool's name on the remote server
  remoteName?: string;
  // ssh
  op?: 'execute' | 'read_file' | 'list_directory';
}

export interface IntegrationTool {
  id: string;
  integrationId: string;
  /** short name within the integration */
  name: string;
  /** globally unique served name: <integration slug>_<name> */
  fullName: string;
  description: string;
  defaultDescription: string;
  paramsSchema: { properties: Record<string, unknown>; required: string[] };
  spec: IntegrationToolSpec;
  enabled: boolean;
  roles: RoleName[];
  /** discovery no longer returns this tool (kept so settings are not lost silently) */
  missing?: boolean;
}

export interface McpIntegrationConfig {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** non-secret env for stdio servers (secrets belong in an env_set credential) */
  env?: Record<string, string>;
  url?: string;
  /** non-secret headers for http servers (secrets belong in a credential) */
  headers?: Record<string, string>;
}

export interface OpenApiIntegrationConfig {
  specSource: 'url' | 'pasted';
  specUrl?: string;
  /** stored spec text (pasted/uploaded, or the last fetched copy) */
  specText?: string;
  baseUrl?: string;
  specTitle?: string;
}

export interface HttpIntegrationConfig {
  baseUrl: string;
  /** non-secret headers sent with every tool of this integration */
  headers?: Record<string, string>;
}

export interface SshIntegrationConfig {
  host: string;
  port?: number;
  user: string;
  defaultDir?: string;
}

export interface Integration {
  id: string;
  slug: string;
  name: string;
  type: IntegrationType;
  enabled: boolean;
  credentialId: string | null;
  credentialName?: string | null;
  config: McpIntegrationConfig | OpenApiIntegrationConfig | HttpIntegrationConfig | SshIntegrationConfig;
  createdAt: number;
  updatedAt: number;
  lastTestAt?: number | null;
  lastTestOk?: boolean | null;
  lastTestError?: string | null;
  tools: IntegrationTool[];
}

// ---------------------------------------------------------------- project director

export type ProjectRunState =
  | 'PLANNING' | 'RUNNING' | 'PAUSING' | 'PAUSED' | 'RESUMING'
  | 'COMPLETED' | 'NEEDS_USER' | 'FAILED';

export type PdMilestoneStatus = 'planned' | 'ready' | 'running' | 'integrating' | 'completed' | 'blocked';

export type PdSessionStatus =
  | 'planned'      // defined, dependencies not yet satisfied or not started
  | 'running'      // its underlying chat run is active
  | 'completed'    // run finished ok (review policy included)
  | 'failed'       // run failed and no recovery has superseded it
  | 'timeout'      // run hit its time limit — awaiting a Director decision
  | 'needs_attention' // failure surfaced, Director analyzing/deciding
  | 'paused'       // stopped by project pause; work preserved
  | 'abandoned';   // Director decided (reviewed) the session is no longer needed

export interface PdSession {
  id: string;
  runId: string;
  milestoneId: string;
  key: string;             // e.g. "S3.1"
  name: string;
  purpose: string;         // short human description
  prompt: string;          // the contract given to the session's Builder
  chatId: string | null;   // the EXISTING Tandem chat executing this session
  status: PdSessionStatus;
  dependsOn: string[];     // session keys within the run
  branch: string | null;   // pd/<key> when isolated
  cwd: string | null;      // worktree dir or the project root
  /** event seq just before the latest run's trigger — the outcome window base */
  lastBaselineSeq?: number | null;
  resultSummary: string | null;
  reviewVerdict: 'pass' | 'findings' | null;
  /** live sub-state derived from the underlying chat (display only) */
  builderState?: 'working' | 'finished' | 'failed' | null;
  reviewerState?: 'waiting' | 'reviewing' | 'accepted' | 'findings' | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface PdMilestone {
  id: string;
  runId: string;
  key: string;             // e.g. "M2"
  name: string;
  goal: string;
  acceptance: string;
  status: PdMilestoneStatus;
  orderIdx: number;
  dependsOn: string[];     // milestone keys
  sessions: PdSession[];
}

export interface PdActivity {
  id: string;
  runId: string;
  ts: number;
  kind: 'plan' | 'decision' | 'session' | 'integration' | 'recovery' | 'state' | 'review';
  text: string;
  detail?: string | null;
}

export interface ProjectRun {
  id: string;
  projectId: string;       // the anchor Tandem project (existing projects row)
  chatId: string;          // the Project Chat (an existing chats row, kind='project')
  title: string;
  goal: string;
  state: ProjectRunState;
  integrationBranch: string | null;
  planSummary: string | null;
  createdAt: number;
  updatedAt: number;
  milestones: PdMilestone[];
}

/** live project execution block in the Project Chat — ONE event, updated in place */
export interface SessionsPayload {
  runId: string;
  milestoneKey: string;
  milestoneName: string;
  /** snapshot of the sessions this wave tracks */
  sessions: {
    key: string;
    name: string;
    chatId: string | null;
    status: PdSessionStatus;
    builderState?: string | null;
    reviewerState?: string | null;
    note?: string | null;       // e.g. "Waiting for S2.3" / current activity line
    startedAt?: number | null;
    endedAt?: number | null;
  }[];
  done: boolean;
}

// ---------------------------------------------------------------- project memory

/**
 * Shared knowledge belonging to a PROJECT (the existing projects row), not to a
 * chat: every chat of that project reads and writes the same set.
 */
export interface ProjectMemory {
  id: string;
  projectId: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- skills

/** named instruction set appended to a role's system text when enabled */
export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  roles: RoleName[];
  updatedAt: number;
}

// ---------------------------------------------------------------- SSE

export type ServerMsg =
  | { type: 'event'; event: ChatEvent }
  | { type: 'delta'; chatId: string; eventId: string; text: string }
  | { type: 'chat'; chat: Chat }
  | { type: 'chat_deleted'; chatId: string }
  | { type: 'context'; chatId: string; usage: ContextUsage }
  | { type: 'project'; project: Project }
  | { type: 'project_run'; run: ProjectRun };
