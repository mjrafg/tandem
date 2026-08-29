import {
  Check, ChevronRight, CornerLeftUp, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { DirListing, Project } from '@shared/types';
import { api, ApiError } from '../api';
import { timeAgo } from '../lib/format';
import { useStore } from '../store';
import { Modal, Spinner } from './ui';

export function NewProjectDialog() {
  const open = useStore((s) => s.newProjectOpen);
  const setOpen = useStore((s) => s.setNewProjectOpen);
  const projects = useStore((s) => s.projects);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startChat(project: Project) {
    const chat = await api.newChat(project.id);
    useStore.setState((s) => ({
      chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)],
      projects: s.projects.some((p) => p.id === project.id) ? s.projects : [project, ...s.projects],
      newProjectOpen: false,
    }));
    navigate(`/c/${chat.id}`);
  }

  async function openDirectory(dirPath: string) {
    setBusy(true);
    setError(null);
    try {
      await startChat(await api.addDirectory(dirPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that directory.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && setOpen(false)} title="New chat" width={620}>
      <p className="-mt-1 mb-4 text-[12.5px] text-dim">
        Choose where this conversation starts working. Everything else — cloning a repository,
        opening an attached ZIP, the actual task — happens in the chat itself.
      </p>

      {projects.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-dim">Recent projects</div>
          <div className="max-h-[132px] space-y-0.5 overflow-y-auto">
            {projects.slice(0, 6).map((p) => (
              <button
                key={p.id}
                disabled={busy}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors hover:bg-bg2"
                onClick={() => {
                  setBusy(true);
                  void startChat(p).finally(() => setBusy(false));
                }}
              >
                <FolderOpen size={14} className="shrink-0 text-dim" />
                <span className="shrink-0 text-[13px] font-medium">{p.name}</span>
                <span className="mono min-w-0 flex-1 truncate text-[11px] text-dim">{p.rootPath}</span>
                <span className="shrink-0 text-[11px] text-dim">{timeAgo(p.lastOpenedAt)}</span>
              </button>
            ))}
          </div>
          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-dim">
            <span className="h-px flex-1 bg-linesoft" /> working directory <span className="h-px flex-1 bg-linesoft" />
          </div>
        </div>
      )}

      {error && <p className="mb-3 rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-[#ffb3ae]">{error}</p>}

      <DirBrowser busy={busy} onOpen={(p) => void openDirectory(p)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- browser

function DirBrowser({ onOpen, busy }: { onOpen: (path: string) => void; busy: boolean }) {
  const toast = useStore((s) => s.toast);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ path: string; name: string; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; name: string; entries: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const browse = useCallback(async (target: string, opts: { keepError?: boolean } = {}) => {
    if (!opts.keepError) setActionError(null);
    setBrowseError(null);
    setMenuFor(null);
    setRenaming(null);
    try {
      const l = await api.listDir(target);
      setListing(l);
      setPathInput(l.path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : 'Cannot read directory');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const l = await api.listDir('/');
        const projectsLink = l.quickLinks.find((q) => q.name === 'projects');
        await browse(projectsLink?.path ?? '/');
      } catch {
        await browse('/');
      }
    })();
  }, [browse]);

  // close row menus on outside click / scroll
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onScroll = () => setMenuFor(null);
    window.addEventListener('mousedown', close);
    listRef.current?.querySelector('.dir-list')?.addEventListener('scroll', onScroll);
    return () => {
      window.removeEventListener('mousedown', close);
      listRef.current?.querySelector('.dir-list')?.removeEventListener('scroll', onScroll);
    };
  }, [menuFor]);

  async function createFolder() {
    if (!listing) return;
    const name = newName.trim();
    if (!name) return;
    setActionError(null);
    try {
      const created = await api.mkdir(listing.path, name);
      setCreating(false);
      setNewName('');
      await browse(listing.path);
      toast(`Created ${created.name}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not create the folder.');
    }
  }

  async function renameFolder(dirPath: string, name: string) {
    setActionError(null);
    try {
      await api.renameDir(dirPath, name);
      setRenaming(null);
      await browse(listing!.path);
      toast(`Renamed to ${name.trim()}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rename failed.');
    }
  }

  async function deleteFolder(dirPath: string, name: string, force: boolean) {
    setActionError(null);
    try {
      await api.deleteDir(dirPath, force);
      setConfirmDelete(null);
      await browse(listing!.path, { keepError: true });
      toast(`Deleted ${name}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.requiresConfirm) {
        setConfirmDelete({ path: dirPath, name, entries: Number(err.data.entries ?? 0) });
        return;
      }
      setConfirmDelete(null);
      setActionError(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <input
          className="input mono text-[12.5px]"
          placeholder="/srv/tandem/projects/my-app"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void browse(pathInput.trim());
          }}
        />
        <button className="btn-primary shrink-0 px-4" disabled={!pathInput.trim() || busy} onClick={() => onOpen(pathInput.trim())}>
          {busy ? <Spinner size={13} /> : 'Open'}
        </button>
      </div>

      {(browseError || actionError) && (
        <p className="mt-2 rounded-md bg-err/10 px-3 py-1.5 text-[12px] text-[#ffb3ae]">{browseError || actionError}</p>
      )}

      {listing && (
        <div className="mt-2.5 overflow-hidden rounded-lg border border-linesoft" ref={listRef}>
          <div className="flex flex-wrap items-center gap-1 border-b border-linesoft bg-bg0 px-2 py-1.5">
            {listing.quickLinks.map((q) => (
              <button
                key={q.path}
                className={`chip cursor-pointer rounded-md hover:bg-bg3 hover:text-ink ${listing.path === q.path ? 'bg-bg3 text-ink' : ''}`}
                onClick={() => void browse(q.path)}
              >
                {q.name}
              </button>
            ))}
            <button
              className="chip ml-auto cursor-pointer rounded-md text-mut hover:bg-bg3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!listing.writable}
              title={listing.writable ? 'Create a folder here' : 'This directory is not writable'}
              onClick={() => {
                setCreating(true);
                setNewName('');
              }}
            >
              <FolderPlus size={13} />
              New folder
            </button>
          </div>

          <div className="dir-list max-h-[224px] overflow-y-auto py-1">
            {listing.parent && (
              <button className="flex w-full items-center gap-2 px-3 py-[5px] text-[12.5px] text-dim hover:bg-bg2" onClick={() => void browse(listing.parent!)}>
                <CornerLeftUp size={13} /> ..
              </button>
            )}

            {creating && (
              <div className="flex items-center gap-2 px-3 py-[4px]">
                <FolderPlus size={13} className="shrink-0 text-accent" />
                <input
                  className="input min-w-0 flex-1 rounded-md px-2 py-[3px] text-[12.5px]"
                  placeholder="folder-name"
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createFolder();
                    if (e.key === 'Escape') setCreating(false);
                  }}
                />
                <button className="p-1 text-ok hover:bg-bg3 rounded" onClick={() => void createFolder()} aria-label="Create folder"><Check size={14} /></button>
                <button className="p-1 text-dim hover:bg-bg3 rounded" onClick={() => setCreating(false)} aria-label="Cancel"><X size={14} /></button>
              </div>
            )}

            {listing.dirs.map((d) => (
              <div key={d.path} className="group relative">
                {renaming === d.path ? (
                  <RenameRow
                    initial={d.name}
                    onSave={(name) => void renameFolder(d.path, name)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <div className="flex items-center">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-[5px] text-[12.5px] text-mut hover:bg-bg2 hover:text-ink"
                      onClick={() => void browse(d.path)}
                    >
                      <FolderOpen size={13} className="shrink-0 text-dim" />
                      <span className="min-w-0 flex-1 truncate text-left">{d.name}</span>
                      <ChevronRight size={12} className="mr-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
                    </button>
                    <button
                      className={`absolute right-1.5 rounded p-1 text-dim transition-opacity hover:bg-bg3 hover:text-ink group-hover:opacity-100 ${menuFor?.path === d.path ? 'opacity-100 bg-bg3 text-ink' : 'opacity-0'}`}
                      onClick={(e) => {
                        if (menuFor?.path === d.path) {
                          setMenuFor(null);
                          return;
                        }
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenuFor({ path: d.path, name: d.name, x: rect.right, y: rect.bottom + 4 });
                      }}
                      aria-label={`Actions for ${d.name}`}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {listing.dirs.length === 0 && !creating && (
              <p className="px-3 py-2.5 text-[12px] text-dim">
                No subdirectories.{listing.writable ? ' Create one with New folder, or open this directory as the workspace.' : ''}
              </p>
            )}
          </div>
        </div>
      )}

      {!listing && !browseError && (
        <div className="mt-3 flex justify-center py-6"><Spinner size={16} /></div>
      )}

      {menuFor && createPortal(
        <div
          ref={menuRef}
          className="card fixed z-[70] w-[150px] py-1 shadow-xl shadow-black/40"
          style={{ left: menuFor.x - 150, top: menuFor.y }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-mut hover:bg-bg2 hover:text-ink"
            onClick={() => {
              setRenaming(menuFor.path);
              setMenuFor(null);
            }}
          >
            <Pencil size={13} /> Rename
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-err hover:bg-err/10"
            onClick={() => {
              const { path: dp, name } = menuFor;
              setMenuFor(null);
              void deleteFolder(dp, name, false);
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>,
        document.body,
      )}

      {confirmDelete && (
        <div className="absolute inset-0 z-40 -m-2 flex items-center justify-center rounded-xl bg-black/60 p-4 backdrop-blur-[1px]">
          <div className="card fade-up w-full max-w-[400px] px-5 py-4 shadow-2xl shadow-black/50">
            <div className="text-[14px] font-semibold">Delete “{confirmDelete.name}”?</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-mut">
              This folder is not empty — it contains {confirmDelete.entries} item{confirmDelete.entries === 1 ? '' : 's'}.
              Its contents will also be <b className="text-[#ffb3ae]">permanently deleted</b>.
            </p>
            <p className="mono mt-1.5 break-all text-[11px] text-dim">{confirmDelete.path}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="btn bg-err px-3 text-white hover:brightness-110"
                onClick={() => void deleteFolder(confirmDelete.path, confirmDelete.name, true)}
              >
                <Trash2 size={13} /> Delete folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameRow({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex items-center gap-2 px-3 py-[4px]">
      <Pencil size={13} className="shrink-0 text-accent" />
      <input
        className="input min-w-0 flex-1 rounded-md px-2 py-[3px] text-[12.5px]"
        value={value}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onSave(value);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button className="rounded p-1 text-ok hover:bg-bg3" onClick={() => value.trim() && onSave(value)} aria-label="Save name"><Check size={14} /></button>
      <button className="rounded p-1 text-dim hover:bg-bg3" onClick={onCancel} aria-label="Cancel"><X size={14} /></button>
    </div>
  );
}
