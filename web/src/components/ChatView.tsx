import { ArrowDown, Boxes, Check, Copy, FolderOpen, FolderTree, Globe, ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Chat, Project } from '@shared/types';
import { selectChat, selectProject, useStore } from '../store';
import { CompactDialog } from './CompactDialog';
import { CHAT_MIN, DOCK_SIZES, Dock, type DockId, loadDockWidths, saveDockWidths, useWide } from './Dock';
import { Composer } from './Composer';
import { ContextBanner, ContextMeter } from './ContextMeter';
import { BrowserPanel, type LiveRole } from './browser/BrowserPanel';
import { ExportMenu } from './ExportMenu';
import { FilesPanel, type FilesTab } from './files/FilesPanel';
import { GitChip } from './GitChip';
import { ProjectMemoryMenu } from './ProjectMemoryMenu';
import { ProjectDrawer } from './ProjectDrawer';
import { Timeline } from './timeline/Timeline';
import { MenuButton, Spinner } from './ui';

export function ChatView() {
  const { chatId } = useParams<{ chatId: string }>();
  const chat = useStore(selectChat(chatId));
  const project = useStore(selectProject(chat?.projectId));
  const events = useStore((s) => (chatId ? s.events[chatId] : undefined));
  const usage = useStore((s) => (chatId ? s.usage[chatId] : undefined));
  const loaded = useStore((s) => (chatId ? !!s.loaded[chatId] : false));
  const loadError = useStore((s) => (chatId ? s.loadError[chatId] : undefined));
  const loadChat = useStore((s) => s.loadChat);
  const loadSettings = useStore((s) => s.loadSettings);
  const settings = useStore((s) => s.settings);
  const [compactOpen, setCompactOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>();
  const isProject = chat?.kind === 'project';
  // ---- docks: the project's structure, its files, an agent's browser. On a
  // wide screen any of them sit side by side beside the chat, each resizable;
  // on a narrower one, one at a time.
  const wide = useWide();
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const [docks, setDocks] = useState<DockId[]>([]); // open ones, oldest first
  const [widths, setWidths] = useState(loadDockWidths);
  const [rowWidth, setRowWidth] = useState(0);
  const rowWidthRef = useRef(0);
  rowWidthRef.current = rowWidth;
  const observer = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    observer.current = new ResizeObserver(([e]) => setRowWidth(Math.round(e.contentRect.width)));
    observer.current.observe(node);
  }, []);

  const openDock = useCallback((id: DockId) => setDocks((cur) => {
    if (cur.includes(id)) return cur;
    if (!wideRef.current) return [id];
    const next = [...cur, id];
    // if even their smallest sizes cannot sit beside the chat, the oldest goes
    const avail = rowWidthRef.current;
    while (avail > 0 && next.length > 1 && next.reduce((n, d) => n + DOCK_SIZES[d].min, 0) + CHAT_MIN > avail) next.shift();
    return next;
  }), []);
  const closeDock = useCallback((id: DockId) => setDocks((cur) => cur.filter((d) => d !== id)), []);
  const docksRef = useRef<DockId[]>([]);
  docksRef.current = docks;
  const flipDock = useCallback((id: DockId) => (docksRef.current.includes(id) ? closeDock(id) : openDock(id)), [openDock, closeDock]);
  const resizeDock = useCallback((id: DockId, w: number) => setWidths((cur) => {
    const next = { ...cur, [id]: w };
    saveDockWidths(next);
    return next;
  }), []);

  // a narrow screen shows the most recently opened dock only
  const shown = wide ? docks : docks.slice(-1);
  // the widths the open docks get: what the user chose, squeezed toward their
  // minimums (without forgetting the choice) when the window cannot fit them all
  const fitted = useMemo(() => {
    const w = {} as Record<DockId, number>;
    for (const d of shown) w[d] = Math.max(DOCK_SIZES[d].min, widths[d]);
    if (wide && rowWidth > 0) {
      const room = Math.max(0, rowWidth - CHAT_MIN);
      const total = shown.reduce((n, d) => n + w[d], 0);
      const slack = shown.reduce((n, d) => n + (w[d] - DOCK_SIZES[d].min), 0);
      if (total > room && slack > 0) {
        const k = Math.min(1, (total - room) / slack);
        for (const d of shown) w[d] = Math.round(w[d] - (w[d] - DOCK_SIZES[d].min) * k);
      }
    }
    return w;
  }, [shown.join(','), widths, wide, rowWidth]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomFor = (id: DockId) => Math.max(0, rowWidth - CHAT_MIN) - shown.filter((d) => d !== id).reduce((n, d) => n + fitted[d], 0);

  const [filesTab, setFilesTab] = useState<FilesTab>('files');
  const openFiles = useCallback((tab: FilesTab) => { setFilesTab(tab); openDock('files'); }, [openDock]);
  const [browserRole, setBrowserRole] = useState<LiveRole>('builder');
  // "Watch live" on a browser step in the timeline
  const browserRequest = useStore((s) => s.browserRequest);
  useEffect(() => {
    if (browserRequest && browserRequest.chatId === chatId) { setBrowserRole(browserRequest.role); openDock('browser'); }
  }, [browserRequest, chatId, openDock]);

  useEffect(() => {
    if (chatId && !loaded) void loadChat(chatId);
  }, [chatId, loaded, loadChat]);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  // moving to another chat keeps the docks you had open; the project dock
  // belongs to project chats only, and on a wide screen it opens with them
  useEffect(() => {
    setDocks((cur) => {
      const next = cur.filter((d) => d !== 'project' || isProject);
      return isProject && wideRef.current && !next.includes('project') ? ['project', ...next] : next;
    });
  }, [isProject, chatId]);

  // ---- scroll pinning
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    setPinned(nearBottom);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatId, loaded]);

  if (!chatId) return null;

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-[13.5px] text-mut">{loadError}</p>
        <button className="btn-outline" onClick={() => void loadChat(chatId)}>Retry</button>
      </div>
    );
  }

  if (!chat || !loaded || !project) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div ref={rowRef} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <TopBar chat={chat} project={project} onCompact={() => setCompactOpen(true)}
        isProject={isProject} docks={docks} onToggleDock={flipDock} onOpenChanges={() => openFiles('changes')} />
      <ContextBanner usage={usage} onCompact={() => setCompactOpen(true)} />

      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-3 pb-6 pt-4 sm:px-5">
          {events && events.length > 0 ? (
            <Timeline events={events} />
          ) : (
            <EmptyChat project={project} onSuggest={(t) => setPrefill(t)} />
          )}
          {chat.running && <WorkingIndicator />}
        </div>
      </div>

      {!pinned && (
        <div className="pointer-events-none relative">
          <button
            className="btn pointer-events-auto absolute -top-11 left-1/2 -translate-x-1/2 rounded-full border border-line bg-bg2 px-3 py-1.5 text-[12px] text-mut shadow-lg shadow-black/30 hover:text-ink"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              setPinned(true);
            }}
          >
            <ArrowDown size={13} /> Latest
          </button>
        </div>
      )}

      {chat.kind === 'pd-session' ? (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-linesoft px-4 py-3 text-center text-[12.5px] text-dim">
          <span>
            This session belongs to{' '}
            {chat.session ? <span className="text-mut">{chat.session.runTitle}</span> : 'a project'} and is driven by its Project Director — talk to it from the Project Chat.
          </span>
          {chat.session && (
            <Link to={`/c/${chat.session.projectChatId}`} className="text-accent hover:underline">
              {/* inline, so a long project name wraps with its arrow instead of leaving it on a line of its own */}
              <ArrowLeft size={12} className="mr-1 inline-block align-[-1px]" />Back to {chat.session.runTitle}
            </Link>
          )}
        </div>
      ) : (
        <Composer chat={chat} prefill={prefill} onUsedPrefill={() => setPrefill(undefined)} />
      )}
      <CompactDialog chatId={chat.id} open={compactOpen} onClose={() => setCompactOpen(false)} />
      </div>
      {shown.map((id) => {
        const close = () => closeDock(id);
        const body = id === 'project'
          ? (isProject && chat.projectRunId ? <ProjectDrawer runId={chat.projectRunId} open onClose={close} /> : null)
          : id === 'files'
            ? <FilesPanel chat={chat} project={project} open tab={filesTab} onTab={setFilesTab} onClose={close} />
            : <BrowserPanel chat={chat} open role={browserRole} onRole={setBrowserRole} onClose={close} />;
        if (!body) return null;
        return (
          <Dock
            key={id} id={id} label={id === 'project' ? 'Project panel' : id === 'files' ? 'Files panel' : 'Browser panel'}
            wide={wide} width={fitted[id]} maxWidth={roomFor(id)} onResize={(w) => resizeDock(id, w)} onClose={close}
          >
            {body}
          </Dock>
        );
      })}
    </div>
  );
}

function TopBar({ chat, project, onCompact, isProject, docks, onToggleDock, onOpenChanges }: {
  chat: Chat; project: Project; onCompact: () => void; isProject?: boolean;
  docks: DockId[]; onToggleDock: (id: DockId) => void; onOpenChanges: () => void;
}) {
  const dockBtn = (id: DockId) => `btn-ghost px-2 py-1.5 ${docks.includes(id) ? 'bg-bg2 text-ink' : ''}`;
  const usage = useStore((s) => s.usage[chat.id]);
  const [copied, setCopied] = useState(false);
  const parent = chat.kind === 'pd-session' ? chat.session ?? null : null;
  // where this session sits in the plan: milestone, key, name
  const place = parent && (
    <span className="inline-flex min-w-0 items-center gap-1 text-[12.5px] text-mut">
      {parent.milestoneKey && <span className="mono shrink-0 text-dim">{parent.milestoneKey}</span>}
      <span className="mono shrink-0 text-dim">{parent.key}</span>
      <span className="truncate">{parent.name}</span>
    </span>
  );
  return (
    // One row from `sm` up. On a phone a project-owned session takes two: the
    // parent project and the way back get the first row to themselves, and the
    // session's place in the plan sits under it beside the git chip — the chip
    // is one element moved with flex order, so git status is fetched once.
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-linesoft px-2 sm:h-[50px] sm:flex-nowrap sm:gap-x-3 sm:px-4">
      <div className="flex h-[50px] min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
        <MenuButton />
        {parent ? (
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-[13.5px] sm:flex-initial">
            <Link
              to={`/c/${parent.projectChatId}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-[3px] text-[12.5px] font-medium text-accent hover:bg-accent/20"
              title={`Back to the project: ${parent.runTitle}`}
            >
              <ArrowLeft size={13} className="shrink-0" />
              <Boxes size={13} className="shrink-0" />
              <span className="truncate">{parent.runTitle}</span>
            </Link>
            <span className="hidden text-dim sm:inline">›</span>
            <span className="hidden min-w-0 sm:inline-flex">{place}</span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 max-w-[40vw] shrink items-center gap-1.5 text-[13.5px] font-medium sm:max-w-[45vw]">
            <FolderOpen size={14} className="shrink-0 text-dim" />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        <button
          className="group hidden min-w-0 flex-1 items-center gap-1 sm:flex"
          title="Copy path"
          onClick={() => {
            void navigator.clipboard.writeText(project.rootPath);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          <span className="mono truncate text-[11.5px] text-dim group-hover:text-mut">{project.rootPath}</span>
          {copied
            ? <Check size={11} className="shrink-0 text-ok" />
            : <Copy size={11} className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100" />}
        </button>
        {!parent && <GitChip projectId={project.id} gitState={chat.gitState} onOpenChanges={onOpenChanges} />}
      </div>
      {parent && (
        <>
          {/* forces the wrap on a phone; nothing from sm up */}
          <span className="order-1 basis-full sm:hidden" aria-hidden />
          <div className="order-1 -mt-1.5 flex min-w-0 flex-1 items-center pb-2 sm:hidden">{place}</div>
          <div className="order-1 -mt-1.5 flex min-w-0 shrink items-center pb-2 sm:order-none sm:mt-0 sm:pb-0">
            <GitChip projectId={project.id} gitState={chat.gitState} onOpenChanges={onOpenChanges} />
          </div>
        </>
      )}
      <div className="flex h-[50px] shrink-0 items-center gap-1.5 sm:order-2">
        <ContextMeter usage={usage} onCompact={onCompact} />
        <ProjectMemoryMenu projectId={project.id} />
        <ExportMenu chatId={chat.id} />
        <button className={dockBtn('files')} onClick={() => onToggleDock('files')} aria-pressed={docks.includes('files')} title="Files, changes and branches" aria-label="Files, changes and branches">
          <FolderTree size={15} />
        </button>
        <button className={dockBtn('browser')} onClick={() => onToggleDock('browser')} aria-pressed={docks.includes('browser')} title="The Builder's and Reviewer's browser, live" aria-label="Live browser">
          <Globe size={15} />
        </button>
        {isProject && (
          <button className={dockBtn('project')} onClick={() => onToggleDock('project')} aria-pressed={docks.includes('project')} title="Project structure" aria-label="Project structure">
            <Boxes size={15} />
          </button>
        )}
      </div>
    </header>
  );
}

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-2.5">
      <Spinner size={13} />
      <span className="working-text text-[13px]">Working…</span>
    </div>
  );
}

const suggestions = [
  'Explain what this project does',
  'Run the tests and tell me what failed',
  'Fix the rounding bug in checkout totals',
  'Why is this page slow?',
];

function EmptyChat({ project, onSuggest }: { project: Project; onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-4 pb-8 pt-[16vh] text-center">
      <div className="text-[16px] font-semibold">{project.name}</div>
      <p className="mono max-w-full truncate text-[12px] text-dim">{project.rootPath}</p>
      <p className="max-w-[460px] text-[13px] leading-relaxed text-mut">
        Ask anything — the Builder decides for itself whether to answer, investigate,
        run commands, or change code. Paste a repository URL to clone it here, or
        attach a ZIP to open it as the project.
      </p>
      <div className="mt-1 flex max-w-[520px] flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            className="rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-mut transition-colors hover:border-[#323945] hover:bg-bg2 hover:text-ink"
            onClick={() => onSuggest(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
