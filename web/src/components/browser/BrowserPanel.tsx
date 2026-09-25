import {
  ArrowLeft, ArrowRight, Globe, Hand, Maximize2, Minimize2, MousePointerClick, RotateCw, ScanEye, SendHorizontal, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserInputAction, BrowserLiveFrame, BrowserLiveState, Chat } from '@shared/types';
import { api } from '../../api';
import { Spinner } from '../ui';

export type LiveRole = 'builder' | 'reviewer';

const ROLE_LABEL: Record<LiveRole, string> = { builder: 'Builder', reviewer: 'Reviewer' };

/** keys sent by name; anything else of length 1 is typed as text */
const NAMED: Record<string, string> = {
  Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', ' ': 'Space',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
};

/**
 * The Builder's or the Reviewer's browser, live: the real page their Chromium
 * is showing, as it changes. Watching changes nothing. "Take control" sends
 * clicks, scrolling and typing to that browser, queued behind whatever the
 * agent is doing, and the agent is told on its next step.
 */
export function BrowserPanel({ chat, open, role, onRole, onClose }: {
  chat: Chat; open: boolean; role: LiveRole; onRole: (r: LiveRole) => void; onClose: () => void;
}) {
  const [state, setState] = useState<BrowserLiveState | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [control, setControl] = useState(false);
  const [fit, setFit] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [typed, setTyped] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const urlFocused = useRef(false);

  // ---- the stream: state + frames for this chat and role
  useEffect(() => {
    if (!open) return;
    setState(null); setHasFrame(false); setConnected(false); setError(null);
    const es = new EventSource(`/api/chats/${chat.id}/browser/live?role=${role}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource reconnects on its own
    es.addEventListener('state', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as BrowserLiveState;
      setState(s);
      if (!s.running) setHasFrame(false);
      if (!urlFocused.current) setUrl(s.url === 'about:blank' ? '' : s.url);
    });
    es.addEventListener('frame', (e) => {
      const f = JSON.parse((e as MessageEvent).data) as BrowserLiveFrame;
      size.current = { w: f.width, h: f.height };
      // straight to the element: a frame must not re-render the panel
      if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${f.data}`;
      setHasFrame(true);
    });
    return () => es.close();
  }, [open, chat.id, role]);

  // control is per browser: switching role or closing hands it back
  useEffect(() => { setControl(false); }, [role, open, chat.id]);

  const send = useCallback(async (action: BrowserInputAction, body: Record<string, unknown> = {}) => {
    setPending((n) => n + 1);
    setError(null);
    try {
      await api.browserInput(chat.id, { role, action, ...body });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setPending((n) => n - 1);
    }
  }, [chat.id, role]);

  /** where on the page a point on the picture is, in the page's CSS pixels */
  const toPage = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img || !size.current.w) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.round(((clientX - r.left) / r.width) * size.current.w),
      y: Math.round(((clientY - r.top) / r.height) * size.current.h),
      scale: size.current.h / r.height,
    };
  }, []);

  // ---- pointer: a tap clicks; a drag (touch) or the wheel scrolls
  const drag = useRef<{ x: number; y: number; lastY: number; lastX: number; moved: boolean; id: number } | null>(null);
  const wheel = useRef({ dx: 0, dy: 0, x: 0, y: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> | 0 });
  const queueWheel = useCallback((clientX: number, clientY: number, dx: number, dy: number) => {
    const p = toPage(clientX, clientY);
    if (!p) return;
    const w = wheel.current;
    w.dx += dx * p.scale; w.dy += dy * p.scale; w.x = p.x; w.y = p.y;
    if (w.timer) return;
    w.timer = setTimeout(() => {
      const { dx: ddx, dy: ddy, x, y } = wheel.current;
      wheel.current = { dx: 0, dy: 0, x: 0, y: 0, timer: 0 };
      if (Math.abs(ddx) + Math.abs(ddy) >= 1) void send('wheel', { x, y, dx: Math.round(ddx), dy: Math.round(ddy) });
    }, 140);
  }, [send, toPage]);

  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !control) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); queueWheel(e.clientX, e.clientY, e.deltaX, e.deltaY); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [control, queueWheel]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!control) return;
    drag.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, id: e.pointerId };
    stageRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!control || !d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) d.moved = true;
    if (d.moved && e.pointerType !== 'mouse') {
      // dragging a finger up scrolls the page down, as on any phone
      queueWheel(e.clientX, e.clientY, d.lastX - e.clientX, d.lastY - e.clientY);
      d.lastX = e.clientX; d.lastY = e.clientY;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!control || !d || d.moved) return;
    const p = toPage(e.clientX, e.clientY);
    if (p) void send('click', { x: p.x, y: p.y });
  };

  // ---- keyboard (desktop): printable keys are batched into text
  const textBuf = useRef({ text: '', timer: 0 as unknown as ReturnType<typeof setTimeout> | 0 });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!control || e.metaKey || e.ctrlKey || e.altKey) return;
    const named = NAMED[e.key];
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      const b = textBuf.current;
      b.text += e.key;
      if (!b.timer) {
        b.timer = setTimeout(() => {
          const t = textBuf.current.text;
          textBuf.current = { text: '', timer: 0 };
          if (t) void send('text', { text: t });
        }, 160);
      }
    } else if (named) {
      e.preventDefault();
      void send('key', { key: named });
    }
  };

  if (!open) return null;
  const running = !!state?.running;
  const who = ROLE_LABEL[role];
  // expanded, it leaves its dock and fills the window
  const panelCls = expanded ? 'fixed inset-0 z-50' : 'min-h-0 flex-1';

  return (
    <div className={`${panelCls} flex flex-col bg-bg1`}>
        <div className="flex items-center gap-2 border-b border-linesoft px-3 py-2">
          <Globe size={15} className="shrink-0 text-dim" />
          <span className="text-[13.5px] font-semibold">Browser</span>
          <div className="ml-1 flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Whose browser">
            {(['builder', 'reviewer'] as const).map((r) => (
              <button
                key={r} role="tab" aria-selected={role === r}
                className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${role === r ? (r === 'builder' ? 'bg-builder/15 text-ink' : 'bg-reviewer/15 text-ink') : 'text-dim hover:text-mut'}`}
                onClick={() => onRole(r)}
              >
                <span className={`mr-1.5 inline-block h-[6px] w-[6px] rounded-full ${r === 'builder' ? 'bg-builder' : 'bg-reviewer'}`} />
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center">
            <button className="btn-ghost hidden px-2 py-1.5 sm:inline-flex" onClick={() => setExpanded((x) => !x)} title={expanded ? 'Back to the side' : 'Fill the window'} aria-label={expanded ? 'Back to the side' : 'Fill the window'}>
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="btn-ghost -mr-1 px-2 py-1.5" onClick={onClose} aria-label="Close browser panel"><X size={15} /></button>
          </div>
        </div>

        <form
          className="flex items-center gap-1 border-b border-linesoft px-2 py-1.5"
          onSubmit={(e) => { e.preventDefault(); if (url.trim()) void send('navigate', { url: url.trim() }); (document.activeElement as HTMLElement | null)?.blur(); }}
        >
          <button type="button" className="btn-ghost px-1.5 py-1.5" disabled={!running} onClick={() => void send('back')} aria-label="Back"><ArrowLeft size={14} /></button>
          <button type="button" className="btn-ghost px-1.5 py-1.5" disabled={!running} onClick={() => void send('forward')} aria-label="Forward"><ArrowRight size={14} /></button>
          <button type="button" className="btn-ghost px-1.5 py-1.5" disabled={!running} onClick={() => void send('reload')} aria-label="Reload"><RotateCw size={13} /></button>
          <input
            className="input mono min-w-0 flex-1 py-1 text-[12.5px]"
            placeholder={running ? 'Address' : 'Open an address'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onFocus={() => { urlFocused.current = true; }}
            onBlur={() => { urlFocused.current = false; }}
            inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-label="Address"
          />
        </form>

        <div className="flex min-h-[34px] items-center gap-2 border-b border-linesoft px-3 py-1.5 text-[12px]">
          {!connected ? (
            <span className="inline-flex items-center gap-1.5 text-dim"><Spinner size={11} /> Connecting…</span>
          ) : state?.busy ? (
            <span className="inline-flex items-center gap-1.5 text-accent"><span className="h-[7px] w-[7px] animate-pulse rounded-full bg-accent" /> {who} is acting…</span>
          ) : running ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-dim">
              <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-ok" />
              <span className="min-w-0 truncate">Live{state?.title ? ` · ${state.title}` : ''}</span>
            </span>
          ) : (
            <span className="text-dim">No browser open</span>
          )}
          {pending > 0 && <span className="inline-flex items-center gap-1 text-dim"><Spinner size={11} /> sending</span>}
          {running && hasFrame && (
            <div className="ml-auto flex items-center gap-1">
              <button className={`btn-ghost px-2 py-1 text-[12px] ${fit ? '' : 'text-accent'}`} onClick={() => setFit((f) => !f)} title={fit ? 'Show at actual size' : 'Fit to the panel'}>
                <ScanEye size={13} /> {fit ? 'Fit' : '100%'}
              </button>
              <button
                className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${control ? 'border-warn/40 bg-warn/15 text-warn' : 'border-line text-mut hover:bg-bg2 hover:text-ink'}`}
                onClick={() => setControl((c) => !c)}
                aria-pressed={control}
              >
                {control ? <><Hand size={12} className="mr-1 inline" />In control</> : <><MousePointerClick size={12} className="mr-1 inline" />Take control</>}
              </button>
            </div>
          )}
        </div>

        {control && (
          <p className="border-b border-warn/20 bg-warn/10 px-3 py-1.5 text-[11.5px] leading-snug text-warn">
            Your taps, scrolling and typing go to the {who}&apos;s browser, after anything it is doing. The {who} is told on its next step.
          </p>
        )}
        {error && <p className="border-b border-err/25 bg-err/10 px-3 py-1.5 text-[12px] text-[#ffb3ae]">{error}</p>}

        <div
          ref={stageRef}
          tabIndex={control ? 0 : -1}
          onKeyDown={onKeyDown}
          className={`relative min-h-0 flex-1 bg-[#0b0c0e] outline-none ${fit ? 'overflow-y-auto' : 'overflow-auto'} ${control ? 'cursor-pointer focus:ring-1 focus:ring-inset focus:ring-warn/40' : ''}`}
        >
          <img
            ref={imgRef}
            alt={running ? `The ${who}'s browser` : ''}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; }}
            style={fit ? undefined : { width: size.current.w || undefined, maxWidth: 'none' }}
            className={`${running && hasFrame ? 'block' : 'hidden'} ${fit ? 'w-full' : ''} h-auto select-none ${control ? 'touch-none' : ''}`}
          />
          {!(running && hasFrame) && (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 px-6 text-center">
              {!connected || (running && !hasFrame) ? <Spinner size={18} /> : (
                <>
                  <Globe size={26} className="text-dim" />
                  <p className="max-w-[340px] text-[13px] leading-relaxed text-mut">
                    The {who} has no browser open in this chat. One opens when the {who} uses a browser tool, and this view shows it live.
                  </p>
                  <button className="btn-outline px-3 py-1.5 text-[12.5px]" disabled={pending > 0} onClick={() => void send('start')}>
                    Open the {who}&apos;s browser
                  </button>
                  <p className="max-w-[340px] text-[11.5px] text-dim">It reopens the last page it was on, with its sign-ins.</p>
                </>
              )}
            </div>
          )}
        </div>

        {control && running && (
          <form
            className="flex items-center gap-1.5 border-t border-linesoft px-2 py-2"
            onSubmit={(e) => { e.preventDefault(); if (typed) { void send('text', { text: typed }); setTyped(''); } }}
          >
            <input
              className="input min-w-0 flex-1 py-1.5 text-[13px]"
              placeholder="Type into the focused field"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              aria-label="Text to type into the page"
            />
            <button type="submit" className="btn-ghost px-2 py-1.5" disabled={!typed} aria-label="Type it"><SendHorizontal size={14} /></button>
            {(['Enter', 'Backspace', 'Tab'] as const).map((k) => (
              <button key={k} type="button" className="btn-outline px-2 py-1 text-[11.5px]" onClick={() => void send('key', { key: k })}>
                {k === 'Backspace' ? '⌫' : k}
              </button>
            ))}
          </form>
        )}
    </div>
  );
}
