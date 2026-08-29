import {
  ChevronRight, Download, Globe, Network, Plus, RefreshCw, Server, Terminal, Trash2, Upload, Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  CredentialMeta, HttpIntegrationConfig, HttpToolParam, Integration, IntegrationTool, IntegrationType,
  McpIntegrationConfig, OpenApiIntegrationConfig, RoleName, SshIntegrationConfig,
} from '@shared/types';
import { api } from '../../api';
import { timeAgo } from '../../lib/format';
import { useStore } from '../../store';
import { Field, Modal, SelectBox, Spinner, Toggle } from '../ui';

const TYPE_META: Record<IntegrationType, { label: string; blurb: string; icon: typeof Globe }> = {
  mcp: { label: 'MCP Server', blurb: 'Connect an MCP server — its real tools are discovered and served to the AI.', icon: Network },
  openapi: { label: 'OpenAPI / REST', blurb: 'Import an OpenAPI definition and choose which operations become tools.', icon: Globe },
  http: { label: 'Custom HTTP', blurb: 'Define HTTP-backed tools by hand for APIs without a specification.', icon: Wrench },
  ssh: { label: 'SSH Host', blurb: 'Connect a remote machine — generic execute / read / list tools.', icon: Terminal },
};

export function IntegrationsSection() {
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<Integration[] | null>(null);
  const [adding, setAdding] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = () => api.integrations().then(setItems).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);

  async function doImport(file: File) {
    try {
      const res = await api.importIntegrations(JSON.parse(await file.text()));
      setItems(res.integrations);
      const parts = [`imported ${res.imported.length}`];
      if (res.skipped.length) parts.push(`skipped ${res.skipped.length}`);
      toast(`Integrations: ${parts.join(', ')}${res.missingCredentials.length ? ` — create credentials: ${res.missingCredentials.join(', ')}` : ''}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    }
  }

  if (!items) return <div className="card flex justify-center px-4 py-6"><Spinner size={16} /></div>;

  return (
    <div className="space-y-3">
      <div className="card px-4 py-3.5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-dim">
            External capabilities connected without code changes — MCP servers, OpenAPI definitions, custom HTTP
            endpoints, SSH hosts. Enabled tools appear under AI Tools and are served to the AI on its next invocation.
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <a className="btn-ghost px-2 py-1 text-[12px]" href={api.integrationsExportUrl} download title="Export (never includes secrets)">
              <Download size={13} /> Export
            </a>
            <button className="btn-ghost px-2 py-1 text-[12px]" onClick={() => importRef.current?.click()}>
              <Upload size={13} /> Import
            </button>
            <input ref={importRef} type="file" accept=".json" className="hidden" onChange={(e) => {
              if (e.target.files?.[0]) void doImport(e.target.files[0]);
              e.currentTarget.value = '';
            }} />
          </div>
        </div>
        {items.length === 0 && <p className="mb-1 text-[12.5px] text-dim">No integrations yet.</p>}
        <div className="space-y-2">
          {items.map((it) => (
            <IntegrationCard key={it.id} integration={it} onChanged={(next) => {
              if (next) setItems((l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
              else void load();
            }} />
          ))}
        </div>
        <button className="btn-outline mt-3" onClick={() => setAdding(true)}><Plus size={14} /> Add integration</button>
      </div>
      {adding && <AddIntegrationModal onClose={() => setAdding(false)} onCreated={() => { setAdding(false); void load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- card

function IntegrationCard({ integration: it, onChanged }: { integration: Integration; onChanged: (next?: Integration) => void }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toolEditor, setToolEditor] = useState<IntegrationTool | 'new' | null>(null);
  const Icon = TYPE_META[it.type].icon;
  const enabledTools = it.tools.filter((t) => t.enabled && !t.missing).length;

  async function run(label: string, fn: () => Promise<{ detail?: string; integration?: Integration } | void>) {
    setBusy(label);
    try {
      const res = await fn();
      if (res && 'integration' in res && res.integration) onChanged(res.integration);
      else onChanged();
      if (res && 'detail' in res && res.detail) toast(res.detail);
    } catch (err) {
      toast(err instanceof Error ? err.message : `${label} failed`, 'error');
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-linesoft bg-bg0">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={14} className={`shrink-0 text-dim transition-transform ${open ? 'rotate-90' : ''}`} />
          <Icon size={15} className="shrink-0 text-dim" />
          <span className="min-w-0 truncate text-[13.5px] font-medium">{it.name}</span>
          <span className="mono shrink-0 text-[11px] text-dim">{it.slug}_*</span>
          <span className="shrink-0 rounded-full bg-bg3 px-2 py-[1px] text-[10.5px] uppercase tracking-wide text-dim">{TYPE_META[it.type].label}</span>
          {it.lastTestOk != null && (
            <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${it.lastTestOk ? 'bg-ok' : 'bg-err'}`}
              title={it.lastTestOk ? `Last test OK ${it.lastTestAt ? timeAgo(it.lastTestAt) : ''}` : it.lastTestError ?? 'Last test failed'} />
          )}
        </button>
        <span className="shrink-0 text-[11.5px] text-dim">{enabledTools}/{it.tools.length} tools</span>
        <Toggle checked={it.enabled} onChange={(v) => void run('Toggle', async () => ({ integration: await api.updateIntegration(it.id, { enabled: v }) }))} label={`${it.name} enabled`} />
      </div>

      {open && (
        <div className="border-t border-linesoft px-3.5 pb-3 pt-2.5">
          <div className="mb-2.5 flex flex-wrap items-center gap-3 text-[11.5px] text-dim">
            <span>{configSummary(it)}</span>
            <span>credential: {it.credentialName ?? 'none'}</span>
            {it.lastTestAt && <span>tested {timeAgo(it.lastTestAt)}{it.lastTestOk ? ' · OK' : ''}</span>}
          </div>
          {it.lastTestOk === false && it.lastTestError && (
            <p className="mb-2.5 rounded-md bg-err/10 px-2.5 py-1.5 text-[12px] text-[#ffb3ae]">{it.lastTestError}</p>
          )}
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            <button className="btn-outline px-2.5 py-1 text-[12px]" disabled={!!busy}
              onClick={() => void run('Test', async () => { const r = await api.testIntegration(it.id); return { detail: r.detail, integration: r.integration }; })}>
              {busy === 'Test' ? <Spinner size={12} /> : 'Test connection'}
            </button>
            {(it.type === 'mcp' || it.type === 'openapi' || it.type === 'ssh') && (
              <button className="btn-outline px-2.5 py-1 text-[12px]" disabled={!!busy}
                onClick={() => void run('Refresh', async () => {
                  const r = await api.refreshIntegrationTools(it.id);
                  return { detail: `Discovered ${r.discovered} tools`, integration: r.integration };
                })}>
                {busy === 'Refresh' ? <Spinner size={12} /> : <><RefreshCw size={12} /> {it.type === 'openapi' ? 'Discover operations' : 'Refresh tools'}</>}
              </button>
            )}
            {it.type === 'http' && (
              <button className="btn-outline px-2.5 py-1 text-[12px]" onClick={() => setToolEditor('new')}><Plus size={12} /> Add tool</button>
            )}
            <button className="btn-ghost ml-auto px-2 py-1 text-[12px] text-dim hover:text-err" disabled={!!busy}
              onClick={() => {
                if (confirm(`Delete the integration "${it.name}" and its ${it.tools.length} tools?`)) {
                  void run('Delete', async () => { await api.deleteIntegration(it.id); });
                }
              }}>
              <Trash2 size={12} /> Delete
            </button>
          </div>

          {it.tools.length > 0 && (
            <div className="space-y-1">
              {it.tools.map((t) => (
                <ToolRow key={t.id} integration={it} tool={t} onChanged={onChanged} onEdit={it.type === 'http' ? () => setToolEditor(t) : undefined} />
              ))}
            </div>
          )}
          {it.tools.length === 0 && (
            <p className="text-[12px] text-dim">
              {it.type === 'http' ? 'No tools defined yet — add one.' : it.type === 'openapi' ? 'Run "Discover operations" to load the specification.' : 'No tools discovered yet.'}
            </p>
          )}
        </div>
      )}
      {toolEditor && (
        <HttpToolEditor
          integration={it}
          tool={toolEditor === 'new' ? null : toolEditor}
          onClose={() => setToolEditor(null)}
          onSaved={() => { setToolEditor(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function configSummary(it: Integration): string {
  if (it.type === 'mcp') {
    const c = it.config as McpIntegrationConfig;
    return c.transport === 'http' ? `http · ${c.url}` : `stdio · ${c.command} ${(c.args ?? []).join(' ')}`.trim();
  }
  if (it.type === 'openapi') {
    const c = it.config as OpenApiIntegrationConfig;
    return `${c.specTitle ? `${c.specTitle} · ` : ''}${c.baseUrl ?? '(base URL from spec)'}`;
  }
  if (it.type === 'http') return (it.config as HttpIntegrationConfig).baseUrl;
  const c = it.config as SshIntegrationConfig;
  return `${c.user}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ''}${c.defaultDir ? ` · ${c.defaultDir}` : ''}`;
}

// ---------------------------------------------------------------- tool row

function ToolRow({ integration, tool, onChanged, onEdit }: {
  integration: Integration; tool: IntegrationTool; onChanged: () => void; onEdit?: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  async function patch(p: { enabled?: boolean; roles?: RoleName[] }) {
    setBusy(true);
    try {
      await api.updateIntegrationTool(integration.id, tool.id, p);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  const roleBox = (role: RoleName, label: string) => (
    <label className={`flex cursor-pointer items-center gap-1 text-[11px] ${tool.roles.includes(role) ? 'text-mut' : 'text-dim'}`}>
      <input
        type="checkbox"
        className="h-3 w-3 accent-[#6e9bff]"
        checked={tool.roles.includes(role)}
        disabled={busy}
        onChange={(e) => void patch({ roles: e.target.checked ? [...tool.roles, role] : tool.roles.filter((r) => r !== role) })}
      />
      {label}
    </label>
  );

  return (
    <div className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${tool.missing ? 'opacity-50' : ''} hover:bg-bg2`}>
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-[#6e9bff]"
        checked={tool.enabled}
        disabled={busy || !!tool.missing}
        onChange={(e) => void patch({ enabled: e.target.checked })}
        title={tool.enabled ? 'Disable tool' : 'Enable tool'}
      />
      <div className="min-w-0 flex-1">
        <button className={`mono block max-w-full truncate text-left text-[12px] ${onEdit ? 'hover:text-accent' : 'cursor-default'}`} onClick={onEdit} title={tool.description}>
          {tool.fullName}
          {tool.missing && <span className="ml-2 text-[10.5px] uppercase text-warn">missing from source</span>}
        </button>
        <div className="truncate text-[11px] text-dim">{tool.description || '(no description)'}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {roleBox('builder', 'Builder')}
        {roleBox('reviewer', 'Reviewer')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add wizard

function AddIntegrationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useStore((s) => s.toast);
  const [type, setType] = useState<IntegrationType | null>(null);
  const [name, setName] = useState('');
  const [credentialId, setCredentialId] = useState<string>('');
  const [creds, setCreds] = useState<CredentialMeta[]>([]);
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.credentials().then(setCreds).catch(() => undefined); }, []);

  function buildConfig(): unknown {
    if (type === 'mcp') {
      return cfg.transport === 'http'
        ? { transport: 'http', url: cfg.url ?? '', headers: parseKv(cfg.headers) }
        : { transport: 'stdio', command: cfg.command ?? '', args: (cfg.args ?? '').split(/\s+/).filter(Boolean), env: parseKv(cfg.env) };
    }
    if (type === 'openapi') {
      return cfg.specSource === 'pasted'
        ? { specSource: 'pasted', specText: cfg.specText ?? '', baseUrl: cfg.baseUrl || undefined }
        : { specSource: 'url', specUrl: cfg.specUrl ?? '', baseUrl: cfg.baseUrl || undefined };
    }
    if (type === 'http') return { baseUrl: cfg.baseUrl ?? '', headers: parseKv(cfg.headers) };
    return { host: cfg.host ?? '', port: cfg.port ? Number(cfg.port) : 22, user: cfg.user ?? '', defaultDir: cfg.defaultDir || undefined };
  }

  async function create() {
    if (!type) return;
    setBusy(true);
    try {
      const integration = await api.createIntegration({ name, type, config: buildConfig(), credentialId: credentialId || null });
      // connect + discover right away so the admin sees real state immediately
      let note = '';
      try {
        if (type === 'mcp' || type === 'openapi') {
          const r = await api.refreshIntegrationTools(integration.id);
          note = ` — discovered ${r.discovered} ${type === 'openapi' ? 'operations' : 'tools'}`;
        } else {
          const r = await api.testIntegration(integration.id);
          note = ` — ${r.detail}`;
          if (!r.ok) toast(`Saved, but the connection test failed: ${r.detail}`, 'error');
        }
      } catch (err) {
        toast(`Saved, but discovery failed: ${err instanceof Error ? err.message : err}`, 'error');
      }
      if (note && !note.includes('failed')) toast(`${name} added${note}`);
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Create failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  const set = (k: string) => (e: { target: { value: string } }) => setCfg((c) => ({ ...c, [k]: e.target.value }));

  return (
    <Modal
      open
      onClose={onClose}
      title={type ? `Add integration — ${TYPE_META[type].label}` : 'Add integration'}
      width={620}
      footer={type ? (
        <>
          <button className="btn-ghost" onClick={() => setType(null)}>Back</button>
          <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? <Spinner size={13} /> : 'Save & connect'}
          </button>
        </>
      ) : <button className="btn-ghost" onClick={onClose}>Cancel</button>}
    >
      {!type ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {(Object.keys(TYPE_META) as IntegrationType[]).map((t) => {
            const Icon = TYPE_META[t].icon;
            return (
              <button key={t} className="card flex items-start gap-3 px-3.5 py-3 text-left transition-colors hover:border-[#39414e] hover:bg-bg2" onClick={() => { setType(t); setCfg(t === 'mcp' ? { transport: 'stdio' } : t === 'openapi' ? { specSource: 'url' } : {}); }}>
                <Icon size={17} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  <span className="block text-[13.5px] font-medium">{TYPE_META[t].label}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{TYPE_META[t].blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3.5">
          <Field label="Name" hint="tools are served as <slug>_<tool>">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'ssh' ? 'e.g. Production Server' : 'e.g. Cloudflare Production'} autoFocus />
          </Field>

          {type === 'mcp' && (
            <>
              <Field label="Transport">
                <SelectBox value={cfg.transport ?? 'stdio'} onChange={(v) => setCfg((c) => ({ ...c, transport: v }))}
                  options={[{ value: 'stdio', label: 'stdio (local command)' }, { value: 'http', label: 'HTTP (streamable)' }]} />
              </Field>
              {(cfg.transport ?? 'stdio') === 'stdio' ? (
                <>
                  <Field label="Command"><input className="input mono text-[12.5px]" value={cfg.command ?? ''} onChange={set('command')} placeholder="npx" /></Field>
                  <Field label="Arguments" hint="space-separated"><input className="input mono text-[12.5px]" value={cfg.args ?? ''} onChange={set('args')} placeholder="-y @modelcontextprotocol/server-everything" /></Field>
                  <Field label="Environment (non-secret)" hint="KEY=value per line — secrets go in a credential">
                    <textarea className="input mono min-h-[56px] resize-y text-[12px]" value={cfg.env ?? ''} onChange={set('env')} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Server URL"><input className="input mono text-[12.5px]" value={cfg.url ?? ''} onChange={set('url')} placeholder="https://mcp.example.com/mcp" /></Field>
                  <Field label="Headers (non-secret)" hint="Name: value per line">
                    <textarea className="input mono min-h-[56px] resize-y text-[12px]" value={cfg.headers ?? ''} onChange={set('headers')} />
                  </Field>
                </>
              )}
            </>
          )}

          {type === 'openapi' && (
            <>
              <Field label="Specification source">
                <SelectBox value={cfg.specSource ?? 'url'} onChange={(v) => setCfg((c) => ({ ...c, specSource: v }))}
                  options={[{ value: 'url', label: 'URL' }, { value: 'pasted', label: 'Paste / upload' }]} />
              </Field>
              {(cfg.specSource ?? 'url') === 'url' ? (
                <Field label="Specification URL"><input className="input mono text-[12.5px]" value={cfg.specUrl ?? ''} onChange={set('specUrl')} placeholder="https://api.example.com/openapi.json" /></Field>
              ) : (
                <Field label="Specification (JSON or YAML)">
                  <>
                    <textarea className="input mono min-h-[120px] resize-y text-[12px]" value={cfg.specText ?? ''} onChange={set('specText')} placeholder='{"openapi": "3.0.0", …}' />
                    <label className="btn-ghost mt-1 inline-flex cursor-pointer px-2 py-1 text-[12px]">
                      <Upload size={12} /> Upload file
                      <input type="file" accept=".json,.yaml,.yml" className="hidden" onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) setCfg((c) => ({ ...c, specText: '' }));
                        if (f) { const text = await f.text(); setCfg((c) => ({ ...c, specText: text })); }
                        e.currentTarget.value = '';
                      }} />
                    </label>
                  </>
                </Field>
              )}
              <Field label="Base URL override" hint="optional — defaults to the spec's servers entry">
                <input className="input mono text-[12.5px]" value={cfg.baseUrl ?? ''} onChange={set('baseUrl')} placeholder="https://api.example.com" />
              </Field>
            </>
          )}

          {type === 'http' && (
            <>
              <Field label="Base URL"><input className="input mono text-[12.5px]" value={cfg.baseUrl ?? ''} onChange={set('baseUrl')} placeholder="https://panel.example.com" /></Field>
              <Field label="Headers sent with every tool (non-secret)" hint="Name: value per line">
                <textarea className="input mono min-h-[56px] resize-y text-[12px]" value={cfg.headers ?? ''} onChange={set('headers')} />
              </Field>
            </>
          )}

          {type === 'ssh' && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2"><Field label="Host"><input className="input mono text-[12.5px]" value={cfg.host ?? ''} onChange={set('host')} placeholder="203.0.113.10" /></Field></div>
                <Field label="Port"><input className="input tabular-nums" value={cfg.port ?? ''} onChange={set('port')} placeholder="22" /></Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="User"><input className="input mono text-[12.5px]" value={cfg.user ?? ''} onChange={set('user')} placeholder="deploy" /></Field>
                <Field label="Default directory" hint="optional"><input className="input mono text-[12.5px]" value={cfg.defaultDir ?? ''} onChange={set('defaultDir')} placeholder="/srv" /></Field>
              </div>
            </>
          )}

          <Field label="Credential" hint={type === 'ssh' ? 'an SSH private key credential' : 'optional'}>
            <SelectBox
              value={credentialId}
              onChange={setCredentialId}
              options={[{ value: '', label: 'None' }, ...creds.map((c) => ({ value: c.id, label: `${c.name} (${c.type})` }))]}
            />
          </Field>
          <p className="text-[11.5px] leading-snug text-dim">
            Saving runs the first connection test{type === 'mcp' ? ' and tool discovery' : type === 'openapi' ? ' and operation discovery' : ''}.
            Credentials are attached by the execution layer at call time — the AI never receives them.
          </p>
        </div>
      )}
    </Modal>
  );
}

function parseKv(text: string | undefined): Record<string, string> | undefined {
  if (!text?.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:=\s]+)\s*[:=]\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------- custom http tool editor

function HttpToolEditor({ integration, tool, onClose, onSaved }: {
  integration: Integration; tool: IntegrationTool | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState(tool?.name ?? '');
  const [description, setDescription] = useState(tool ? tool.defaultDescription : '');
  const [method, setMethod] = useState(tool?.spec.method ?? 'GET');
  const [path, setPath] = useState(tool?.spec.path ?? '/');
  const [params, setParams] = useState<HttpToolParam[]>(tool?.spec.params ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const body = { name, description, method, path, params };
      if (tool) await api.replaceIntegrationTool(integration.id, tool.id, body);
      else await api.createIntegrationTool(integration.id, body);
      toast(`Tool saved — ${integration.slug}_${name}`);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!tool || !confirm(`Delete ${tool.fullName}?`)) return;
    await api.deleteIntegrationTool(integration.id, tool.id);
    onSaved();
  }

  const setParam = (i: number, patch: Partial<HttpToolParam>) =>
    setParams((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  return (
    <Modal
      open
      onClose={onClose}
      title={tool ? `Edit tool — ${tool.fullName}` : `New tool — ${integration.name}`}
      width={640}
      footer={
        <>
          {tool && <button className="btn-ghost mr-auto text-err" onClick={() => void remove()}><Trash2 size={13} /> Delete</button>}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim() || !path.startsWith('/')} onClick={() => void save()}>
            {busy ? <Spinner size={13} /> : 'Save tool'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tool name" hint={`served as ${integration.slug}_<name>`}>
            <input className="input mono text-[12.5px]" value={name} onChange={(e) => setName(e.target.value)} placeholder="restart_service" />
          </Field>
          <Field label="Method">
            <SelectBox value={method} onChange={setMethod} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))} />
          </Field>
        </div>
        <Field label="Path" hint="{name} marks a path parameter">
          <input className="input mono text-[12.5px]" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/services/{service}/restart" />
        </Field>
        <Field label="Description" hint="what the AI reads to decide when to use it">
          <textarea className="input min-h-[56px] resize-y text-[13px]" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Restart a service on the configured hosting account." />
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-mut">Parameters</span>
            <button className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => setParams((ps) => [...ps, { name: '', type: 'string', in: 'query', required: false, description: '' }])}>
              <Plus size={12} /> Add
            </button>
          </div>
          <div className="space-y-1.5">
            {params.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-md border border-linesoft bg-bg0 px-2 py-1.5">
                <input className="input w-[130px] px-2 py-1 font-mono text-[12px]" value={p.name} placeholder="name" onChange={(e) => setParam(i, { name: e.target.value })} />
                <select className="input w-[90px] px-1.5 py-1 text-[12px]" value={p.type} onChange={(e) => setParam(i, { type: e.target.value as HttpToolParam['type'] })}>
                  {['string', 'number', 'boolean', 'json'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="input w-[86px] px-1.5 py-1 text-[12px]" value={p.in} onChange={(e) => setParam(i, { in: e.target.value as HttpToolParam['in'] })}>
                  {['path', 'query', 'body'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <label className="flex items-center gap-1 text-[11.5px] text-dim">
                  <input type="checkbox" className="h-3 w-3 accent-[#6e9bff]" checked={p.required || p.in === 'path'} disabled={p.in === 'path'} onChange={(e) => setParam(i, { required: e.target.checked })} /> required
                </label>
                <input className="input min-w-[120px] flex-1 px-2 py-1 text-[12px]" value={p.description ?? ''} placeholder="description" onChange={(e) => setParam(i, { description: e.target.value })} />
                <button className="rounded p-1 text-dim hover:text-err" onClick={() => setParams((ps) => ps.filter((_, idx) => idx !== i))}><Trash2 size={12} /></button>
              </div>
            ))}
            {params.length === 0 && <p className="text-[12px] text-dim">No parameters — the tool is called with no arguments.</p>}
          </div>
        </div>
        <p className="text-[11.5px] leading-snug text-dim">
          Requests go to {(integration.config as HttpIntegrationConfig).baseUrl}
          {path} with the integration's credential attached server-side. Body parameters are sent as a JSON object.
        </p>
      </div>
    </Modal>
  );
}
