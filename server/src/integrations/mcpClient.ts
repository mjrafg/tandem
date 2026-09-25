import { spawn, type ChildProcess } from 'node:child_process';
import type { Integration, McpIntegrationConfig } from '../../../shared/types';
import { credentialSecret } from './store';
import { OAuthRequiredError, oauthAccessToken, parseWwwAuthenticate } from './oauth';

/** An OAuth sign-in behind a connection: a token for each request, and a way to renew it. */
interface ConnAuth {
  token(): Promise<string>;
  /** the server just refused `rejected` — make a better one current (throws when the sign-in is gone) */
  renew(rejected: string): Promise<void>;
}

/**
 * Minimal real MCP client used by the execution layer to talk to EXTERNAL
 * MCP servers configured in Admin. Two transports:
 *   - stdio: Tandem spawns the configured command and speaks newline JSON-RPC
 *   - http:  Streamable HTTP (POST JSON-RPC; handles JSON or SSE-framed replies
 *            and the Mcp-Session-Id header)
 * Connections are pooled per integration and shut down after idling.
 */

const IDLE_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

// ---------------------------------------------------------------- stdio

class StdioConn {
  private proc: ChildProcess;
  private buf = '';
  private nextId = 10;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private initDone: Promise<void>;
  lastUsed = Date.now();
  dead = false;

  constructor(cfg: McpIntegrationConfig, secretEnv: Record<string, string>) {
    if (!cfg.command?.trim()) throw new Error('MCP stdio integration has no command configured.');
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(cfg.env ?? {}), ...secretEnv },
    });
    this.proc.on('error', (err) => this.fail(new Error(`MCP server process failed to start: ${err.message}`)));
    this.proc.on('close', (code) => this.fail(new Error(`MCP server process exited (code ${code ?? '?'}).`)));
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.initDone = this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'tandem', version: '1' },
    }).then(() => {
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    });
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    try { this.proc.kill('SIGTERM'); } catch { /* gone */ }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(String(msg.error.message ?? 'MCP error')));
          else p.resolve(msg.result);
        }
      } catch { /* non-JSON stdout noise from the server — ignore */ }
    }
  }

  private rpc(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(new Error('MCP server connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS / 1000}s.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(method: string, params: unknown): Promise<any> {
    await this.initDone;
    this.lastUsed = Date.now();
    return this.rpc(method, params);
  }

  close(): void {
    this.fail(new Error('closed'));
  }
}

// ---------------------------------------------------------------- http

class HttpConn {
  private sessionId: string | null = null;
  private nextId = 10;
  private initDone: Promise<void> | null = null;
  lastUsed = Date.now();
  dead = false;

  constructor(private url: string, private headers: Record<string, string>, private auth?: ConnAuth) {}

  private async post(body: unknown, retried = false): Promise<{ json: any; sessionId: string | null }> {
    const token = this.auth ? await this.auth.token() : null;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 401) {
      const challenge = parseWwwAuthenticate(res.headers.get('www-authenticate'));
      const said = (await res.text().catch(() => '')).slice(0, 300);
      if (this.auth) {
        // a token the server rejected: renew once, then give up on it
        if (!retried && token) { await this.auth.renew(token); return this.post(body, true); }
        this.dead = true;
        throw new OAuthRequiredError('The MCP server rejected the sign-in even after it was renewed. Sign in again.');
      }
      // an OAuth challenge where Tandem has no sign-in: say so, rather than a bare 401
      if (challenge.resourceMetadata) { this.dead = true; throw new OAuthRequiredError(); }
      throw new Error(`MCP server returned HTTP 401${said ? `: ${said}` : ': the credential was not accepted.'}`);
    }
    const sessionId = res.headers.get('mcp-session-id');
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP server returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    let json: any = null;
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('text/event-stream')) {
      // take the last data: frame carrying a JSON-RPC response
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          try { json = JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
        }
      }
    } else if (text.trim()) {
      json = JSON.parse(text);
    }
    return { json, sessionId };
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const { json, sessionId } = await this.post({ jsonrpc: '2.0', id, method, params });
    if (sessionId) this.sessionId = sessionId;
    if (json?.error) throw new Error(String(json.error.message ?? 'MCP error'));
    return json?.result;
  }

  async call(method: string, params: unknown): Promise<any> {
    if (!this.initDone) {
      this.initDone = this.rpc('initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tandem', version: '1' },
      }).then(async () => {
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined);
      }).catch((err) => { this.initDone = null; throw err; });
    }
    await this.initDone;
    this.lastUsed = Date.now();
    return this.rpc(method, params);
  }

  close(): void {
    this.dead = true;
  }
}

// ---------------------------------------------------------------- pool

type Conn = StdioConn | HttpConn;
const pool = new Map<string, Conn>();

setInterval(() => {
  for (const [key, conn] of pool) {
    if (conn.dead || Date.now() - conn.lastUsed > IDLE_MS) {
      conn.close();
      pool.delete(key);
    }
  }
}, 60_000).unref();

function connect(integration: Integration): Conn {
  const key = `${integration.id}:${integration.updatedAt}`;
  const existing = pool.get(key);
  if (existing && !existing.dead) return existing;
  // config changed or connection died → fresh connection
  for (const [k, c] of pool) {
    if (k.startsWith(`${integration.id}:`)) { c.close(); pool.delete(k); }
  }
  const cfg = integration.config as McpIntegrationConfig;
  const cred = credentialSecret(integration.credentialId);
  let conn: Conn;
  if (cfg.transport === 'http') {
    if (!cfg.url?.trim()) throw new Error('MCP http integration has no URL configured.');
    const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
    let auth: ConnAuth | undefined;
    if (cred?.type === 'oauth' && integration.credentialId) {
      const credentialId = integration.credentialId;
      auth = {
        token: () => oauthAccessToken(credentialId),
        renew: async (rejected) => { await oauthAccessToken(credentialId, rejected); },
      };
    } else if (cred?.type === 'bearer_token') headers.Authorization = `Bearer ${cred.data.token}`;
    else if (cred?.type === 'api_key_header') headers[cred.data.header] = cred.data.value;
    else if (cred?.type === 'header_set') Object.assign(headers, JSON.parse(cred.data.headersJson));
    conn = new HttpConn(cfg.url, headers, auth);
  } else {
    const env: Record<string, string> = cred?.type === 'env_set' ? JSON.parse(cred.data.envJson) : {};
    conn = new StdioConn(cfg, env);
  }
  pool.set(key, conn);
  return conn;
}

/** Drop every pooled connection of an integration; the next call connects afresh. */
export function resetMcpConnections(integrationId: string): void {
  for (const [k, c] of pool) {
    if (k.startsWith(`${integrationId}:`)) { c.close(); pool.delete(k); }
  }
}

export async function mcpListTools(integration: Integration): Promise<McpToolDef[]> {
  const result = await connect(integration).call('tools/list', {});
  const tools = result?.tools;
  if (!Array.isArray(tools)) throw new Error('The MCP server returned no tool list.');
  return tools as McpToolDef[];
}

export async function mcpCallTool(integration: Integration, remoteName: string, args: Record<string, unknown>):
  Promise<{ ok: boolean; text: string }> {
  const result = await connect(integration).call('tools/call', { name: remoteName, arguments: args });
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type) parts.push(`[${c.type} content omitted]`);
  }
  const text = parts.join('\n') || JSON.stringify(result ?? null);
  return { ok: !result?.isError, text };
}

export function mcpDisconnect(integrationId: string): void {
  for (const [k, c] of pool) {
    if (k.startsWith(`${integrationId}:`)) { c.close(); pool.delete(k); }
  }
}
