import { Check, LogOut, MoreHorizontal, Pencil, Plus, Settings, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Chat, Project } from '@shared/types';
import { api } from '../api';
import { timeAgo } from '../lib/format';
import { useStore } from '../store';
import { Logo } from './ui';

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const setNewProjectOpen = useStore((s) => s.setNewProjectOpen);

  const groups = projects
    .map((p) => ({
      project: p,
      chats: chats.filter((c) => c.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      const la = Math.max(a.project.lastOpenedAt, a.chats[0]?.updatedAt ?? 0);
      const lb = Math.max(b.project.lastOpenedAt, b.chats[0]?.updatedAt ?? 0);
      return lb - la;
    });

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-linesoft bg-bg1">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <Link to="/" className="opacity-95 transition-opacity hover:opacity-100">
          <Logo size={20} />
        </Link>
      </div>

      <div className="px-3 pb-1 pt-1">
        <button
          className="btn-outline w-full justify-start gap-2 border-dashed py-[7px] text-mut hover:text-ink"
          onClick={() => setNewProjectOpen(true)}
        >
          <Plus size={15} />
          New chat
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
        {groups.length === 0 && (
          <p className="px-3 pt-2 text-[12.5px] leading-relaxed text-dim">
            No projects yet. Start with <b className="text-mut">New chat</b> to open a
            directory, upload a ZIP, or clone a repository.
          </p>
        )}
        {groups.map(({ project, chats: projectChats }) => (
          <ProjectGroup key={project.id} project={project} chats={projectChats} />
        ))}
      </nav>

      <SidebarFooter />
    </aside>
  );
}

function ProjectGroup({ project, chats }: { project: Project; chats: Chat[] }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function newChatHere() {
    setCreating(true);
    try {
      const chat = await api.newChat(project.id);
      useStore.setState((s) => ({ chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)] }));
      navigate(`/c/${chat.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mb-1.5">
      <div className="group flex items-center justify-between rounded-md px-2.5 py-1">
        <span className="truncate text-[11.5px] font-semibold uppercase tracking-[0.07em] text-dim" title={project.rootPath}>
          {project.name}
        </span>
        <button
          className="btn-ghost -mr-1 px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={newChatHere}
          disabled={creating}
          title={`New chat in ${project.name}`}
        >
          <Plus size={13} />
        </button>
      </div>
      {chats.map((chat) => (
        <ChatItem key={chat.id} chat={chat} />
      ))}
      {chats.length === 0 && (
        <button onClick={newChatHere} className="w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-dim hover:bg-bg2 hover:text-mut">
          Start first chat…
        </button>
      )}
    </div>
  );
}

function ChatItem({ chat }: { chat: Chat }) {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const active = chatId === chat.id;
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setMenu(false);
        setConfirmDelete(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  async function doDelete() {
    await api.deleteChat(chat.id);
    useStore.setState((s) => ({ chats: s.chats.filter((c) => c.id !== chat.id) }));
    if (active) navigate('/');
  }

  return (
    <div ref={ref} className="relative">
      <Link
        to={`/c/${chat.id}`}
        className={`group flex items-center gap-2 rounded-md py-[5.5px] pl-2.5 pr-1.5 text-[13px] transition-colors ${
          active ? 'bg-bg3 text-ink' : 'text-mut hover:bg-bg2 hover:text-ink'
        }`}
      >
        {chat.running && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-ok pulse-soft" title="Agent working" />}
        {renaming ? (
          <RenameInput chat={chat} done={() => setRenaming(false)} />
        ) : (
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        )}
        {!renaming && (
          <>
            <span className="shrink-0 text-[10.5px] text-dim transition-opacity group-hover:opacity-0">{timeAgo(chat.updatedAt)}</span>
            <button
              className="absolute right-1 shrink-0 rounded p-1 text-dim opacity-0 transition-opacity hover:bg-bg3 hover:text-ink group-hover:opacity-100"
              onClick={(e) => {
                e.preventDefault();
                setMenu((m) => !m);
              }}
              aria-label="Chat menu"
            >
              <MoreHorizontal size={14} />
            </button>
          </>
        )}
      </Link>
      {menu && (
        <div className="card absolute right-1 top-[30px] z-30 w-[168px] py-1 shadow-xl shadow-black/40">
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-mut hover:bg-bg2 hover:text-ink"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            <Pencil size={13} /> Rename
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-err hover:bg-err/10"
            onClick={() => {
              if (confirmDelete) void doDelete();
              else setConfirmDelete(true);
            }}
          >
            <Trash2 size={13} /> {confirmDelete ? 'Confirm delete' : 'Delete chat'}
          </button>
        </div>
      )}
    </div>
  );
}

function RenameInput({ chat, done }: { chat: Chat; done: () => void }) {
  const [value, setValue] = useState(chat.title);

  async function save() {
    const title = value.trim();
    if (title && title !== chat.title) {
      const updated = await api.renameChat(chat.id, title);
      useStore.setState((s) => ({ chats: s.chats.map((c) => (c.id === chat.id ? updated : c)) }));
    }
    done();
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.preventDefault()}>
      <input
        className="input min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-[12.5px]"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') done();
        }}
      />
      <button className="p-0.5 text-ok" onClick={() => void save()} aria-label="Save name"><Check size={13} /></button>
      <button className="p-0.5 text-dim" onClick={done} aria-label="Cancel"><X size={13} /></button>
    </span>
  );
}

function SidebarFooter() {
  const email = useStore((s) => s.email);
  const logout = useStore((s) => s.logout);
  return (
    <div className="border-t border-linesoft px-3 pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-between">
        <span className="truncate text-[12px] text-dim" title={email ?? ''}>{email}</span>
        <div className="flex items-center">
          <Link to="/settings" className="btn-ghost px-1.5 py-1.5" title="Admin & settings">
            <Settings size={15} />
          </Link>
          <button className="btn-ghost px-1.5 py-1.5" onClick={() => void logout()} title="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
