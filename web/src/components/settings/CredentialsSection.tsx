import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CredentialMeta, CredentialType } from '@shared/types';
import { api } from '../../api';
import { timeAgo } from '../../lib/format';
import { useStore } from '../../store';
import { Field, Modal, SelectBox, Spinner } from '../ui';

const TYPE_INFO: Record<CredentialType, { label: string; fields: { key: string; label: string; multiline?: boolean; hint?: string }[] }> = {
  bearer_token: { label: 'Bearer token', fields: [{ key: 'token', label: 'Token', hint: 'sent as Authorization: Bearer …' }] },
  api_key_header: {
    label: 'API key header',
    fields: [{ key: 'header', label: 'Header name', hint: 'e.g. X-Api-Key' }, { key: 'value', label: 'Key value' }],
  },
  basic_auth: { label: 'Basic auth', fields: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }] },
  header_set: { label: 'Header set', fields: [{ key: 'headersJson', label: 'Headers (JSON object)', multiline: true, hint: '{"X-Auth": "…"}' }] },
  env_set: { label: 'Environment variables', fields: [{ key: 'envJson', label: 'Env vars (JSON object)', multiline: true, hint: 'for stdio MCP servers' }] },
  ssh_private_key: { label: 'SSH private key', fields: [{ key: 'privateKey', label: 'Private key (PEM/OpenSSH)', multiline: true }] },
  // written only by an integration's Sign in — there is nothing here to type
  oauth: { label: 'OAuth sign-in', fields: [] },
};

export function CredentialsSection() {
  const toast = useStore((s) => s.toast);
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);
  const [editing, setEditing] = useState<CredentialMeta | 'new' | null>(null);

  const load = () => api.credentials().then(setCreds).catch(() => setCreds([]));
  useEffect(() => { void load(); }, []);

  async function remove(c: CredentialMeta) {
    try {
      await api.deleteCredential(c.id);
      toast(`Deleted — ${c.name}`);
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  if (!creds) return <div className="card flex justify-center px-4 py-6"><Spinner size={16} /></div>;

  return (
    <div className="card px-4 py-3.5">
      <p className="mb-3 text-[12px] leading-relaxed text-dim">
        Reusable authentication material for integrations. Secrets are encrypted at rest, injected only by the
        execution layer at call time, and never appear in prompts, activity, exports, or this page — replacing a
        value overwrites it.
      </p>
      {creds.length === 0 && <p className="mb-2 text-[12.5px] text-dim">No credentials yet.</p>}
      <div className="space-y-1">
        {creds.map((c) => (
          <div key={c.id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-bg2">
            <KeyRound size={14} className="shrink-0 text-dim" />
            <button className="min-w-0 flex-1 truncate text-left text-[13px] hover:text-accent" onClick={() => setEditing(c)}>
              {c.name}
            </button>
            <span className="shrink-0 text-[11.5px] text-dim">{TYPE_INFO[c.type]?.label ?? c.type}</span>
            <span className="shrink-0 text-[11px] text-dim">
              {c.usedBy.length > 0 ? `used by ${c.usedBy.join(', ')}` : 'unused'} · {timeAgo(c.updatedAt)}
            </span>
            <button
              className="shrink-0 rounded p-1 text-dim opacity-0 transition-opacity hover:bg-bg3 hover:text-err group-hover:opacity-100"
              onClick={() => void remove(c)}
              title={c.usedBy.length > 0 ? 'Detach from integrations first' : 'Delete credential'}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button className="btn-outline mt-3" onClick={() => setEditing('new')}><Plus size={14} /> Add credential</button>
      <CredentialModal
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load(); }}
      />
    </div>
  );
}

function CredentialModal({ editing, onClose, onSaved }: {
  editing: CredentialMeta | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const isNew = editing === 'new';
  const [name, setName] = useState('');
  const [type, setType] = useState<CredentialType>('bearer_token');
  const [data, setData] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing === 'new') { setName(''); setType('bearer_token'); setData({}); }
    else if (editing) { setName(editing.name); setType(editing.type); setData({}); }
  }, [editing]);

  if (!editing) return null;
  const info = TYPE_INFO[type];

  async function save() {
    setBusy(true);
    try {
      if (isNew) await api.createCredential(name, type, data);
      else await api.updateCredential((editing as CredentialMeta).id, { name, data });
      toast(isNew ? 'Credential created' : 'Credential updated');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = isNew && info.fields.some((f) => !String(data[f.key] ?? '').trim());

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'Add credential' : `Credential — ${(editing as CredentialMeta).name}`}
      width={520}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim() || missingRequired} onClick={() => void save()}>
            {busy ? <Spinner size={13} /> : isNew ? 'Create' : 'Save'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cloudflare API Token" /></Field>
        <Field label="Type">
          {isNew ? (
            <SelectBox
              value={type}
              onChange={(v) => { setType(v as CredentialType); setData({}); }}
              options={Object.entries(TYPE_INFO).filter(([value]) => value !== 'oauth').map(([value, t]) => ({ value, label: t.label }))}
            />
          ) : (
            <div className="input flex items-center bg-bg0 text-mut">{info.label}</div>
          )}
        </Field>
        {type === 'oauth' && (
          <p className="rounded-md border border-linesoft bg-bg0 px-3 py-2.5 text-[12.5px] leading-relaxed text-mut">
            This holds the tokens from an OAuth sign-in. Tandem renews them itself. To sign in again or sign out, use
            the integration that uses it, under Integrations.
          </p>
        )}
        {info.fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.multiline ? (
              <textarea
                className="input mono min-h-[92px] resize-y text-[12px]"
                value={data[f.key] ?? ''}
                placeholder={isNew ? '' : '(unchanged — paste to replace)'}
                onChange={(e) => setData((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            ) : (
              <input
                type="password"
                autoComplete="off"
                className="input mono text-[12.5px]"
                value={data[f.key] ?? ''}
                placeholder={isNew ? '' : '(unchanged — type to replace)'}
                onChange={(e) => setData((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        {!isNew && <p className="text-[11.5px] leading-snug text-dim">Stored values are never shown. Fields left blank keep their current value.</p>}
      </div>
    </Modal>
  );
}
