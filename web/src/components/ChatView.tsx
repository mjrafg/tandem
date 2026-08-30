import { ArrowDown, Check, Copy, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Chat, Project } from '@shared/types';
import { selectChat, selectProject, useStore } from '../store';
import { CompactDialog } from './CompactDialog';
import { Composer } from './Composer';
import { ContextBanner, ContextMeter } from './ContextMeter';
import { ExportMenu } from './ExportMenu';
import { GitChip } from './GitChip';
import { ProjectMemoryMenu } from './ProjectMemoryMenu';
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

  useEffect(() => {
    if (chatId && !loaded) void loadChat(chatId);
  }, [chatId, loaded, loadChat]);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

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
    <>
      <TopBar chat={chat} project={project} onCompact={() => setCompactOpen(true)} />
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

      <Composer chat={chat} prefill={prefill} onUsedPrefill={() => setPrefill(undefined)} />
      <CompactDialog chatId={chat.id} open={compactOpen} onClose={() => setCompactOpen(false)} />
    </>
  );
}

function TopBar({ chat, project, onCompact }: { chat: Chat; project: Project; onCompact: () => void }) {
  const usage = useStore((s) => s.usage[chat.id]);
  const [copied, setCopied] = useState(false);
  return (
    <header className="flex h-[50px] shrink-0 items-center justify-between gap-2 border-b border-linesoft px-2 sm:gap-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        <MenuButton />
        <span className="inline-flex max-w-[45vw] shrink-0 items-center gap-1.5 text-[13.5px] font-medium">
          <FolderOpen size={14} className="shrink-0 text-dim" />
          <span className="truncate">{project.name}</span>
        </span>
        <button
          className="group hidden min-w-0 items-center gap-1 sm:flex"
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
        <GitChip projectId={project.id} gitState={chat.gitState} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ContextMeter usage={usage} onCompact={onCompact} />
        <ProjectMemoryMenu projectId={project.id} />
        <ExportMenu chatId={chat.id} />
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
