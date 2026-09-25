import { Clapperboard, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Channel } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Modal, SelectBox, Spinner } from './ui';

type ChannelRow = Channel & { description: string; entityCount: number; assetCount: number };

/**
 * New Video: pick a channel (and, rarely, an older version of it), and the
 * normal Project Chat opens. Everything else — topic, title, length, style —
 * is said in the chat; the Director works it out from there.
 */
export function NewVideoDialog() {
  const open = useStore((s) => s.newVideoOpen);
  const setOpen = useStore((s) => s.setNewVideoOpen);
  const navigate = useNavigate();
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [channelId, setChannelId] = useState('');
  const [versions, setVersions] = useState<{ version: number; note: string }[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newAbout, setNewAbout] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.channels().then((list) => {
      setChannels(list);
      if (!channelId && list[0]) setChannelId(list[0].id);
    }).catch((err) => setError(err instanceof Error ? err.message : 'Could not load channels.'));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!channelId) { setVersions([]); setVersion(null); return; }
    api.channel(channelId).then((d) => { setVersions(d.versions); setVersion(d.channel.headVersion); }).catch(() => setVersions([]));
  }, [channelId]);

  async function createChannel() {
    setBusy(true);
    setError(null);
    try {
      const { channel } = await api.createChannel(newName.trim(), newAbout.trim());
      const list = await api.channels();
      setChannels(list);
      setChannelId(channel.id);
      setCreating(false);
      setNewName('');
      setNewAbout('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the channel.');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!channelId) return;
    setBusy(true);
    setError(null);
    try {
      const { run, chat } = await api.createVideoProject(channelId, version ?? undefined);
      useStore.setState((s) => ({
        chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
        projectRuns: { ...s.projectRuns, [run.id]: run },
        newVideoOpen: false,
      }));
      navigate(`/c/${chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the video.');
    } finally {
      setBusy(false);
    }
  }

  const head = channels?.find((c) => c.id === channelId)?.headVersion;

  return (
    <Modal
      open={open}
      onClose={() => !busy && setOpen(false)}
      title="New video"
      width={560}
      footer={(
        <div className="flex items-center justify-end gap-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn-primary gap-1.5" disabled={busy || !channelId} onClick={() => void start()}>
            {busy ? <Spinner size={13} /> : <Clapperboard size={14} />} Start video
          </button>
        </div>
      )}
    >
      <p className="-mt-1 mb-4 text-[12.5px] leading-relaxed text-dim">
        Pick the channel this video belongs to. The project chat opens next — tell the Director the topic or idea, and it plans
        the rest with the channel&apos;s characters, style and assets. Nothing paid is generated until you approve the plan and its cost.
      </p>

      {error && <p className="mb-3 rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-err">{error}</p>}

      {channels === null ? (
        <div className="flex justify-center py-8"><Spinner size={16} /></div>
      ) : (
        <div className="space-y-1">
          {channels.map((c) => (
            <label
              key={c.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${c.id === channelId ? 'border-accent/50 bg-accent/[0.06]' : 'border-linesoft hover:bg-bg2'}`}
            >
              <input type="radio" className="mt-1" checked={c.id === channelId} onChange={() => setChannelId(c.id)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-medium">{c.name}</span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-dim">v{c.headVersion} · {c.entityCount} entities · {c.assetCount} assets</span>
                </span>
                {c.description && <span className="mt-0.5 line-clamp-2 block text-[12px] text-dim">{c.description}</span>}
              </span>
            </label>
          ))}
          {channels.length === 0 && !creating && (
            <p className="rounded-lg border border-dashed border-linesoft px-3 py-3 text-[12.5px] text-dim">
              No channels yet. Create one here, or describe it in any chat (“create a channel called What If…”) and the agents build its
              style, characters and references for you.
            </p>
          )}
        </div>
      )}

      {creating ? (
        <div className="mt-3 space-y-2 rounded-lg border border-linesoft px-3 py-3">
          <input className="input" placeholder="Channel name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <textarea className="input min-h-[64px]" placeholder="What the channel is about (optional)" value={newAbout} onChange={(e) => setNewAbout(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn-outline" disabled={busy || !newName.trim()} onClick={() => void createChannel()}>Create channel</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between">
          <button className="btn-ghost gap-1.5 text-[12.5px]" onClick={() => setCreating(true)}><Plus size={13} /> New channel</button>
          <Link to="/channels" className="text-[12.5px] text-accent hover:underline" onClick={() => setOpen(false)}>Manage channels</Link>
        </div>
      )}

      {versions.length > 1 && (
        <div className="mt-4 border-t border-linesoft pt-3">
          <div className="mb-1.5 text-[12.5px] font-medium text-mut">Channel version</div>
          <SelectBox
            ariaLabel="Channel version"
            value={String(version ?? head ?? '')}
            onChange={(v) => setVersion(Number(v))}
            options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}${v.version === head ? ' (latest)' : ''} — ${v.note}`.slice(0, 90) }))}
          />
          <p className="mt-1.5 text-[11.5px] text-dim">The video stays on this version even when the channel changes later.</p>
        </div>
      )}
    </Modal>
  );
}
