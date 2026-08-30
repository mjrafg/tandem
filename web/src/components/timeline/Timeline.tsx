import { memo } from 'react';
import type { AttachmentMeta, ChatEvent } from '@shared/types';
import { fmtBytes, fmtTime } from '../../lib/format';
import { attachmentIcon } from '../Composer';
import { Markdown } from '../Markdown';
import {
  AiCallRow, BrowserGroupRow, ChangeGroupRow, CheckpointRow, CommandGroupRow, CompactionRow, ErrorRow, FindingsRow, ReadGroupRow, RunMarker, SearchGroupRow, SessionsRow, StatusLine, ToolCallRow,
} from './rows';

type Item =
  | { key: string; type: 'single'; ev: ChatEvent }
  | { key: string; type: 'group'; kind: 'command' | 'file_read' | 'search' | 'file_change' | 'browser'; events: ChatEvent[] };

const GROUPABLE = new Set(['command', 'file_read', 'search', 'file_change', 'browser']);

function buildItems(events: ChatEvent[]): Item[] {
  const items: Item[] = [];
  for (const ev of events) {
    if (ev.kind === 'run') {
      const phase = (ev.payload as any).phase;
      if (phase !== 'stopped' && phase !== 'failed') continue;
      items.push({ key: ev.id, type: 'single', ev });
      continue;
    }
    const last = items[items.length - 1];
    if (GROUPABLE.has(ev.kind)) {
      if (last && last.type === 'group' && last.kind === ev.kind && last.events[0].runId === ev.runId) {
        last.events.push(ev);
      } else {
        items.push({ key: ev.id, type: 'group', kind: ev.kind as 'command' | 'file_read' | 'search' | 'file_change' | 'browser', events: [ev] });
      }
      continue;
    }
    items.push({ key: ev.id, type: 'single', ev });
  }
  return items;
}

export const Timeline = memo(function Timeline({ events }: { events: ChatEvent[] }) {
  const items = buildItems(events);
  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        if (item.type === 'group') {
          switch (item.kind) {
            case 'command': return <CommandGroupRow key={item.key} events={item.events} />;
            case 'file_read': return <ReadGroupRow key={item.key} events={item.events} />;
            case 'search': return <SearchGroupRow key={item.key} events={item.events} />;
            case 'file_change': return <ChangeGroupRow key={item.key} events={item.events} />;
            case 'browser': return <BrowserGroupRow key={item.key} events={item.events} />;
          }
        }
        const ev = (item as Extract<Item, { type: 'single' }>).ev;
        switch (ev.kind) {
          case 'user_message': return <UserMessage key={item.key} ev={ev} />;
          case 'assistant_message': return <AssistantMessage key={item.key} ev={ev} />;
          case 'status': return <StatusLine key={item.key} ev={ev} />;
          case 'ai_call': return <AiCallRow key={item.key} ev={ev} />;
          case 'findings': return <FindingsRow key={item.key} ev={ev} />;
          case 'compaction': return <CompactionRow key={item.key} ev={ev} />;
          case 'checkpoint': return <CheckpointRow key={item.key} ev={ev} />;
          case 'tool_call': return <ToolCallRow key={item.key} ev={ev} />;
          case 'sessions': return <SessionsRow key={item.key} ev={ev} />;
          case 'error': return <ErrorRow key={item.key} ev={ev} />;
          case 'run': return <RunMarker key={item.key} ev={ev} />;
          default: return null;
        }
      })}
    </div>
  );
});

function UserMessage({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as { text: string; attachments?: AttachmentMeta[] };
  return (
    <div className="fade-up group flex justify-end pb-3 pt-6 first:pt-2">
      <div className="relative max-w-[85%] rounded-2xl rounded-br-md border border-[#2a3550]/60 bg-[#1a2233] px-4 py-2.5">
        {p.text && <div dir="auto" className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#dee5f2]">{p.text}</div>}
        {p.attachments && p.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${p.text ? 'mt-2' : ''}`}>
            {p.attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#31406a]/70 bg-[#141b2b] px-2 py-1 text-[12px] text-[#c3cee6]"
                title={a.path}
              >
                <span className="text-[#8ea2d0]">{attachmentIcon(a.name)}</span>
                <span className="max-w-[240px] truncate">{a.name}</span>
                <span className="text-[10.5px] text-[#6d7ea6]">{fmtBytes(a.size)}</span>
              </span>
            ))}
          </div>
        )}
        <span className="pointer-events-none absolute -bottom-4 right-1 text-[10.5px] tabular-nums text-dim opacity-0 transition-opacity group-hover:opacity-100">
          {fmtTime(ev.ts)}
        </span>
      </div>
    </div>
  );
}

function AssistantMessage({ ev }: { ev: ChatEvent }) {
  const p = ev.payload as { text: string; streaming?: boolean };
  return (
    <div className="fade-up group relative px-2 py-2">
      <Markdown text={p.text} />
      {p.streaming && <span className="ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] rounded-[2px] bg-accent/80 pulse-soft" />}
      <span className="pointer-events-none absolute right-1 top-[-2px] text-[10.5px] tabular-nums text-dim opacity-0 transition-opacity group-hover:opacity-100">
        {fmtTime(ev.ts)}
      </span>
    </div>
  );
}
