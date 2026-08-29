import { ArrowUp, FileArchive, FileCode, FileText, Image as ImageIcon, Paperclip, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Chat } from '@shared/types';
import { api } from '../api';
import { fmtBytes } from '../lib/format';
import { useStore } from '../store';
import { Spinner } from './ui';

interface PendingAttachment {
  key: string;
  id?: string; // set once uploaded
  name: string;
  size: number;
  uploading: boolean;
  error?: boolean;
}

export function attachmentIcon(name: string, size = 13) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return <FileArchive size={size} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <ImageIcon size={size} />;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'rb', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'yml', 'yaml', 'sql', 'sh'].includes(ext)) return <FileCode size={size} />;
  return <FileText size={size} />;
}

export function Composer({ chat, prefill, onUsedPrefill }: { chat: Chat; prefill?: string; onUsedPrefill?: () => void }) {
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onUsedPrefill?.();
      ref.current?.focus();
    }
  }, [prefill, onUsedPrefill]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (!chat.running) ref.current?.focus();
  }, [chat.id, chat.running]);

  function addFiles(files: FileList | File[]) {
    const list = [...files].slice(0, 8 - pending.length);
    for (const file of list) {
      if (file.size > 200 * 1024 * 1024) {
        toast(`${file.name} is over the 200 MB limit`, 'error');
        continue;
      }
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setPending((p) => [...p, { key, name: file.name, size: file.size, uploading: true }]);
      api.uploadAttachment(chat.id, file)
        .then((meta) => {
          setPending((p) => p.map((a) => (a.key === key ? { ...a, id: meta.id, uploading: false } : a)));
        })
        .catch((err) => {
          toast(err instanceof Error ? err.message : `Upload of ${file.name} failed`, 'error');
          setPending((p) => p.filter((a) => a.key !== key));
        });
    }
  }

  function removeAttachment(a: PendingAttachment) {
    setPending((p) => p.filter((x) => x.key !== a.key));
    if (a.id) void api.deleteAttachment(a.id).catch(() => undefined);
  }

  const uploading = pending.some((a) => a.uploading);
  const canSend = (text.trim().length > 0 || pending.some((a) => a.id)) && !uploading && !chat.running;

  async function submit() {
    if (!canSend) return;
    const clean = text.trim();
    const ids = pending.filter((a) => a.id).map((a) => a.id!) as string[];
    const keep = pending;
    setText('');
    setPending([]);
    try {
      await send(chat.id, clean, ids.length > 0 ? ids : undefined);
    } catch {
      setText(clean);
      setPending(keep);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[820px] px-5 pb-4">
      <div
        className={`rounded-2xl border bg-bg1 shadow-lg shadow-black/25 transition-colors ${
          dragOver ? 'border-accent bg-accent/[0.04]' : 'border-line focus-within:border-[#39414e]'
        }`}
        onDragOver={(e) => {
          if (chat.running) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!chat.running && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {pending.map((a) => (
              <span
                key={a.key}
                className="fade-up inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg2 py-1 pl-2 pr-1 text-[12px] text-mut"
              >
                <span className="text-dim">{a.uploading ? <Spinner size={12} /> : attachmentIcon(a.name)}</span>
                <span className="max-w-[220px] truncate text-ink">{a.name}</span>
                <span className="text-[10.5px] text-dim">{fmtBytes(a.size)}</span>
                <button
                  className="rounded p-0.5 text-dim transition-colors hover:bg-bg3 hover:text-ink"
                  onClick={() => removeAttachment(a)}
                  aria-label={`Remove ${a.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={chat.running}
          placeholder={
            chat.running
              ? 'Agent is working — stop it to send a new message'
              : dragOver
                ? 'Drop files to attach'
                : 'Ask anything, attach files, or describe what to build…'
          }
          className="no-ring block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-dim disabled:opacity-60"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost -ml-0.5 px-1.5 py-1.5"
              title="Attach files (ZIP archives open as projects)"
              disabled={chat.running || pending.length >= 8}
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip size={15} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.currentTarget.value = '';
              }}
            />
            <span className="px-1 text-[11px] text-dim">
              {chat.running
                ? 'Builder → Reviewer run in progress'
                : uploading
                  ? 'Uploading…'
                  : 'Enter to send · Shift+Enter for a new line'}
            </span>
          </div>
          {chat.running ? (
            <button
              className="btn rounded-lg bg-err/15 px-2.5 py-1.5 text-err transition-colors hover:bg-err/25"
              onClick={() => void stop(chat.id)}
              title="Stop the agent"
            >
              <Square size={13} fill="currentColor" />
              Stop
            </button>
          ) : (
            <button
              className="btn rounded-lg bg-accent p-2 text-[#0a1020] transition-all hover:brightness-110 disabled:opacity-30"
              onClick={() => void submit()}
              disabled={!canSend}
              title="Send"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
