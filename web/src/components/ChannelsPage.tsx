import { ArrowLeft, Clapperboard, Library, Pencil, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Channel, ChannelDetail, MediaAsset } from '@shared/types';
import { api } from '../api';
import { timeAgo } from '../lib/format';
import { useStore } from '../store';
import { MenuButton, SelectBox, Spinner } from './ui';

type ChannelRow = Channel & { description: string; entityCount: number; assetCount: number };

/**
 * Channels: the reusable identity shared by many videos. Everything here is
 * also available to agents through the tandem_channel tools — this page is
 * for looking, and for the edits a person wants to make by hand. Every save
 * is a new version; videos stay on the version they were made with.
 */
export function ChannelsPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const setNewVideoOpen = useStore((s) => s.setNewVideoOpen);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');

  const load = () => api.channels().then(setChannels).catch(() => setChannels([]));
  useEffect(() => { void load(); }, []);

  // no channel in the URL: open the first one
  useEffect(() => {
    if (!channelId && channels && channels[0]) navigate(`/channels/${channels[0].id}`, { replace: true });
  }, [channelId, channels, navigate]);

  useEffect(() => { setVersion(null); }, [channelId]);
  useEffect(() => {
    if (!channelId) { setDetail(null); return; }
    api.channel(channelId, version ?? undefined).then(setDetail).catch((err) => toast(err instanceof Error ? err.message : 'Could not load the channel', 'error'));
  }, [channelId, version, toast]);

  async function create() {
    try {
      const { channel } = await api.createChannel(name.trim(), about.trim());
      setCreating(false); setName(''); setAbout('');
      await load();
      navigate(`/channels/${channel.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the channel', 'error');
    }
  }

  const reload = () => { if (channelId) void api.channel(channelId).then((d) => { setVersion(null); setDetail(d); }); void load(); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-linesoft px-3 py-2.5 sm:px-4">
        <MenuButton />
        <Link to="/" className="btn-ghost px-1.5 py-1.5" title="Back to chats" aria-label="Back to chats"><ArrowLeft size={16} /></Link>
        <Library size={15} className="text-dim" />
        <span className="text-[14px] font-semibold">Channels</span>
        <button className="btn-primary ml-auto gap-1.5 px-3 py-1.5 text-[12.5px]" onClick={() => setNewVideoOpen(true)}>
          <Clapperboard size={14} /> New video
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="shrink-0 border-b border-linesoft p-3 lg:w-[240px] lg:border-b-0 lg:border-r">
          {channels === null ? <Spinner size={14} /> : (
            <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
              {channels.map((c) => (
                <Link
                  key={c.id}
                  to={`/channels/${c.id}`}
                  className={`shrink-0 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${c.id === channelId ? 'bg-bg3 text-ink' : 'text-mut hover:bg-bg2'}`}
                >
                  <div className="font-medium">{c.name}</div>
                  <div className="text-[11px] tabular-nums text-dim">v{c.headVersion} · {c.entityCount} entities · {c.assetCount} assets</div>
                </Link>
              ))}
              {creating ? (
                <div className="w-[240px] shrink-0 space-y-1.5 rounded-lg border border-linesoft p-2 lg:w-auto">
                  <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                  <textarea className="input min-h-[56px]" placeholder="What it is about" value={about} onChange={(e) => setAbout(e.target.value)} />
                  <div className="flex justify-end gap-1.5">
                    <button className="btn-ghost text-[12px]" onClick={() => setCreating(false)}>Cancel</button>
                    <button className="btn-outline text-[12px]" disabled={!name.trim()} onClick={() => void create()}>Create</button>
                  </div>
                </div>
              ) : (
                <button className="btn-ghost shrink-0 justify-start gap-1.5 text-[12.5px]" onClick={() => setCreating(true)}><Plus size={13} /> New channel</button>
              )}
            </div>
          )}
          {channels?.length === 0 && !creating && (
            <p className="mt-2 text-[12px] leading-relaxed text-dim">
              You can also ask in any chat: “Create a channel called What If — mysterious cinematic videos, with a recurring main character.”
            </p>
          )}
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {detail ? <ChannelView detail={detail} onVersion={setVersion} onSaved={reload} /> : channelId ? <div className="flex justify-center py-16"><Spinner size={18} /></div> : null}
        </main>
      </div>
    </div>
  );
}

function ChannelView({ detail, onVersion, onSaved }: { detail: ChannelDetail; onVersion: (v: number) => void; onSaved: () => void }) {
  const { channel, version, versions, assets, projects } = detail;
  const c = version.content;
  const latest = version.version === channel.headVersion;
  const [filter, setFilter] = useState<'all' | 'reference' | 'production'>('all');
  const byEntity = useMemo(() => {
    const m = new Map<string, MediaAsset[]>();
    for (const a of assets) if (a.entityId) m.set(a.entityId, [...(m.get(a.entityId) ?? []), a]);
    return m;
  }, [assets]);
  const shown = assets.filter((a) => filter === 'all' || a.kind === filter);

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold [text-wrap:balance]">{c.name}</h1>
          {c.description && <p className="mt-1 max-w-[65ch] text-[13px] leading-relaxed text-mut">{c.description}</p>}
        </div>
        <div className="w-[260px] shrink-0">
          <SelectBox
            ariaLabel="Channel version"
            value={String(version.version)}
            onChange={(v) => onVersion(Number(v))}
            options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}${v.version === channel.headVersion ? ' (latest)' : ''} — ${v.note}`.slice(0, 70) }))}
          />
          <p className="mt-1 text-[11.5px] text-dim">
            {latest ? `Latest · changed ${timeAgo(version.createdAt)} by ${version.createdBy}` : `An older version — videos pinned to it still see exactly this.`}
          </p>
        </div>
      </div>

      <StyleBible detail={detail} editable={latest} onSaved={onSaved} />

      <section>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Characters, locations & props</h2>
        {c.entities.length === 0 ? (
          <p className="text-[12.5px] text-dim">None yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {c.entities.map((e) => (
              <div key={e.id} className="rounded-xl border border-linesoft bg-bg1 px-3.5 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13.5px] font-medium">{e.name}</span>
                  <span className="shrink-0 rounded bg-bg3 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide text-mut">{e.type}</span>
                </div>
                <div className="mono mt-0.5 text-[11px] text-dim">{e.id}</div>
                {e.summary && <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">{e.summary}</p>}
                {(byEntity.get(e.id) ?? []).length > 0 && (
                  <div className="mt-2 flex gap-1.5 overflow-x-auto">
                    {(byEntity.get(e.id) ?? []).filter((a) => a.mime.startsWith('image/')).slice(0, 8).map((a) => (
                      <a key={a.id} href={`/api/media/${a.id}`} target="_blank" rel="noreferrer" title={`${a.name} · ${a.kind}`}>
                        <img src={`/api/media/${a.id}?preview=1`} alt={a.name} loading="lazy" className="h-16 w-16 shrink-0 rounded-md bg-bg0 object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Asset library · {assets.length}</h2>
          <div className="flex gap-1">
            {(['all', 'reference', 'production'] as const).map((f) => (
              <button key={f} className={`rounded-md px-2 py-1 text-[11.5px] ${filter === f ? 'bg-bg3 text-ink' : 'text-dim hover:text-mut'}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'reference' ? 'Reference' : 'Production'}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-[12.5px] text-dim">No assets in this version{filter !== 'all' ? ` of that kind` : ''}. Assets made inside a video stay in that video until they are promoted.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            {shown.map((a) => (
              <a key={a.id} href={`/api/media/${a.id}`} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border border-linesoft bg-bg1">
                {a.mime.startsWith('image/') ? (
                  <img src={`/api/media/${a.id}?preview=1`} alt={a.name} loading="lazy" className="aspect-square w-full bg-bg0 object-cover" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-bg0 text-[11px] text-dim">{a.mime}</div>
                )}
                <div className="px-2 py-1.5">
                  <div className="truncate text-[12px] font-medium" title={a.name}>{a.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    <span className={`rounded px-1 text-[10px] uppercase tracking-wide ${a.kind === 'production' ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent'}`}>{a.kind}</span>
                    {a.entityId && <span className="mono truncate text-[10.5px] text-dim">{a.entityId}</span>}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Videos on this channel</h2>
        {projects.length === 0 ? <p className="text-[12.5px] text-dim">None yet.</p> : (
          <div className="space-y-1">
            {projects.map((p) => (
              <Link key={p.runId} to={`/c/${p.chatId}`} className="flex items-center justify-between rounded-lg px-2.5 py-2 text-[13px] hover:bg-bg2">
                <span className="truncate">{p.title}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-dim">pinned to v{p.version}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StyleBible({ detail, editable, onSaved }: { detail: ChannelDetail; editable: boolean; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const sb = detail.version.content.styleBible;
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(sb.summary);
  const [sections, setSections] = useState<[string, string][]>(Object.entries(sb.sections));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setSummary(sb.summary); setSections(Object.entries(sb.sections)); setEditing(false); }, [detail.version.version, detail.channel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true);
    try {
      const next: Record<string, string | null> = {};
      for (const key of Object.keys(sb.sections)) if (!sections.some(([k]) => k === key)) next[key] = null;
      for (const [k, v] of sections) if (k.trim()) next[k.trim()] = v;
      const r = await api.updateChannel(detail.channel.id, { expectedVersion: detail.version.version, styleBible: { summary, sections: next }, note: 'Style Bible edited' });
      toast(`Saved as version ${r.version.version}`);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-linesoft bg-bg1 px-4 py-3.5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-dim">Style Bible</h2>
        {editable && !editing && <button className="btn-ghost gap-1 px-2 py-1 text-[12px]" onClick={() => setEditing(true)}><Pencil size={12} /> Edit</button>}
      </div>
      {editing ? (
        <div className="space-y-2.5">
          <textarea className="input min-h-[72px]" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="The short version every visual agent is handed" />
          {sections.map(([k, v], i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-1.5">
                <input className="input flex-1 text-[12.5px] font-medium" value={k} onChange={(e) => setSections((s) => s.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                <button className="btn-ghost text-[12px]" onClick={() => setSections((s) => s.filter((_, j) => j !== i))}>Remove</button>
              </div>
              <textarea className="input min-h-[64px] text-[12.5px]" value={v} onChange={(e) => setSections((s) => s.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button className="btn-ghost gap-1 text-[12px]" onClick={() => setSections((s) => [...s, ['New section', '']])}><Plus size={12} /> Section</button>
            <div className="flex gap-1.5">
              <button className="btn-ghost text-[12.5px]" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn-primary text-[12.5px]" disabled={saving} onClick={() => void save()}>{saving ? <Spinner size={12} /> : 'Save as new version'}</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <p className="max-w-[70ch] whitespace-pre-wrap text-[13px] leading-relaxed text-mut">{sb.summary || 'No Style Bible yet.'}</p>
          {Object.entries(sb.sections).length > 0 && (
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {Object.entries(sb.sections).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[12px] font-medium text-ink">{k}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-mut">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
