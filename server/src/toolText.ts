/**
 * AI-facing text of Tandem's own MCP tools (Admin → AI Tools).
 *
 * The tool list is NOT maintained by hand: at first use, each production MCP
 * server is spawned and asked over the real protocol (initialize + tools/list)
 * for its definitions — so Admin always shows exactly what the model would be
 * served. Overrides store only human-written description text (tool + param
 * descriptions); names, types, required/enum structure, and behavior remain
 * code. Overrides reach the servers through the TANDEM_TOOL_TEXT env variable
 * at spawn time, so the next AI invocation serves the edited text — one
 * runtime source of truth.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ToolInfo, ToolParamInfo } from '../../shared/types';
import { kvGet, kvSet } from './db';

interface ServerDef {
  key: string;
  label: string;
  script: string;
  roles: string[];
}

/** Which roles' CLI invocations are configured with each server (see engine/claude.ts + engine/codex.ts). */
const SERVERS: ServerDef[] = [
  { key: 'tandem_browser', label: 'Tandem Browser', script: 'mcp-browser.cjs', roles: ['builder', 'final repair', 'reviewer'] },
  { key: 'tandem', label: 'Tandem Working Directory', script: 'mcp-workdir.cjs', roles: ['builder', 'final repair'] },
];

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, any>; required?: string[] };
}

export interface ToolTextOverride {
  description?: string;
  params?: Record<string, string>;
}

type Overrides = Record<string, ToolTextOverride>; // key: `${server}.${tool}`

function overrides(): Overrides {
  return kvGet<Overrides>('tool_text') ?? {};
}

/** JSON handed to the MCP servers via env; they overlay it onto their TOOLS. */
export function toolTextEnv(): string {
  return JSON.stringify(overrides());
}

// ---------------------------------------------------------------- discovery

let discovered: Promise<Map<string, RawTool[]>> | null = null;

function scriptPath(script: string): string {
  return path.resolve(path.dirname(process.argv[1] ?? '.'), script);
}

/** Speak real MCP (initialize → tools/list) to one server and collect its tools. */
function queryServer(script: string): Promise<RawTool[]> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (tools: RawTool[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve(tools);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // no TANDEM_TOOL_TEXT here: discovery captures the FACTORY definitions
      child = spawn(process.execPath, [scriptPath(script)], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => finish([]), 6_000);
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) finish(msg.result.tools as RawTool[]);
        } catch { /* ignore */ }
      }
    });
    child.on('error', () => finish([]));
    child.on('close', () => finish([]));
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tandem-admin', version: '1' } } }) + '\n');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
}

export function discoverDefaults(force = false): Promise<Map<string, RawTool[]>> {
  if (!discovered || force) {
    discovered = (async () => {
      const map = new Map<string, RawTool[]>();
      for (const s of SERVERS) {
        map.set(s.key, await queryServer(s.script));
      }
      return map;
    })();
  }
  return discovered;
}

// ---------------------------------------------------------------- listing

function applyOverride(raw: RawTool, ov: ToolTextOverride | undefined): { description: string; paramDesc: (p: string, d: string) => string } {
  const description = ov?.description?.trim() ? ov.description : (raw.description ?? '');
  return {
    description,
    paramDesc: (p, dflt) => (ov?.params?.[p]?.trim() ? ov.params![p] : dflt),
  };
}

export async function listTools(): Promise<ToolInfo[]> {
  const defs = await discoverDefaults();
  const o = overrides();
  const out: ToolInfo[] = [];
  for (const s of SERVERS) {
    for (const raw of defs.get(s.key) ?? []) {
      const key = `${s.key}.${raw.name}`;
      const ov = o[key];
      const eff = applyOverride(raw, ov);
      const required = new Set(raw.inputSchema?.required ?? []);
      const params: ToolParamInfo[] = Object.entries(raw.inputSchema?.properties ?? {}).map(([name, schema]) => {
        const defaultDescription = String(schema?.description ?? '');
        const value = eff.paramDesc(name, defaultDescription);
        return {
          name,
          type: String(schema?.type ?? (schema?.enum ? 'enum' : 'any')),
          required: required.has(name),
          enumValues: Array.isArray(schema?.enum) ? schema.enum.map(String) : undefined,
          defaultDescription,
          description: value,
          customized: value !== defaultDescription,
        };
      });
      out.push({
        server: s.key,
        serverLabel: s.label,
        name: raw.name,
        roles: s.roles,
        defaultDescription: raw.description ?? '',
        description: eff.description,
        customized: eff.description !== (raw.description ?? '') || params.some((p) => p.customized),
        params,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- editing

export async function setToolText(server: string, tool: string, patch: { description?: string; params?: Record<string, string> }): Promise<void> {
  const defs = await discoverDefaults();
  const raw = (defs.get(server) ?? []).find((t) => t.name === tool);
  if (!raw) throw new Error(`Unknown tool: ${server}.${tool}`);
  const key = `${server}.${tool}`;
  const o = overrides();
  const entry: ToolTextOverride = { ...(o[key] ?? {}) };

  if (patch.description !== undefined) {
    if (patch.description.length > 4_000) throw new Error('Descriptions are limited to 4,000 characters.');
    if (patch.description.trim() === '' || patch.description === (raw.description ?? '')) delete entry.description;
    else entry.description = patch.description;
  }
  if (patch.params) {
    const props = raw.inputSchema?.properties ?? {};
    entry.params = { ...(entry.params ?? {}) };
    for (const [p, d] of Object.entries(patch.params)) {
      if (!(p in props)) throw new Error(`Unknown parameter "${p}" on ${tool}.`);
      if (typeof d !== 'string' || d.length > 2_000) throw new Error('Parameter descriptions are limited to 2,000 characters.');
      const dflt = String(props[p]?.description ?? '');
      if (d.trim() === '' || d === dflt) delete entry.params[p];
      else entry.params[p] = d;
    }
    if (Object.keys(entry.params).length === 0) delete entry.params;
  }

  if (!entry.description && !entry.params) delete o[key];
  else o[key] = entry;
  kvSet('tool_text', o);
}

export async function resetToolText(server: string, tool: string): Promise<void> {
  const defs = await discoverDefaults();
  if (!(defs.get(server) ?? []).some((t) => t.name === tool)) throw new Error(`Unknown tool: ${server}.${tool}`);
  const o = overrides();
  delete o[`${server}.${tool}`];
  kvSet('tool_text', o);
}

// ---------------------------------------------------------------- per-call record

/** Name + description exactly as served, for the ai_call timeline record. */
export async function servedToolRecord(serverKeys: string[]): Promise<{ name: string; description: string }[]> {
  try {
    const all = await listTools();
    return all
      .filter((t) => serverKeys.includes(t.server))
      .map((t) => ({ name: t.name, description: t.description }));
  } catch {
    return [];
  }
}
