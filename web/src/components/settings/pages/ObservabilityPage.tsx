import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ObservabilityKey } from '@shared/types';
import { api } from '../../../api';
import { timeAgo } from '../../../lib/format';
import { useStore } from '../../../store';
import { Field, Modal, Spinner } from '../../ui';
import { PageHeader } from '../SettingsLayout';

/**
 * Observability API keys.
 *
 * Read-only credentials for an external consumer (Tandem Observatory). The
 * secret is shown exactly once, at creation: Tandem stores only a hash and a
 * short prefix, so there is no path — here or anywhere else — that can reveal
 * it again.
 */
export function ObservabilityPage() {
  const toast = useStore((s) => s.toast);
  const [keys, setKeys] = useState<ObservabilityKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; secret: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setKeys((await api.observabilityKeys()).keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load API keys.');
      setKeys([]);
    }
  }
  useEffect(() => { void load(); }, []);

  async function revoke(k: ObservabilityKey) {
    setBusyId(k.id);
    try {
      await api.revokeObservabilityKey(k.id);
      await load();
      toast(`${k.name} revoked`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Revoke failed', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const endpoint = `${window.location.origin}/api/observability/v1`;
  const active = (keys ?? []).filter((k) => !k.revokedAt);
  const revoked = (keys ?? []).filter((k) => k.revokedAt);

  return (
    <>
      <PageHeader
        title="Observability API"
        action={<button className="btn-primary gap-1.5 py-[7px] text-[12.5px]" onClick={() => setCreating(true)}><Plus size={14} /> Create API key</button>}
      >
        A read-only interface for an external consumer to read the evidence Tandem already retains — session and
        project-run logs, events and screenshots — plus a lifecycle wake-up stream. Keys grant reads only; they can
        never change anything in Tandem.
      </PageHeader>

      <div className="card mb-3 px-4 py-3">
        <div className="text-[12px] text-dim">Endpoint</div>
        <div className="mt-0.5 flex items-center gap-2">
          <code className="mono min-w-0 flex-1 truncate text-[12.5px] text-mut">{endpoint}</code>
          <CopyButton value={endpoint} label="Copy endpoint" />
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-dim">
          Authenticate with <code className="mono">Authorization: Bearer &lt;key&gt;</code>. Also serves
          <code className="mono"> /stream</code> for lifecycle signals.
        </p>
      </div>

      <h2 className="mb-2 mt-5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">API keys</h2>

      {error && <div className="card mb-3 px-4 py-3 text-[12.5px] text-err">{error}</div>}
      {keys === null && <div className="card flex items-center gap-2 px-4 py-6 text-[12.5px] text-dim"><Spinner size={14} /> Loading keys…</div>}
      {keys !== null && active.length === 0 && !error && (
        <div className="card px-4 py-8 text-center text-[12.5px] text-dim">
          No API keys yet. <button className="text-accent hover:underline" onClick={() => setCreating(true)}>Create the first one</button>.
        </div>
      )}

      <div className="space-y-2">
        {active.map((k) => (
          <div key={k.id} className="card px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <KeyRound size={14} className="shrink-0 text-dim" />
              <span className="truncate text-[13.5px] font-semibold">{k.name}</span>
              <code className="mono shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[11px] text-dim">{k.keyPrefix}…</code>
              <span className="shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-dim">Read-only</span>
              <button
                className="btn-ghost ml-auto shrink-0 gap-1.5 text-[12px] text-mut hover:text-err"
                disabled={busyId === k.id}
                onClick={() => void revoke(k)}
              >
                {busyId === k.id ? <Spinner size={13} /> : <Trash2 size={13} />} Revoke
              </button>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-dim">
              <span>Created {timeAgo(k.createdAt)}</span>
              <span>{k.lastUsedAt ? `Last used ${timeAgo(k.lastUsedAt)}` : 'Never used'}</span>
            </div>
          </div>
        ))}
      </div>

      {revoked.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Revoked</h2>
          <div className="space-y-2">
            {revoked.map((k) => (
              <div key={k.id} className="card flex flex-wrap items-center gap-2 px-3.5 py-2.5 opacity-60">
                <span className="min-w-0 flex-1 truncate text-[13px]">{k.name} <code className="mono text-[11px] text-dim">{k.keyPrefix}…</code></span>
                <span className="text-[11.5px] text-dim">revoked {timeAgo(k.revokedAt!)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={async (name, secret) => { setCreating(false); setRevealed({ name, secret }); await load(); }}
        />
      )}
      {revealed && <RevealDialog name={revealed.name} secret={revealed.secret} onClose={() => setRevealed(null)} />}
    </>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string, secret: string) => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.createObservabilityKey(name.trim());
      await onCreated(res.key.name, res.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the key.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Create API key" width={480}>
      <Field label="Name" hint="how you will recognize this consumer">
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="Observatory Production"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create(); }}
        />
      </Field>
      {error && <p className="mt-3 rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-err">{error}</p>}
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        The key is shown once, immediately after creation. Tandem stores only a hash and a short prefix, so it cannot
        be shown again.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn-primary gap-2" onClick={() => void create()} disabled={saving || !name.trim()}>
          {saving ? <Spinner size={13} /> : <Check size={14} />} Create
        </button>
      </div>
    </Modal>
  );
}

function RevealDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="API key created" width={560}>
      <p className="text-[12.5px] text-mut">{name}</p>
      <div className="mt-2 rounded-lg border border-linesoft bg-bg0 px-3 py-2.5">
        <code className="mono block break-all text-[12.5px] leading-relaxed text-ink" data-testid="observability-secret">{secret}</code>
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-warn">
        Copy this key now. It will not be shown again.
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <CopyButton value={secret} label="Copy" primary />
        <button className="btn-ghost" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

function CopyButton({ value, label, primary }: { value: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`${primary ? 'btn-primary' : 'btn-ghost'} gap-1.5 text-[12.5px]`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* clipboard unavailable — the value stays selectable on screen */ }
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : label}
    </button>
  );
}
