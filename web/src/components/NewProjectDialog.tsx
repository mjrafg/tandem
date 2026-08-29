import { ChevronRight, CornerLeftUp, FolderGit2, FolderOpen, FolderUp, Loader2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DirListing, Project } from '@shared/types';
import { api, ApiError } from '../api';
import { fmtBytes, timeAgo } from '../lib/format';
import { useStore } from '../store';
import { Modal, Spinner } from './ui';

type Tab = 'directory' | 'zip' | 'git';

export function NewProjectDialog() {
  const open = useStore((s) => s.newProjectOpen);
  const setOpen = useStore((s) => s.setNewProjectOpen);
  const projects = useStore((s) => s.projects);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('directory');
  const [busy, setBusy] = useState(false);

  async function startChat(project: Project) {
    const chat = await api.newChat(project.id);
    useStore.setState((s) => ({
      chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [project, ...s.projects],
      newProjectOpen: false,
    }));
    navigate(`/c/${chat.id}`);
  }

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && setOpen(false)} title="New chat" width={640}>
      {projects.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-dim">Recent projects</div>
          <div className="max-h-[168px] space-y-0.5 overflow-y-auto">
            {projects.slice(0, 8).map((p) => (
              <button
                key={p.id}
                disabled={busy}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-bg2"
                onClick={() => void withBusy(() => startChat(p))}
              >
                <FolderOpen size={15} className="shrink-0 text-dim" />
                <span className="text-[13px] font-medium">{p.name}</span>
                <span className="mono min-w-0 flex-1 truncate text-[11px] text-dim">{p.rootPath}</span>
                <span className="shrink-0 text-[11px] text-dim">{timeAgo(p.lastOpenedAt)}</span>
              </button>
            ))}
          </div>
          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-dim">
            <span className="h-px flex-1 bg-linesoft" /> or add a project <span className="h-px flex-1 bg-linesoft" />
          </div>
        </div>
      )}

      <div className="mb-4 flex gap-1 rounded-lg bg-bg0 p-1">
        {([
          ['directory', 'Server directory', FolderOpen],
          ['zip', 'Upload ZIP', Upload],
          ['git', 'Git repository', FolderGit2],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            className={`btn flex-1 gap-1.5 py-1.5 ${tab === key ? 'bg-bg3 text-ink' : 'text-dim hover:text-mut'}`}
            onClick={() => setTab(key)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === 'directory' && <DirectoryTab busy={busy} onPick={(p) => void withBusy(async () => startChat(await api.addDirectory(p)))} />}
      {tab === 'zip' && <ZipTab busy={busy} onDone={(p) => void withBusy(() => startChat(p))} toast={toast} setBusy={setBusy} />}
      {tab === 'git' && <GitTab busy={busy} setBusy={setBusy} onDone={(p) => void withBusy(() => startChat(p))} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- directory

function DirectoryTab({ onPick, busy }: { onPick: (path: string) => void; busy: boolean }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function browse(target: string) {
    setError(null);
    try {
      const l = await api.listDir(target);
      setListing(l);
      setPath(l.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot read directory');
    }
  }

  useEffect(() => {
    void browse('/');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex gap-2">
        <input
          className="input mono text-[12.5px]"
          placeholder="/srv/projects/my-app"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void browse(path); }}
        />
        <button className="btn-primary shrink-0" disabled={!path.trim() || busy} onClick={() => onPick(path.trim())}>
          {busy ? <Spinner size={13} /> : 'Open'}
        </button>
      </div>
      {error && <p className="mt-2 rounded-md bg-err/10 px-3 py-1.5 text-[12px] text-[#ffb3ae]">{error}</p>}

      {listing && (
        <div className="mt-3 overflow-hidden rounded-lg border border-linesoft">
          <div className="flex items-center gap-1 border-b border-linesoft bg-bg0 px-2 py-1.5">
            {listing.quickLinks.map((q) => (
              <button key={q.path} className="chip cursor-pointer rounded-md hover:bg-bg3 hover:text-ink" onClick={() => void browse(q.path)}>
                {q.name}
              </button>
            ))}
            <span className="mono ml-auto truncate pl-2 text-[11px] text-dim">{listing.path}</span>
          </div>
          <div className="max-h-[220px] overflow-y-auto py-1">
            {listing.parent && (
              <button className="flex w-full items-center gap-2 px-3 py-[5px] text-[12.5px] text-dim hover:bg-bg2" onClick={() => void browse(listing.parent!)}>
                <CornerLeftUp size={13} /> ..
              </button>
            )}
            {listing.dirs.map((d) => (
              <button key={d.path} className="group flex w-full items-center gap-2 px-3 py-[5px] text-[12.5px] text-mut hover:bg-bg2 hover:text-ink" onClick={() => void browse(d.path)}>
                <FolderOpen size={13} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate text-left">{d.name}</span>
                <ChevronRight size={12} className="opacity-0 transition-opacity group-hover:opacity-60" />
              </button>
            ))}
            {listing.dirs.length === 0 && <p className="px-3 py-2 text-[12px] text-dim">No subdirectories.</p>}
          </div>
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-dim">Browse the server's filesystem, or paste an absolute path and press Open.</p>
    </div>
  );
}

// ---------------------------------------------------------------- zip

function ZipTab({ onDone, toast, busy, setBusy }: {
  onDone: (p: Project) => void;
  toast: (t: string, k?: 'info' | 'error') => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function upload(file: File) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast('Please choose a .zip file', 'error');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const project = await api.importZip(file);
      setResult(`Imported ${project.imported.files} files (${fmtBytes(project.imported.bytes)}) → ${project.rootPath}`);
      setTimeout(() => onDone(project), 900);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className={`flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-9 transition-colors ${
          dragOver ? 'border-accent bg-accent/5' : 'border-line hover:border-[#333b48] hover:bg-bg2/50'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void upload(f);
        }}
        disabled={busy}
      >
        {busy ? <Loader2 size={22} className="animate-spin text-accent" /> : <FolderUp size={22} className="text-dim" />}
        <span className="text-[13px] text-mut">{busy ? 'Importing…' : 'Drop a ZIP here, or click to choose'}</span>
        <span className="text-[11px] text-dim">Extracted safely into the managed projects directory · up to 400 MB</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.currentTarget.value = '';
        }}
      />
      {result && <p className="mono mt-2.5 rounded-md bg-ok/10 px-3 py-2 text-[11.5px] text-[#9fdca6]">{result}</p>}
      <p className="mt-2 text-[11.5px] text-dim">Nothing runs automatically after import — the agent waits for your first message.</p>
    </div>
  );
}

// ---------------------------------------------------------------- git

function GitTab({ onDone, busy, setBusy }: { onDone: (p: Project) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<{ message: string; output?: string } | null>(null);
  const [progress, setProgress] = useState(false);

  async function clone() {
    setError(null);
    setBusy(true);
    setProgress(true);
    try {
      const project = await api.gitClone(url.trim());
      onDone(project);
    } catch (err) {
      if (err instanceof ApiError) setError({ message: err.message, output: err.output });
      else setError({ message: err instanceof Error ? err.message : 'Clone failed' });
      setBusy(false);
    } finally {
      setProgress(false);
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          className="input mono text-[12.5px]"
          placeholder="https://github.com/user/repository.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) void clone(); }}
        />
        <button className="btn-primary shrink-0" disabled={!url.trim() || busy} onClick={() => void clone()}>
          {progress ? <Spinner size={13} /> : 'Clone'}
        </button>
      </div>
      {progress && <p className="mt-2.5 text-[12.5px] text-mut">Cloning — this can take a moment for large repositories…</p>}
      {error && (
        <div className="mt-2.5 rounded-md border border-err/25 bg-err/10 px-3 py-2">
          <p className="text-[12.5px] font-medium text-[#ffb3ae]">{error.message}</p>
          {error.output && <pre className="mono mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11px] text-mut">{error.output}</pre>}
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-dim">
        Public and private URLs work — private ones use the server's existing git credentials. Cloned into the managed
        projects directory; nothing is modified until you ask.
      </p>
    </div>
  );
}
