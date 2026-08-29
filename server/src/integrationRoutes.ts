import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  CredentialType, HttpToolParam, Integration, IntegrationType, McpIntegrationConfig, OpenApiIntegrationConfig,
  RoleName, Skill, SshIntegrationConfig,
} from '../../shared/types';
import { config } from './config';
import { kvGet, kvSet } from './db';
import { catalogForRole, executeIntegrationTool, runSsh, sshToolDefinitions } from './integrations/exec';
import { mcpDisconnect, mcpListTools } from './integrations/mcpClient';
import { paramsToSchema, parseOpenApi } from './integrations/openapi';
import {
  createCredential, createIntegration, credentialFields, deleteCredential, deleteIntegration, deleteTool,
  getIntegration, listCredentials, listIntegrations, markMissingExcept, recordTest, replaceHttpTool, updateCredential,
  updateIntegration, updateTool, upsertTool,
} from './integrations/store';

/** Admin + internal endpoints for the no-code integration system. */
export function registerIntegrationRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------- credentials

  app.get('/api/credentials', async () => listCredentials());

  app.get('/api/credentials/fields/:type', async (req) => ({ fields: credentialFields((req.params as any).type as CredentialType) }));

  app.post('/api/credentials', async (req, reply) => {
    const { name, type, data } = (req.body ?? {}) as { name?: string; type?: CredentialType; data?: Record<string, string> };
    try {
      return createCredential(String(name ?? ''), type as CredentialType, data ?? {});
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid credential.' });
    }
  });

  app.patch('/api/credentials/:id', async (req, reply) => {
    try {
      return updateCredential((req.params as any).id, (req.body ?? {}) as any);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Update failed.' });
    }
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    try {
      deleteCredential((req.params as any).id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Delete failed.' });
    }
  });

  // ---------------------------------------------------------------- integrations

  app.get('/api/integrations', async () => listIntegrations());

  app.post('/api/integrations', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; type?: IntegrationType; config?: unknown; credentialId?: string | null };
    try {
      validateConfig(body.type as IntegrationType, body.config);
      const integration = createIntegration({
        name: String(body.name ?? ''), type: body.type as IntegrationType, config: body.config, credentialId: body.credentialId ?? null,
      });
      afterConfigSave(integration);
      return getIntegration(integration.id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid integration.' });
    }
  });

  app.patch('/api/integrations/:id', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as any;
      if (body.type !== undefined) throw new Error('The integration type cannot be changed — create a new integration instead.');
      const cur = getIntegration((req.params as any).id);
      if (!cur) return reply.code(404).send({ error: 'Integration not found.' });
      if (body.config !== undefined) validateConfig(cur.type, body.config);
      const updated = updateIntegration(cur.id, body);
      if (body.config !== undefined) {
        mcpDisconnect(cur.id);
        afterConfigSave(updated);
      }
      return getIntegration(cur.id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Update failed.' });
    }
  });

  app.delete('/api/integrations/:id', async (req, reply) => {
    const cur = getIntegration((req.params as any).id);
    if (!cur) return reply.code(404).send({ error: 'Integration not found.' });
    mcpDisconnect(cur.id);
    deleteIntegration(cur.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- test + discovery

  app.post('/api/integrations/:id/test', async (req, reply) => {
    const integration = getIntegration((req.params as any).id);
    if (!integration) return reply.code(404).send({ error: 'Integration not found.' });
    const result = await testIntegration(integration);
    recordTest(integration.id, result.ok, result.ok ? undefined : result.detail);
    return { ...result, integration: getIntegration(integration.id) };
  });

  app.post('/api/integrations/:id/refresh-tools', async (req, reply) => {
    const integration = getIntegration((req.params as any).id);
    if (!integration) return reply.code(404).send({ error: 'Integration not found.' });
    try {
      const summary = await discoverTools(integration);
      recordTest(integration.id, true);
      return { ok: true, ...summary, integration: getIntegration(integration.id) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordTest(integration.id, false, detail);
      return reply.code(502).send({ error: detail, integration: getIntegration(integration.id) });
    }
  });

  // ---------------------------------------------------------------- tools

  app.patch('/api/integrations/:id/tools/:toolId', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { description?: string; enabled?: boolean; roles?: RoleName[] };
      return updateTool((req.params as any).toolId, body);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Update failed.' });
    }
  });

  app.post('/api/integrations/:id/tools', async (req, reply) => {
    const integration = getIntegration((req.params as any).id);
    if (!integration) return reply.code(404).send({ error: 'Integration not found.' });
    if (integration.type !== 'http') return reply.code(400).send({ error: 'Manual tools can only be added to Custom HTTP integrations.' });
    try {
      const draft = httpToolDraft((req.body ?? {}) as any);
      return upsertTool(integration, { ...draft, roles: (req.body as any)?.roles });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid tool.' });
    }
  });

  app.put('/api/integrations/:id/tools/:toolId', async (req, reply) => {
    const integration = getIntegration((req.params as any).id);
    if (!integration) return reply.code(404).send({ error: 'Integration not found.' });
    if (integration.type !== 'http') return reply.code(400).send({ error: 'Only Custom HTTP tool definitions are editable — discovered tools update via refresh.' });
    try {
      const draft = httpToolDraft((req.body ?? {}) as any);
      return replaceHttpTool((req.params as any).toolId, integration, draft);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid tool.' });
    }
  });

  app.delete('/api/integrations/:id/tools/:toolId', async (req, reply) => {
    const integration = getIntegration((req.params as any).id);
    if (!integration) return reply.code(404).send({ error: 'Integration not found.' });
    deleteTool((req.params as any).toolId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- export / import

  app.get('/api/integrations/export', async (_req, reply) => {
    const payload = {
      app: 'tandem', kind: 'integrations', version: 1, exportedAt: new Date().toISOString(),
      // secrets NEVER leave the server — credentials are exported as named slots only
      credentials: listCredentials().map((c) => ({ name: c.name, type: c.type })),
      integrations: listIntegrations().map((i) => ({
        name: i.name, slug: i.slug, type: i.type, enabled: i.enabled,
        credential: i.credentialName ?? null,
        config: i.config,
        tools: i.tools.map((t) => ({
          name: t.name, description: t.description === t.defaultDescription ? undefined : t.description,
          defaultDescription: t.defaultDescription, paramsSchema: t.paramsSchema, spec: t.spec,
          enabled: t.enabled, roles: t.roles,
        })),
      })),
    };
    reply.header('Content-Disposition', 'attachment; filename="tandem-integrations.json"');
    return payload;
  });

  app.post('/api/integrations/import', async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const list = Array.isArray(body.integrations) ? body.integrations : null;
    if (!list) return reply.code(400).send({ error: 'Expected an { integrations: [...] } export file.' });
    const existingSlugs = new Set(listIntegrations().map((i) => i.slug));
    const creds = new Map(listCredentials().map((c) => [c.name, c.id]));
    const imported: string[] = [];
    const skipped: string[] = [];
    const missingCredentials = new Set<string>();
    for (const item of list) {
      try {
        if (!item?.name || !item?.type) throw new Error('missing name/type');
        if (existingSlugs.has(String(item.slug ?? ''))) { skipped.push(`${item.name} (slug already exists)`); continue; }
        let credentialId: string | null = null;
        if (item.credential) {
          credentialId = creds.get(String(item.credential)) ?? null;
          if (!credentialId) missingCredentials.add(String(item.credential));
        }
        validateConfig(item.type, item.config);
        const integration = createIntegration({ name: String(item.name), slug: item.slug, type: item.type, config: item.config, credentialId });
        if (item.enabled === false) updateIntegration(integration.id, { enabled: false });
        for (const t of item.tools ?? []) {
          const created = upsertTool(integration, {
            name: String(t.name), description: String(t.defaultDescription ?? t.description ?? ''),
            paramsSchema: t.paramsSchema ?? { properties: {}, required: [] }, spec: t.spec,
            enabled: t.enabled !== false, roles: t.roles,
          });
          if (typeof t.description === 'string' && t.description.trim()) updateTool(created.id, { description: t.description });
          if (t.enabled === false) updateTool(created.id, { enabled: false });
          if (Array.isArray(t.roles)) updateTool(created.id, { roles: t.roles });
        }
        imported.push(String(item.name));
      } catch (err) {
        skipped.push(`${item?.name ?? '(unnamed)'} (${err instanceof Error ? err.message : 'invalid'})`);
      }
    }
    return {
      imported, skipped,
      missingCredentials: [...missingCredentials],
      note: missingCredentials.size > 0 ? 'Create the missing credentials and attach them to the imported integrations.' : undefined,
      integrations: listIntegrations(),
    };
  });

  // ---------------------------------------------------------------- skills

  app.get('/api/skills', async () => skills());

  app.put('/api/skills', async (req, reply) => {
    const body = (req.body ?? {}) as { skills?: Skill[] };
    if (!Array.isArray(body.skills)) return reply.code(400).send({ error: 'Expected { skills: [...] }.' });
    const clean: Skill[] = body.skills.slice(0, 100).map((s) => ({
      id: typeof s.id === 'string' && s.id ? s.id : randomUUID(),
      name: String(s.name ?? '').slice(0, 80),
      description: String(s.description ?? '').slice(0, 300),
      instructions: String(s.instructions ?? '').slice(0, 20_000),
      enabled: s.enabled !== false,
      roles: (Array.isArray(s.roles) ? s.roles : ['builder']).filter((r): r is RoleName => r === 'builder' || r === 'reviewer'),
      updatedAt: Date.now(),
    })).filter((s) => s.name.trim());
    kvSet('skills', clean);
    return { skills: clean };
  });

  // ------------------------------------------------- internal (gateway MCP)

  app.get('/api/internal/integration-catalog', async (req, reply) => {
    const q = req.query as any;
    if (q.token !== config.internalToken) return reply.code(403).send({ error: 'Bad internal token.' });
    return { tools: catalogForRole(String(q.role ?? 'builder')) };
  });

  app.post('/api/internal/integration-call', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; chatId?: string; role?: string; tool?: string; args?: Record<string, unknown> };
    if (body.token !== config.internalToken) return reply.code(403).send({ ok: false, error: 'Bad internal token.' });
    const out = await executeIntegrationTool({
      fullName: String(body.tool ?? ''),
      args: body.args ?? {},
      role: String(body.role ?? 'builder'),
      chatId: body.chatId || undefined,
    });
    return { ok: out.ok, result: out.result, error: out.error };
  });
}

// ---------------------------------------------------------------- helpers

export function skills(): Skill[] {
  return kvGet<Skill[]>('skills') ?? [];
}

function validateConfig(type: IntegrationType, cfg: unknown): void {
  const c = (cfg ?? {}) as any;
  if (type === 'mcp') {
    if (c.transport === 'http') {
      if (!String(c.url ?? '').trim().match(/^https?:\/\//)) throw new Error('MCP over HTTP needs a valid http(s) URL.');
    } else if (c.transport === 'stdio') {
      if (!String(c.command ?? '').trim()) throw new Error('MCP over stdio needs a command to run.');
    } else {
      throw new Error('MCP transport must be "stdio" or "http".');
    }
  } else if (type === 'openapi') {
    if (c.specSource === 'url' && !String(c.specUrl ?? '').trim().match(/^https?:\/\//)) throw new Error('Provide a valid specification URL.');
    if (c.specSource === 'pasted' && !String(c.specText ?? '').trim()) throw new Error('Paste or upload the specification text.');
    if (!['url', 'pasted'].includes(c.specSource)) throw new Error('Specification source must be a URL or pasted text.');
  } else if (type === 'http') {
    if (!String(c.baseUrl ?? '').trim().match(/^https?:\/\//)) throw new Error('Custom HTTP integrations need a valid base URL.');
  } else if (type === 'ssh') {
    if (!String(c.host ?? '').trim()) throw new Error('SSH integrations need a host.');
    if (!String(c.user ?? '').trim()) throw new Error('SSH integrations need a user.');
    const port = Number(c.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH port must be 1–65535.');
  }
}

/** ssh integrations get their generic tool set the moment they are saved */
function afterConfigSave(integration: Integration): void {
  if (integration.type === 'ssh') {
    const cfg = integration.config as SshIntegrationConfig;
    const wanted: string[] = [];
    for (const def of sshToolDefinitions(cfg.defaultDir)) {
      const t = upsertTool(integration, { name: def.name, description: def.description, paramsSchema: def.paramsSchema, spec: def.spec });
      wanted.push(t.fullName);
    }
    markMissingExcept(integration.id, wanted);
  }
}

async function testIntegration(integration: Integration): Promise<{ ok: boolean; detail: string }> {
  try {
    if (integration.type === 'mcp') {
      const tools = await mcpListTools(integration);
      return { ok: true, detail: `Connected — the server reports ${tools.length} tool${tools.length === 1 ? '' : 's'}.` };
    }
    if (integration.type === 'ssh') {
      const res = await runSsh(integration, 'echo tandem-connection-ok && uname -sr', 20_000);
      if (!res.ok) return { ok: false, detail: res.error ?? 'SSH failed.' };
      return { ok: true, detail: `Connected — ${res.output.split('\n')[1]?.trim() || 'remote responded'}.` };
    }
    if (integration.type === 'openapi') {
      const cfg = integration.config as OpenApiIntegrationConfig;
      const text = cfg.specSource === 'url' ? await fetchSpec(cfg.specUrl!) : cfg.specText ?? '';
      const parsed = parseOpenApi(text);
      return { ok: true, detail: `Specification valid — "${parsed.title}", ${parsed.operations.length} operations.` };
    }
    // custom http: prove the base URL is reachable (any HTTP response counts)
    const cfg = integration.config as { baseUrl: string };
    const res = await fetch(cfg.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000), redirect: 'manual' })
      .catch(() => fetch(cfg.baseUrl, { method: 'GET', signal: AbortSignal.timeout(15_000), redirect: 'manual' }));
    return { ok: true, detail: `Base URL reachable — responded HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchSpec(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Fetching the specification failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('The specification is larger than 5 MB.');
  return text;
}

/** real discovery: MCP tools/list or OpenAPI operations → tool rows */
async function discoverTools(integration: Integration): Promise<{ discovered: number }> {
  if (integration.type === 'mcp') {
    const tools = await mcpListTools(integration);
    const wanted: string[] = [];
    for (const t of tools) {
      const row = upsertTool(integration, {
        name: t.name,
        description: String(t.description ?? '').slice(0, 2_000),
        paramsSchema: {
          properties: (t.inputSchema?.properties ?? {}) as Record<string, unknown>,
          required: t.inputSchema?.required ?? [],
        },
        spec: { kind: 'mcp', remoteName: t.name },
      });
      wanted.push(row.fullName);
    }
    markMissingExcept(integration.id, wanted);
    return { discovered: tools.length };
  }
  if (integration.type === 'openapi') {
    const cfg = integration.config as OpenApiIntegrationConfig;
    const text = cfg.specSource === 'url' ? await fetchSpec(cfg.specUrl!) : cfg.specText ?? '';
    const parsed = parseOpenApi(text);
    // keep the parsed copy + base URL on the integration for execution
    updateIntegration(integration.id, {
      config: { ...cfg, specText: text, baseUrl: cfg.baseUrl?.trim() || parsed.baseUrl || '', specTitle: parsed.title },
    });
    const fresh = getIntegration(integration.id)!;
    const wanted: string[] = [];
    for (const op of parsed.operations.slice(0, 300)) {
      const row = upsertTool(fresh, {
        name: op.name,
        description: op.description,
        paramsSchema: op.paramsSchema,
        spec: op.spec,
        // discovered REST operations start disabled — the admin chooses which become AI tools
        enabled: false,
      });
      wanted.push(row.fullName);
    }
    markMissingExcept(integration.id, wanted);
    return { discovered: parsed.operations.length };
  }
  if (integration.type === 'ssh') {
    afterConfigSave(integration);
    return { discovered: 3 };
  }
  throw new Error('Custom HTTP integrations have no discovery — define tools manually.');
}

/** validate + normalize a Custom HTTP tool definition from Admin */
function httpToolDraft(body: any): {
  name: string; description: string; paramsSchema: { properties: Record<string, unknown>; required: string[] };
  spec: { kind: 'http'; method: string; path: string; bodyMode: 'none' | 'json'; params: HttpToolParam[]; fixedHeaders?: Record<string, string>; fixedQuery?: Record<string, string> };
} {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('Tool name is required.');
  const method = String(body.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error(`Unsupported method: ${method}`);
  const pathT = String(body.path ?? '').trim();
  if (!pathT.startsWith('/')) throw new Error('Path must start with "/".');
  const params: HttpToolParam[] = [];
  for (const raw of Array.isArray(body.params) ? body.params : []) {
    const pName = String(raw?.name ?? '').trim();
    if (!pName.match(/^[a-zA-Z0-9_.-]+$/)) throw new Error(`Invalid parameter name: "${pName}"`);
    const where = ['path', 'query', 'body'].includes(raw?.in) ? raw.in : 'query';
    params.push({
      name: pName,
      type: ['string', 'number', 'boolean', 'json'].includes(raw?.type) ? raw.type : 'string',
      in: where,
      required: !!raw?.required || where === 'path',
      description: String(raw?.description ?? '').slice(0, 500),
    });
  }
  for (const m of pathT.matchAll(/\{([^}]+)\}/g)) {
    if (!params.some((p) => p.name === m[1] && p.in === 'path')) {
      throw new Error(`Path uses {${m[1]}} but no path parameter "${m[1]}" is defined.`);
    }
  }
  const bodyMode: 'none' | 'json' = params.some((p) => p.in === 'body') ? 'json' : body.bodyMode === 'json' ? 'json' : 'none';
  const fixedHeaders = cleanStringMap(body.fixedHeaders);
  const fixedQuery = cleanStringMap(body.fixedQuery);
  return {
    name,
    description: String(body.description ?? '').slice(0, 2_000),
    paramsSchema: paramsToSchema(params),
    spec: {
      kind: 'http', method, path: pathT, bodyMode, params,
      ...(fixedHeaders ? { fixedHeaders } : {}),
      ...(fixedQuery ? { fixedQuery } : {}),
    },
  };
}

function cleanStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (String(k).trim() && typeof val === 'string') out[String(k).trim()] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
