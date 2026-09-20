import { ArrowUp, Bot, FileArchive, FileCode, FileText, Gauge, Image as ImageIcon, Paperclip, ShieldCheck, ShieldOff, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DIFFICULTIES, DIFFICULTY_LABEL, type AgentProfile, type Chat, type Difficulty } from '@shared/types';
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
  const [reviewOn, setReviewOn] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // each chat starts at the default (Reviewer on); the choice then sticks
  // until changed and applies to whatever message is sent next
  useEffect(() => {
    setReviewOn(true);
  }, [chat.id]);

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
      await send(chat.id, clean, ids.length > 0 ? ids : undefined, reviewOn);
    } catch {
      setText(clean);
      setPending(keep);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[820px] px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-5 sm:pb-4">
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
          dir="auto"
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

        <div className="flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
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
            <button
              className={`btn gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
                reviewOn
                  ? 'bg-reviewer/10 text-reviewer hover:bg-reviewer/[0.17]'
                  : 'text-dim hover:bg-bg3 hover:text-mut'
              }`}
              onClick={() => setReviewOn((v) => !v)}
              title={reviewOn
                ? 'The next request goes through the independent Codex review (click to skip review for the next request)'
                : 'The next request skips the independent review — Builder only (click to re-enable)'}
            >
              {reviewOn ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
              Reviewer {reviewOn ? 'On' : 'Off'}
            </button>
            {/* a Project Chat's Builder is the Director's business; only a standalone chat picks its own */}
            {(!chat.kind || chat.kind === 'chat') && (
              <>
                <AgentPicker chat={chat} />
                <DifficultyPicker chat={chat} />
              </>
            )}
            <span className="hidden px-1 text-[11px] text-dim sm:inline">
              {chat.running
                ? 'Run in progress'
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

/**
 * The chat's difficulty, chosen here for a standalone chat. It is stored on
 * the chat and resolved on the next request, so a change applies without
 * restarting anything; "Default" clears it (role default / the chat's Agent).
 * Project sessions never render the Composer — the Director sets theirs.
 */
function DifficultyPicker({ chat }: { chat: Chat }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const value = chat.difficulty ?? '';
  const pick = async (next: Difficulty | null) => {
    if ((chat.difficulty ?? null) === next) return;
    setBusy(true);
    try {
      await api.setChatDifficulty(chat.id, next);
    } catch (e) {
      toast((e as Error).message || 'Could not change the difficulty.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <label
      className={`btn relative gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
        value ? 'bg-accent/10 text-accent hover:bg-accent/[0.17]' : 'text-dim hover:bg-bg3 hover:text-mut'
      } ${busy ? 'opacity-60' : ''}`}
      title={value
        ? `Difficulty ${DIFFICULTY_LABEL[value as Difficulty]}: the next request uses this tier's Builder and Builder Reviewer (Settings → Roles → Difficulty tiers)`
        : 'Difficulty: none — the next request uses the role defaults. Pick a tier to route it to that tier\'s models.'}
    >
      <Gauge size={13} className="shrink-0" />
      <span className="text-dim">Difficulty</span>
      <span>{value ? DIFFICULTY_LABEL[value as Difficulty] : 'Default'}</span>
      <select
        aria-label="Difficulty"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={value}
        disabled={busy}
        onChange={(e) => void pick((e.target.value || null) as Difficulty | null)}
      >
        <option value="" className="bg-bg1 text-ink">Default (role / Agent)</option>
        {DIFFICULTIES.map((d) => (
          <option key={d} value={d} className="bg-bg1 text-ink">{DIFFICULTY_LABEL[d]}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * The chat's Builder Agent, chosen here for a standalone chat. Choosing one
 * captures that profile's prompt, provider, model and effort for this chat
 * (the same snapshot a Director session runs with); "None" clears it. The
 * Builder's identity should not change under a run, so the picker waits
 * while the agent is working.
 */
function AgentPicker({ chat }: { chat: Chat }) {
  const toast = useStore((s) => s.toast);
  const [agents, setAgents] = useState<AgentProfile[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.agents().then((list) => { if (alive) setAgents(list.filter((a) => a.enabled && !a.archivedAt)); }).catch(() => { if (alive) setAgents([]); });
    return () => { alive = false; };
  }, []);
  const current = chat.agent ?? null;
  const pick = async (next: string | null) => {
    if ((current?.profileId ?? null) === next) return;
    setBusy(true);
    try {
      await api.setChatAgent(chat.id, next);
    } catch (e) {
      toast((e as Error).message || 'Could not change the Builder Agent.', 'error');
    } finally {
      setBusy(false);
    }
  };
  // the current Agent stays selectable even if it has since been disabled or archived
  const options = agents ?? [];
  const missing = current && !options.some((a) => a.id === current.profileId);
  const disabled = busy || chat.running || agents === null;
  return (
    <label
      className={`btn relative gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium transition-colors ${
        current ? 'bg-builder/10 text-builder hover:bg-builder/[0.17]' : 'text-dim hover:bg-bg3 hover:text-mut'
      } ${disabled ? 'opacity-60' : ''}`}
      title={current
        ? `Builder Agent ${current.profileName} — ${current.model} · ${current.effort}, captured when chosen (pick it again after editing the Agent to refresh). ${current.enforceModel ? 'Its model is enforced: a difficulty tier does not override it.' : 'A difficulty tier, when set, still decides the model.'}`
        : 'Builder Agent: none — the Builder runs with the role defaults. Pick an Agent to give this chat its instructions and model.'}
    >
      <Bot size={13} className="shrink-0" />
      <span className="text-dim">Agent</span>
      <span className="max-w-[140px] truncate">{current ? current.profileName : 'None'}</span>
      <select
        aria-label="Builder Agent"
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
        value={current?.profileId ?? ''}
        disabled={disabled}
        onChange={(e) => void pick(e.target.value || null)}
      >
        <option value="" className="bg-bg1 text-ink">None (Builder role defaults)</option>
        {missing && current && <option value={current.profileId} className="bg-bg1 text-ink">{current.profileName} (no longer selectable)</option>}
        {options.map((a) => (
          <option key={a.id} value={a.id} className="bg-bg1 text-ink">{a.name}{a.isDefault ? ' · default' : ''} — {a.model} · {a.effort}</option>
        ))}
      </select>
    </label>
  );
}
