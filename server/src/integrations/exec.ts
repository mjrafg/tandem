import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HttpIntegrationConfig, Integration, IntegrationTool, OpenApiIntegrationConfig, SshIntegrationConfig, ToolCallPayload,
} from '../../../shared/types';
import { config } from '../config';
import { addEvent, updateEvent } from '../events';
import { mcpCallTool } from './mcpClient';
import { OAuthRequiredError } from './oauth';
import { credentialSecret, credentialSecretValues, getToolByFullName, listIntegrations, setOAuthRequired } from './store';

/**
 * The integration execution layer. The AI never talks to external services
 * directly: it invokes a tool by name through the gateway MCP server, this
 * layer enforces role access, injects the credential, performs the real
 * operation, records a sanitized timeline event, and returns a sanitized
 * result. Credential secrets exist only inside this process.
 */

const RESULT_LIMIT = 100_000;   // max characters returned to the AI
const PREVIEW_LIMIT = 4_000;    // max characters stored in the timeline event
const HTTP_TIMEOUT_MS = 60_000;
const SSH_TIMEOUT_MS = 120_000;

export interface ExecOutcome {
  ok: boolean;
  result: string;
  error?: string;
}

/** replace every credential secret with a mask wherever it appears */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    while (out.includes(s)) out = out.split(s).join('•••');
  }
  return out;
}

function effectiveRole(role: string): 'builder' | 'reviewer' {
  return role === 'reviewer' ? 'reviewer' : 'builder'; // final_repair acts with builder access
}

export async function executeIntegrationTool(input: {
  fullName: string;
  args: Record<string, unknown>;
  role: string;
  chatId?: string;
}): Promise<ExecOutcome> {
  const found = getToolByFullName(input.fullName);
  if (!found) return { ok: false, result: '', error: `Unknown tool: ${input.fullName}` };
  const { tool, integration } = found;

  // enforcement happens HERE, not in prompts
  if (!integration.enabled) return { ok: false, result: '', error: `The integration "${integration.name}" is disabled.` };
  if (!tool.enabled) return { ok: false, result: '', error: `The tool ${tool.fullName} is disabled.` };
  const role = effectiveRole(input.role);
  if (!tool.roles.includes(role)) {
    return { ok: false, result: '', error: `The ${role} role is not permitted to use ${tool.fullName}.` };
  }

  const secrets = credentialSecretValues(integration.credentialId);
  const sanitizedArgs = JSON.parse(scrub(JSON.stringify(input.args ?? {}), secrets));

  const startedAt = Date.now();
  const eventId = input.chatId
    ? addEvent(input.chatId, 'tool_call', {
      tool: tool.fullName,
      integration: integration.name,
      integrationType: integration.type,
      role: input.role,
      args: sanitizedArgs,
      status: 'running',
      startedAt,
    } satisfies ToolCallPayload).id
    : null;

  let outcome: ExecOutcome;
  try {
    if (tool.spec.kind === 'http') outcome = await execHttp(integration, tool, input.args ?? {});
    else if (tool.spec.kind === 'mcp') outcome = await execMcp(integration, tool, input.args ?? {});
    else if (tool.spec.kind === 'ssh') outcome = await execSsh(integration, tool, input.args ?? {});
    else outcome = { ok: false, result: '', error: `Unsupported tool kind: ${(tool.spec as any).kind}` };
  } catch (err) {
    outcome = { ok: false, result: '', error: err instanceof Error ? err.message : String(err) };
  }

  // sanitize everything that leaves this function
  outcome.result = scrub(outcome.result, secrets).slice(0, RESULT_LIMIT);
  if (outcome.error) outcome.error = scrub(outcome.error, secrets).slice(0, 2_000);

  if (eventId) {
    updateEvent(eventId, {
      status: outcome.ok ? 'done' : 'failed',
      durationMs: Date.now() - startedAt,
      resultPreview: outcome.result.slice(0, PREVIEW_LIMIT),
      resultBytes: outcome.result.length,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  return outcome;
}

// ---------------------------------------------------------------- http

function baseUrlOf(integration: Integration, tool: IntegrationTool): string {
  if (tool.spec.baseUrl?.trim()) return tool.spec.baseUrl.trim();
  const cfg = integration.config as HttpIntegrationConfig | OpenApiIntegrationConfig;
  const base = (cfg as HttpIntegrationConfig).baseUrl ?? (cfg as OpenApiIntegrationConfig).baseUrl;
  if (!base?.trim()) throw new Error('No base URL is configured for this integration.');
  return base.trim();
}

async function execHttp(integration: Integration, tool: IntegrationTool, args: Record<string, unknown>): Promise<ExecOutcome> {
  const spec = tool.spec;
  const params = spec.params ?? [];

  for (const p of params) {
    if (p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === '')) {
      return { ok: false, result: '', error: `Missing required parameter: ${p.name}` };
    }
  }

  // path substitution — every {placeholder} must resolve
  let pathPart = spec.path ?? '/';
  for (const p of params.filter((x) => x.in === 'path')) {
    if (args[p.name] !== undefined) {
      pathPart = pathPart.split(`{${p.name}}`).join(encodeURIComponent(String(args[p.name])));
    }
  }
  const unresolved = pathPart.match(/\{[^}]+\}/);
  if (unresolved) return { ok: false, result: '', error: `Path parameter ${unresolved[0]} was not provided.` };

  const base = baseUrlOf(integration, tool).replace(/\/+$/, '');
  const url = new URL(base + (pathPart.startsWith('/') ? pathPart : `/${pathPart}`));
  for (const [k, v] of Object.entries(spec.fixedQuery ?? {})) url.searchParams.set(k, v);
  for (const p of params.filter((x) => x.in === 'query')) {
    if (args[p.name] !== undefined && args[p.name] !== null && args[p.name] !== '') {
      url.searchParams.set(p.name, String(args[p.name]));
    }
  }

  const headers: Record<string, string> = {
    ...((integration.config as HttpIntegrationConfig).headers ?? {}),
    ...(spec.fixedHeaders ?? {}),
  };
  const cred = credentialSecret(integration.credentialId);
  if (cred?.type === 'bearer_token') headers.Authorization = `Bearer ${cred.data.token}`;
  else if (cred?.type === 'api_key_header') headers[cred.data.header] = cred.data.value;
  else if (cred?.type === 'basic_auth') headers.Authorization = `Basic ${Buffer.from(`${cred.data.username}:${cred.data.password}`).toString('base64')}`;
  else if (cred?.type === 'header_set') Object.assign(headers, JSON.parse(cred.data.headersJson));

  let body: string | undefined;
  if (spec.bodyMode === 'json') {
    const bodyParams = params.filter((x) => x.in === 'body');
    if (bodyParams.length === 1 && bodyParams[0].name === 'body' && bodyParams[0].type === 'json') {
      body = JSON.stringify(args.body ?? {});
    } else {
      const obj: Record<string, unknown> = {};
      for (const p of bodyParams) if (args[p.name] !== undefined) obj[p.name] = args[p.name];
      body = JSON.stringify(obj);
    }
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: spec.method ?? 'GET',
      headers,
      ...(body !== undefined && spec.method !== 'GET' && spec.method !== 'HEAD' ? { body } : {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, result: '', error: `Request failed: ${err instanceof Error ? err.message : err}` };
  }

  const text = await res.text();
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
  const summary = `HTTP ${res.status} ${res.statusText}`.trim();
  if (!res.ok) {
    return { ok: false, result: pretty.slice(0, 8_000), error: `${summary}${pretty ? ` — ${pretty.slice(0, 500)}` : ''}` };
  }
  return { ok: true, result: pretty ? `${summary}\n${pretty}` : summary };
}

// ---------------------------------------------------------------- mcp

async function execMcp(integration: Integration, tool: IntegrationTool, args: Record<string, unknown>): Promise<ExecOutcome> {
  const remote = tool.spec.remoteName ?? tool.name;
  let res: { ok: boolean; text: string };
  try {
    res = await mcpCallTool(integration, remote, args);
  } catch (err) {
    if (err instanceof OAuthRequiredError) setOAuthRequired(integration.id, true);
    throw err;
  }
  const { ok, text } = res;
  return ok ? { ok: true, result: text } : { ok: false, result: text, error: text.slice(0, 500) || 'The MCP tool reported an error.' };
}

// ---------------------------------------------------------------- ssh

function sshKeyFile(integrationId: string, privateKey: string): string {
  const dir = path.join(config.dataDir, 'ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${integrationId}.key`);
  const material = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== material) {
    fs.writeFileSync(file, material, { mode: 0o600 });
  }
  return file;
}

export function runSsh(integration: Integration, remoteCommand: string, timeoutMs = SSH_TIMEOUT_MS):
  Promise<{ ok: boolean; output: string; exitCode: number | null; error?: string }> {
  const cfg = integration.config as SshIntegrationConfig;
  const cred = credentialSecret(integration.credentialId);
  if (!cred || cred.type !== 'ssh_private_key') {
    return Promise.resolve({ ok: false, output: '', exitCode: null, error: 'This SSH integration needs an SSH private key credential.' });
  }
  const keyFile = sshKeyFile(integration.id, cred.data.privateKey);
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=15`,
    '-i', keyFile,
    '-p', String(cfg.port || 22),
    `${cfg.user}@${cfg.host}`,
    '--',
    remoteCommand,
  ];
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, output: out, exitCode: null, error: `SSH command timed out after ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: '', exitCode: null, error: `Could not run ssh: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out, exitCode: 0 });
      else resolve({ ok: false, output: out, exitCode: code, error: (err.trim() || out.trim() || `ssh exited with code ${code}`).slice(0, 1_000) });
    });
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function execSsh(integration: Integration, tool: IntegrationTool, args: Record<string, unknown>): Promise<ExecOutcome> {
  const cfg = integration.config as SshIntegrationConfig;
  const op = tool.spec.op;
  let remote: string;
  let timeout = SSH_TIMEOUT_MS;
  if (op === 'execute') {
    const command = String(args.command ?? '').trim();
    if (!command) return { ok: false, result: '', error: 'Missing required parameter: command' };
    const cwd = String(args.cwd ?? cfg.defaultDir ?? '').trim();
    const t = Number(args.timeout_seconds);
    if (Number.isFinite(t) && t > 0) timeout = Math.min(t, 600) * 1000;
    remote = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  } else if (op === 'read_file') {
    const p = String(args.path ?? '').trim();
    if (!p) return { ok: false, result: '', error: 'Missing required parameter: path' };
    remote = `head -c 200000 ${shellQuote(p)}`;
  } else if (op === 'list_directory') {
    const p = String(args.path ?? cfg.defaultDir ?? '.').trim();
    remote = `ls -la ${shellQuote(p)}`;
  } else {
    return { ok: false, result: '', error: `Unknown SSH operation: ${op}` };
  }
  const res = await runSsh(integration, remote, timeout);
  if (!res.ok) return { ok: false, result: res.output.slice(0, 8_000), error: res.error };
  return { ok: true, result: res.output || '(no output)' };
}

// ---------------------------------------------------------------- ssh tool set

/** the small generic remote-host surface created for every SSH integration */
export function sshToolDefinitions(defaultDir: string | undefined): {
  name: string; description: string; spec: { kind: 'ssh'; op: 'execute' | 'read_file' | 'list_directory' };
  paramsSchema: { properties: Record<string, unknown>; required: string[] };
}[] {
  const dirNote = defaultDir ? ` Default directory: ${defaultDir}.` : '';
  return [
    {
      name: 'execute',
      description: `Run a shell command on the remote host over SSH and return its output.${dirNote}`,
      spec: { kind: 'ssh', op: 'execute' },
      paramsSchema: {
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          cwd: { type: 'string', description: 'Directory to run in (optional).' },
          timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 120, max 600).' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the remote host (first 200 KB).',
      spec: { kind: 'ssh', op: 'read_file' },
      paramsSchema: { properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] },
    },
    {
      name: 'list_directory',
      description: `List a directory on the remote host.${dirNote}`,
      spec: { kind: 'ssh', op: 'list_directory' },
      paramsSchema: { properties: { path: { type: 'string', description: 'Directory path (optional).' } }, required: [] },
    },
  ];
}

// ---------------------------------------------------------------- catalog

/** the role-filtered tool catalog served to the AI through the gateway */
export function catalogForRole(role: string): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const r = effectiveRole(role);
  const rows: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
  for (const found of allServableTools()) {
    if (!found.tool.roles.includes(r)) continue;
    rows.push({
      name: found.tool.fullName,
      description: `[${found.integration.name}] ${found.tool.description}`.slice(0, 1_024),
      inputSchema: { type: 'object', ...found.tool.paramsSchema },
    });
  }
  return rows;
}

export function hasIntegrationTools(role: string): boolean {
  return catalogForRole(role).length > 0;
}

function allServableTools(): { tool: IntegrationTool; integration: Integration }[] {
  const out: { tool: IntegrationTool; integration: Integration }[] = [];
  for (const integration of listIntegrations()) {
    if (!integration.enabled) continue;
    for (const tool of integration.tools) {
      if (tool.enabled && !tool.missing) out.push({ tool, integration });
    }
  }
  return out;
}
