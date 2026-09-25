/**
 * The provider-neutral execution contract.
 *
 * Everything above this boundary — workflow, Project Director, review, context
 * management — speaks only in these terms: a role, a model, an effort, a
 * prompt, a working directory, a session reference, a policy. Nothing above it
 * knows that Claude Code takes `--resume` or that Codex takes `exec resume`,
 * what stream-json or JSONL look like, or which CLI writes a profile file.
 * Those are facts about a backend, and they live in that backend's adapter.
 *
 * The rule this encodes: Role != Provider != Transport. A role says what is
 * being done, a provider says who does it, a transport says how that provider
 * is reached.
 */
import type {
  AiRole, AiUsage, Difficulty, Effort, ModelSource, Provider, ProviderDescriptor, ProviderHealth, ProviderSessionRef,
} from '../../../shared/types';
import type { RunHandle } from '../engine/run';

/**
 * Why a turn did not produce an answer, classified by the adapter that saw the
 * raw output — never by matching provider prose upstream.
 *
 * The adapter classifies; Tandem decides what to do about it. A `quota`
 * failure is what makes a review wait rather than degrade, and that decision
 * stays in the workflow where the review policy lives.
 */
export type ProviderFailureKind =
  | 'quota'            // out of budget; the backend usually names when it lifts
  | 'rate_limit'
  | 'overloaded'       // the backend is up but refusing work
  | 'transient'        // 5xx, dead socket — temporary, no stated reset
  | 'authentication'
  | 'invalid_model'
  | 'timeout'
  | 'spawn_error'      // the backend could not be started at all
  | 'protocol_error'   // it ran but produced nothing Tandem can read
  | 'provider_error';  // it reported a failure of its own

export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** the backend's own message, bounded — shown to the operator as evidence */
  message: string;
  retryable: boolean;
  /** epoch ms the backend said to come back, when it said so */
  retryAfter?: number;
}

/**
 * What a role is ALLOWED to do, decided centrally and handed to the adapter.
 *
 * This is the separation that lets the same provider run Builder and Reviewer
 * without them sharing authority: the policy comes from the role, never from
 * the provider, and an adapter's only job is to enforce as much of it as its
 * transport can. Server-side tool authorization still applies independently —
 * withholding a tool server is least exposure, not the security boundary.
 */
export interface RoleExecutionPolicy {
  /** may the role write to the project at all */
  filesystem: 'read-write' | 'read-only';
  /** Tandem's workdir/app-state tools (project memory, git policy, session naming) */
  workdirTools: boolean;
  /** Tandem's browser tools, in that role's own browser */
  browserTools: boolean;
  /** admin-configured integration tools, subject to the role filter */
  integrationTools: boolean;
  /** the Project Director's orchestration tools */
  directorTools: boolean;
  /**
   * hand the user a file with a download link. Read-only roles may have it:
   * sharing copies a file OUT of the project, or stores text the role wrote,
   * and changes nothing in the project itself.
   */
  shareFiles: boolean;
}

/** One turn, expressed without a single provider-specific concept. */
export interface ProviderTurnRequest {
  handle: RunHandle;
  role: AiRole;
  model: string;
  effort: Effort;
  cwd: string;
  /** role/system text: instructions about the job, not the job itself */
  systemPrompt: string;
  /** the actual message for this turn */
  userPrompt: string;
  /**
   * The session to continue. The executor has already proven it belongs to
   * this provider — an adapter never has to check, and never receives another
   * backend's id.
   */
  session?: ProviderSessionRef;
  timeoutMs: number;
  policy: RoleExecutionPolicy;
  /** false for background work that must not appear as conversation */
  emitActivity?: boolean;
  /** first Builder turn of a Director session: ask the model to name it */
  nameSession?: boolean;
  /** observability: the session's difficulty and which configuration picked the model */
  difficulty?: Difficulty;
  modelSource?: ModelSource;
}

export interface ProviderTurnResult {
  status: 'completed' | 'failed' | 'stopped';
  /** the role's answer; '' when the turn produced none */
  answer: string;
  /** the session this turn created or continued, for the next one */
  session?: ProviderSessionRef;
  usage?: AiUsage;
  /** the model the backend actually served, when it differs from the request */
  actualModel?: string;
  durationMs: number;
  failure?: ProviderFailure;
}

/** What a provider-native context reading looks like, whoever produced it. */
export interface NativeContextReading {
  ok: boolean;
  usedTokens?: number;
  windowTokens?: number;
  error?: string;
}

/**
 * One AI backend. Everything provider-specific lives behind this interface:
 * argument construction, output parsing, session handling, failure
 * classification, tool wiring, authentication.
 */
export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  /** Run one turn. Must not decide workflow outcomes — only report what happened. */
  runTurn(req: ProviderTurnRequest): Promise<ProviderTurnResult>;
  /** Is the backend installed and signed in? Must not spend model usage. */
  health(): Promise<ProviderHealth>;
  /** present only when capabilities.nativeContextInspection */
  readContext?(session: ProviderSessionRef, model: string, cwd: string): Promise<NativeContextReading>;
  /** present only when capabilities.nativeCompaction */
  compactSession?(session: ProviderSessionRef, model: string, cwd: string): Promise<{ ok: boolean; error?: string; resultText?: string }>;
}

/** What a caller asks for: a role, and which backend should run it. */
export interface RoleExecutionRequest extends Omit<ProviderTurnRequest, 'policy' | 'session'> {
  provider: Provider;
  /** the chat's stored session, whatever provider created it */
  session?: ProviderSessionRef | null;
}
