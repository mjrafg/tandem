// Shared contracts between server and web.

/**
 * A provider is an AI backend Tandem can execute a role on. The identifier is
 * PERSISTED — in settings, agent profiles, ai_call events and session rows —
 * so it stays as it was written when Builder was Claude and Reviewer was
 * Codex. `codex-cli` / `claude-code-cli` are accepted as aliases at the
 * registry boundary, and canonicalized to these.
 */
export type Provider = 'claude-code' | 'codex';
/**
 * The two ROLE FAMILIES tool authorization is filtered by (integration tool
 * grants, skills, browser buckets). Precise logical roles map onto these:
 * builder/final_repair → builder; builder_reviewer/director_reviewer → reviewer.
 */
export type RoleName = 'builder' | 'reviewer';
/**
 * The four independently configured logical roles. The two reviewers are
 * separate roles with separate configuration: the Builder Reviewer reviews
 * session output and takes part in the two-round review loop; the Director
 * Reviewer independently reviews Director-level decisions (plans, recovery).
 * Neither inherits from the other.
 */
export type ConfigurableRole = 'builder' | 'builder_reviewer' | 'director' | 'director_reviewer';
/**
 * Every role the execution layer can run — roles are what, providers are who.
 * `arbiter` is the Director in a narrower seat: deciding a Builder / Builder
 * Reviewer disagreement. `reviewer` is the historical generic reviewer, kept
 * only so recorded events stay typed.
 */
export type AiRole = 'builder' | 'final_repair' | 'builder_reviewer' | 'director_reviewer' | 'director' | 'arbiter' | 'reviewer';
export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

/**
 * How an adapter reaches its backend. Both shipped providers are `cli`; the
 * field exists so a future HTTP/API provider does not have to pretend to be a
 * process, and so nothing outside a provider module tests for one.
 */
export type ProviderTransport = 'cli' | 'api';

/**
 * What a provider can actually do, declared rather than assumed. Absence is
 * reported honestly — Tandem never simulates a capability a backend lacks, and
 * never infers one from a model name.
 */
export interface ProviderCapabilities {
  /** a previous turn's session can be continued natively */
  resumableSessions: boolean;
  /** the backend streams assistant text as it is produced */
  streaming: boolean;
  /** the session's real context usage can be read on demand */
  nativeContextInspection: boolean;
  /** the backend can compact its own session on request */
  nativeCompaction: boolean;
  /** Tandem's MCP tool servers can be served to it */
  mcp: boolean;
  /** shell commands it runs are reported as events */
  commandExecutionEvents: boolean;
  /** file edits it makes are reported as events */
  fileOperationEvents: boolean;
  /** it can drive Tandem's browser tools */
  browserTools: boolean;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  /** shown in the picker; never a promise about price or speed */
  note?: string;
}

/** What the registry knows about a provider — the only model list the UI reads. */
export interface ProviderDescriptor {
  id: Provider;
  label: string;
  /** the one-word name used in running prose ("Claude overload", "Codex usage limit") */
  shortLabel: string;
  transport: ProviderTransport;
  models: ModelDescriptor[];
  defaultModel: string;
  capabilities: ProviderCapabilities;
  /** the roles this provider is implemented for */
  roles: AiRole[];
}

/**
 * A provider-native conversation session, always carrying its owner.
 *
 * The id alone is meaningless to another backend: a Claude session id handed
 * to Codex resumes nothing and loses the conversation. Storing the provider
 * beside it is what makes "never resume across providers" checkable rather
 * than remembered.
 */
export interface ProviderSessionRef {
  provider: Provider;
  /** the logical role that created it — a Builder Reviewer thread is never resumed as a Builder */
  role: AiRole;
  id: string;
}

export interface ProviderHealth {
  provider: Provider;
  /** the backend is installed and reachable */
  configured: boolean;
  version?: string;
  /** whether it holds a usable login, when that is knowable without spending */
  authenticated?: boolean;
  detail?: string;
}
/** an Agent prompt travels as one argv element — see agents/store.ts */
export const MAX_AGENT_PROMPT_CHARS = 32_000;

/**
 * A Builder Agent profile: persisted configuration that specializes Builder
 * behavior (prompt overlay + model + reasoning). It is NOT an engine concept —
 * new agents are new rows, never new code. `provider` selects the backend the
 * specialist executes on and is validated against the provider registry.
 */
export interface AgentProfile {
  id: string;              // stable immutable identity (never the slug)
  slug: string;            // readable handle; unique among non-archived profiles
  name: string;
  description: string;
  systemPrompt: string;    // specialist OVERLAY, appended to Tandem's Builder instructions
  provider: Provider;      // the backend this specialist runs on
  model: string;
  effort: Effort;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * The immutable Agent configuration a session actually executed with, captured
 * when the session launches. Builder turns, repairs, review retries and
 * restarts all read THIS — never the (mutable) profile row.
 */
export interface AgentSnapshot {
  profileId: string;
  profileName: string;
  profileSlug: string;
  provider: Provider;
  model: string;
  effort: Effort;
  systemPrompt: string;
  profileUpdatedAt: number;
  capturedAt: number;
}

export interface RoleConfig {
  /** which backend runs this role — independent of every other role */
  provider: Provider;
  model: string;
  effort: Effort;
  instructions: string;
  /** builder_reviewer only — whether review runs after code changes */
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
  /** hard token ceiling for auto-compact — whichever limit trips first wins */
  compactMaxTokens: number;
  /** % at which the meter turns red */
  critPct: number;
  autoCompact: boolean;
  /** recent conversation seeded verbatim when a brand-new provider session starts (tokens) */
  preserveRecentTokens: number;
}

/**
 * The Project Director's own configuration. It resolves independently: the
 * Director never inherits the Builder's provider, because the two roles are
 * separate decisions and a Builder moved to Codex must not silently move the
 * orchestrator with it.
 */
export interface DirectorRoleConfig {
  /** absent = the previous behavior, Claude Code */
  provider?: Provider;
  model: string;
  /** absent = follow the Builder's effort (resolveDirectorRole) */
  effort?: Effort;
}

export interface AppSettings {
  roles: {
    builder: RoleConfig;
    /** reviews Builder session output; runs the two-round review loop */
    builder_reviewer: RoleConfig;
    director?: DirectorRoleConfig;
    /** independently reviews Director-level decisions (plans, recovery) */
    director_reviewer: RoleConfig;
    /** the pre-split generic Reviewer — read once by the migration, then removed */
    reviewer?: RoleConfig;
  };
  finalRepairInstructions: string;
  sharedInstructions: string;
  context: ContextConfig;
}

/** Admin-visible metadata for an Observability API key — never the secret. */
export interface ObservabilityKey {
  id: string;
  name: string;
  /** first characters only, for recognition in the list */
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/**
 * A wake-up signal on the Observability stream. It carries identities and a
 * cursor, never evidence: the consumer reads the canonical evidence back from
 * the read-only API. `runId` is always project_runs.id.
 */
export interface ObservabilitySignal {
  type: 'session.completed' | 'session.attention' | 'run.terminal';
  instanceId: string;
  projectId: string;
  runId: string;
  sessionId?: string;
  chatId?: string;
  /** the session/run state that produced this signal (Tandem's own vocabulary) */
  state: string;
  /** highest events.seq for the session's chat at emit time */
  latestSeq?: number;
  timestamp: string;
}

export type ProjectSource = 'directory' | 'zip' | 'git';

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  source: ProjectSource;
  createdAt: number;
  lastOpenedAt: number;
  /** Director session worktree — kept out of the sidebar and pickers */
  hidden?: boolean;
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
  kind?: 'chat' | 'project' | 'pd-session';
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
  | 'finding_dispositions'
  | 'arbitration'
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

export interface FileReadPayload { path: string; lines?: number; error?: string }

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
  /**
   * The components behind inputTokens, kept apart because they do NOT cost the
   * same: a cache read is ~0.1x an input token and a cache write ~1.25x — a
   * 12.5x spread. Summing them into inputTokens (as this record did until now)
   * makes a bill dominated by cheap cache reads indistinguishable from one
   * dominated by expensive writes, and hides where the money actually goes.
   */
  freshInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface AiCallPayload {
  /** the precise logical role; 'reviewer' and 'compactor' appear only in historical events */
  role: AiRole | 'compactor';
  provider: Provider;
  model: string;
  effort: Effort;
  status: StepStatus;
  request: { prompt: string; system?: string };
  response?: { text: string; usage?: AiUsage };
  /** the provider-native session/thread this call created or continued, when it reported one */
  sessionId?: string;
  cli?: { command: string; cwd: string; exitCode: number | null };
  startedAt: number;
  durationMs?: number;
  /**
   * Highest chat seq at the moment this call FINISHED. The ai_call row is
   * inserted when the turn starts, so its own seq sits below every tool event
   * the turn then produced — and those are already inside the provider's
   * reported contextTokens. Anchoring "pending activity" at the start therefore
   * counted the same work twice and inflated the context meter.
   */
  completedSeq?: number;
  /** true while the engine is a simulation (milestone 1) */
  simulated?: boolean;
  error?: string;
  /** Tandem-owned tools served to this invocation (name + description as served) */
  tools?: { name: string; description: string }[];
}

/**
 * What kind of thing a finding is. The Reviewer names it so the Builder and
 * the Director can tell a defect from a preference without re-deriving it:
 * a `preference` or `metadata` finding is advice by definition and never a
 * blocking product defect on its own.
 */
export type FindingCategory =
  | 'defect' | 'regression' | 'security' | 'missing_requirement' | 'risk'
  | 'preference' | 'metadata' | 'policy_conflict';

/**
 * Where a finding stands. One finding keeps one identity from the round that
 * raised it through the Builder's answer, the repair, the verification round,
 * the Director's decision and the final state — it is never re-created as a
 * new finding because it appeared in a later round.
 */
export type FindingState =
  | 'open'                 // raised, not yet answered
  | 'accepted' | 'partially_accepted' | 'rejected' | 'cannot_address'   // the Builder's answer
  | 'repaired'             // a repair was made and verified by the Reviewer
  | 'repair_failed'        // objective verification showed the repair did not work
  | 'builder_upheld' | 'reviewer_upheld' | 'non_blocking' | 'deferred' | 'different_resolution_required'   // the Director's decision
  | 'resolved';            // closed: verified, or judged not to need a change

/** whether a claimed repair was ever checked */
export type RepairStatus = 'pending' | 'claimed' | 'verified' | 'failed' | 'unverified';

export interface Finding {
  /** stable identity for the task, e.g. F-001; absent only in events recorded before identities existed */
  id?: string;
  severity: 'major' | 'minor';
  title: string;
  file?: string;
  line?: number;
  detail: string;
  /** what the Reviewer observed that supports the finding */
  evidence?: string;
  category?: FindingCategory;
  /** a possible resolution — advice, never an instruction */
  recommendation?: string;
}
export interface FindingsPayload {
  verdict: 'pass' | 'findings';
  round: number;
  items: Finding[];
  /** set on the event that closes the loop after the un-reviewed final repair */
  /** historical: a round-2 findings verdict followed by an unreviewed final repair */
  finalRepairNotReviewed?: boolean;
  /** the review cap was reached, so no repair was started for these findings */
  repairSkippedAtCap?: boolean;
  /** a verification round: which earlier findings it was asked to verify, and which stood closed */
  scope?: { verify: string[]; closed: string[] };
  /** round 2: earlier findings the Reviewer confirmed resolved */
  verified?: string[];
  /** round 2: earlier findings whose repair objectively failed — updated in place, never re-raised */
  repairFailed?: { id: string; evidence: string }[];
  /** round 2: "new" items that were in fact known findings, folded back onto their original id */
  folded?: { id: string; restated: string }[];
}

/**
 * The Builder's answer to one finding. Findings are advice: the Builder owns
 * the implementation and says, per finding, what it did with it. `assumed`
 * marks a disposition Tandem filled in because the Builder gave none — the
 * historical behavior, where every finding was treated as accepted.
 */
export type FindingDisposition = 'accepted' | 'partially_accepted' | 'rejected' | 'cannot_address';
export interface FindingResponse {
  /** the finding's stable id */
  id?: string;
  /** 1-based position in the findings list it answers */
  index: number;
  title: string;
  severity: Finding['severity'];
  disposition: FindingDisposition;
  reason: string;
  evidence?: string;
  source: 'builder' | 'assumed';
}
export interface DispositionsPayload {
  /** the review round whose findings these answer */
  round: number;
  items: FindingResponse[];
  /** the final Builder repair pass — nothing after it is re-reviewed */
  final?: boolean;
}

/**
 * The Director's decision on a finding the Builder did not simply accept.
 * `unresolved` is Tandem's own marker for a decision the Director failed to
 * give (an unusable reply, a failed call): the finding then stands open and
 * blocking, and nothing is repaired on nobody's instruction.
 */
export type ArbitrationDecision =
  | 'builder_upheld'                  // the Builder was right not to change it
  | 'reviewer_upheld'                 // a real problem; a change is required
  | 'non_blocking'                    // valid, but does not block this session or its integration
  | 'deferred'                        // valid; to be handled later, not here
  | 'different_resolution_required'   // neither position is right; the Director states the outcome
  | 'unresolved';
export interface ArbitrationItem {
  id?: string;
  index: number;
  title: string;
  /** where the finding stood when the Director looked at it */
  state?: FindingState;
  repairStatus?: RepairStatus;
  severity: Finding['severity'];
  /** what the Builder said, when it said anything */
  disposition?: FindingDisposition;
  decision: ArbitrationDecision;
  reason: string;
  /** for reviewer_upheld / different_resolution: what must actually change */
  required?: string;
  /** does this finding block the session's result as it stands */
  blocking: boolean;
}
export interface ArbitrationPayload {
  round: number;
  items: ArbitrationItem[];
  /** true when no repair round remains, so upheld findings stay open rather than being repaired */
  atCap?: boolean;
  /** the Director's FINAL decision on the session's result: may it proceed as it stands */
  final?: boolean;
  /** the Director's overall verdict on the final state */
  proceed?: boolean;
  summary?: string;
  /** the Director call itself failed; every item is `unresolved` */
  failed?: string;
}

/** One finding's durable lifecycle record for a task (review_findings). */
export interface ReviewFindingRecord {
  chatId: string;
  id: string;
  taskSeq: number;
  /** the review round that raised it */
  round: number;
  severity: Finding['severity'];
  category: FindingCategory | null;
  title: string;
  file: string | null;
  line: number | null;
  detail: string;
  evidence: string | null;
  recommendation: string | null;
  state: FindingState;
  disposition: FindingDisposition | null;
  dispositionReason: string | null;
  dispositionEvidence: string | null;
  repairStatus: RepairStatus | null;
  arbitrationDecision: ArbitrationDecision | null;
  arbitrationReason: string | null;
  arbitrationRequired: string | null;
  /** the Director's final word on whether it blocks; null until decided */
  blocking: boolean | null;
  /** how many times a later round restated it instead of raising something new */
  restated: number;
  updatedAt: number;
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
  finding_dispositions: DispositionsPayload;
  arbitration: ArbitrationPayload;
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
  /** usedTokens + pendingTokens — the absolute size the next request will carry */
  total: number | null;
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
  | 'awaiting_review' // implementation done, but the required review could not run (Reviewer provider outage) — NOT complete; retried automatically
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
  /** Builder Agent profile the Director selected (stable id; null = default) */
  agentProfileId?: string | null;
  /** the immutable Agent configuration this session actually executed with */
  agent?: AgentSnapshot | null;
  dependsOn: string[];     // session keys within the run
  branch: string | null;   // pd/<key> when isolated
  cwd: string | null;      // worktree dir or the project root
  /** event seq just before the latest run's trigger — the outcome window base */
  lastBaselineSeq?: number | null;
  /** why a paused session stopped: the user's own stop, a project-wide pause, a Tandem restart, or a provider limit */
  stopReason?: 'user_stop' | 'project_pause' | 'restart' | 'provider_outage' | null;
  resultSummary: string | null;
  /** `resolved` = findings were raised and every one was closed by Director arbitration as non-blocking */
  reviewVerdict: 'pass' | 'findings' | 'resolved' | null;
  /** set while status is awaiting_review: why the review is waiting and when it retries */
  reviewWait?: { reason: string; retryAt: number } | null;
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
  kind: 'plan' | 'decision' | 'session' | 'integration' | 'recovery' | 'state' | 'review' | 'delivery';
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
  /** set while a provider usage/session limit is blocking work; clears itself */
  providerWait?: { reason: string; retryAt: number } | null;
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
    /** immutable agent identity this session executes with (snapshot) */
    agent?: { name: string; model: string; effort: string } | null;
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
/** The two provider CLIs Tandem signs in on the operator's behalf. */
export type AuthProvider = 'claude' | 'codex';

export interface ProviderStatus {
  provider: AuthProvider;
  loggedIn: boolean;
  detail: string;
}

/**
 * A sign-in in progress. `output` is the CLI's own text, already scrubbed of
 * anything token-shaped; the code the operator pastes never appears here.
 */
export interface StoredTokenMeta {
  provider: AuthProvider;
  createdAt: number;
  /** roughly when the token lapses; Tandem's own estimate, not the CLI's word */
  expiresAt: number | null;
}

export interface LoginState {
  provider: AuthProvider;
  phase: 'running' | 'awaiting_code' | 'done' | 'failed' | 'idle';
  url: string | null;
  output: string;
  /** the CLI's own most recent message to the operator, e.g. a rejected code */
  notice?: string;
  startedAt: number;
  error?: string;
}

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
