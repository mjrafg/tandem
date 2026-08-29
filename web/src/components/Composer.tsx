import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Chat } from '@shared/types';
import { useStore } from '../store';

export function Composer({ chat, prefill, onUsedPrefill }: { chat: Chat; prefill?: string; onUsedPrefill?: () => void }) {
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

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

  // focus when switching chats / when a run ends
  useEffect(() => {
    if (!chat.running) ref.current?.focus();
  }, [chat.id, chat.running]);

  async function submit() {
    const clean = text.trim();
    if (!clean || chat.running) return;
    setText('');
    try {
      await send(chat.id, clean);
    } catch {
      setText(clean); // restore on failure
    }
  }

  return (
    <div className="mx-auto w-full max-w-[820px] px-5 pb-4">
      <div className="rounded-2xl border border-line bg-bg1 shadow-lg shadow-black/25 transition-colors focus-within:border-[#39414e]">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={chat.running}
          placeholder={chat.running ? 'Agent is working — stop it to send a new message' : 'Ask anything, or describe what to build…'}
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-dim disabled:opacity-60"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <span className="px-1 text-[11px] text-dim">
            {chat.running ? 'Builder → Reviewer run in progress' : 'Enter to send · Shift+Enter for a new line'}
          </span>
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
              disabled={!text.trim()}
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
