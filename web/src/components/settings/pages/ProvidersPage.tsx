import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, ExternalLink, Copy, Loader2, LogIn, X, KeyRound, Trash2 } from 'lucide-react';
import type { AuthProvider, LoginState, ProviderStatus, StoredTokenMeta } from '@shared/types';
import { api, ApiError } from '../../../api';
import { useStore } from '../../../store';

/**
 * Signing the provider CLIs in, without an SSH session.
 *
 * The Builder, Reviewer and Director ARE the `claude` and `codex` CLIs, and
 * they use their own logins. When one expires the product stops — so this page
 * drives each CLI's ordinary interactive login from here: it shows the URL the
 * CLI printed, the operator signs in on the provider's own site, and pastes the
 * short code back. Tandem never sees a password and never keeps the code.
 */

const LABEL: Record<AuthProvider, { name: string; role: string }> = {
  claude: { name: 'Claude Code', role: 'Builder and Project Director' },
  codex: { name: 'Codex', role: 'Reviewer' },
};

export function ProvidersPage() {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<ProviderStatus[]>([]);
  const [logins, setLogins] = useState<Partial<Record<AuthProvider, LoginState>>>({});
  const [tokens, setTokens] = useState<StoredTokenMeta[]>([]);
  const [busy, setBusy] = useState<AuthProvider | null>(null);
  const [codes, setCodes] = useState<Partial<Record<AuthProvider, string>>>({});
  const [submitted, setSubmitted] = useState<Partial<Record<AuthProvider, string>>>({});
  const [loaded, setLoaded] = useState(false);
  const polling = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.providerAuth();
      setStatus(r.providers);
      setLogins(Object.fromEntries(r.logins.map((l) => [l.provider, l])));
      setTokens(r.tokens ?? []);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read the sign-in status.');
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  // poll only while a sign-in is actually in flight
  const active = Object.values(logins).some((l) => l && (l.phase === 'running' || l.phase === 'awaiting_code'));
  useEffect(() => {
    if (!active) { if (polling.current) { window.clearInterval(polling.current); polling.current = null; } return; }
    polling.current = window.setInterval(() => { void refresh(); }, 2000);
    return () => { if (polling.current) window.clearInterval(polling.current); polling.current = null; };
  }, [active, refresh]);

  const start = async (p: AuthProvider, kind: 'login' | 'mint' = 'login') => {
    setBusy(p);
    try {
      const st = await api.startProviderLogin(p, kind);
      setLogins((prev) => ({ ...prev, [p]: st }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the sign-in.');
    } finally { setBusy(null); }
  };

  const sendCode = async (p: AuthProvider) => {
    const code = (codes[p] ?? '').trim();
    if (!code) return;
    setBusy(p);
    try {
      const st = await api.submitProviderCode(p, code);
      setLogins((prev) => ({ ...prev, [p]: st }));
      setCodes((prev) => ({ ...prev, [p]: '' }));
      setSubmitted((prev) => ({ ...prev, [p]: new Date().toLocaleTimeString() }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The CLI would not take that code.');
    } finally { setBusy(null); }
  };

  const cancel = async (p: AuthProvider) => {
    try { await api.cancelProviderLogin(p); } catch { /* it is going away either way */ }
    setLogins((prev) => { const next = { ...prev }; delete next[p]; return next; });
    void refresh();
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-[19px] font-medium">Provider sign-in</h1>
        <p className="max-w-[70ch] text-[13.5px] leading-relaxed text-dim">
          Tandem does not hold these credentials — the Claude and Codex command-line tools keep their own,
          and every Builder, Reviewer and Director call uses them. When one expires, work stops until it is
          renewed. Sign in here instead of opening a terminal on the server. You authenticate on the
          provider&rsquo;s own site; Tandem only passes the code along and never stores it.
        </p>
      </header>

      {!loaded && <div className="text-[13px] text-dim">Checking…</div>}

      {loaded && (['claude', 'codex'] as AuthProvider[]).map((p) => {
        const st = status.find((s) => s.provider === p);
        const login = logins[p];
        const inFlight = login && (login.phase === 'running' || login.phase === 'awaiting_code');
        return (
          <section key={p} className="rounded-xl border border-line bg-[#141414] p-4">
            <div className="flex flex-wrap items-center gap-3">
              {st?.loggedIn
                ? <CheckCircle2 size={17} className="shrink-0 text-ok" aria-hidden />
                : <XCircle size={17} className="shrink-0 text-err" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-medium">{LABEL[p].name}</div>
                <div className="text-[12.5px] text-dim">
                  {LABEL[p].role} · {st ? st.detail : 'status unknown'}
                </div>
              </div>
              {!inFlight && (
                <button
                  onClick={() => void start(p)}
                  disabled={busy === p}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-[#1b1b1b] px-3 py-1.5 text-[13px] hover:bg-[#222] disabled:opacity-50"
                >
                  {busy === p ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                  {st?.loggedIn ? 'Sign in again' : 'Sign in'}
                </button>
              )}
              {inFlight && (
                <button
                  onClick={() => void cancel(p)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[13px] text-dim hover:bg-[#222]"
                >
                  <X size={14} /> Cancel
                </button>
              )}
            </div>

            {p === 'claude' && !inFlight && (() => {
              const tok = tokens.find((t) => t.provider === 'claude');
              const days = tok?.expiresAt ? Math.round((tok.expiresAt - Date.now()) / 86_400_000) : null;
              return (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-[#111] px-3 py-2.5">
                  <KeyRound size={15} className="shrink-0 text-dim" aria-hidden />
                  <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-dim">
                    {tok
                      ? <>A one-year token is stored and authenticates every call. It lapses in about {days} day{days === 1 ? '' : 's'}. Tandem keeps it encrypted and never shows it.</>
                      : <>The sign-in above lasts about four weeks. A one-year token avoids that, at the cost of Tandem holding the credential — encrypted, never displayed.</>}
                  </div>
                  <button
                    onClick={() => void start('claude', 'mint')}
                    disabled={busy === p}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] hover:bg-[#222] disabled:opacity-50"
                  >
                    {tok ? 'Replace token' : 'Create one-year token'}
                  </button>
                  {tok && (
                    <button
                      onClick={async () => { await api.forgetProviderToken('claude'); toast('Token removed.'); void refresh(); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-dim hover:bg-[#222]"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </div>
              );
            })()}

            {st?.loggedIn && !inFlight && p === 'codex' && (
              <p className="mt-2.5 text-[12.5px] text-dim">
                Signing in again replaces the session this CLI is using right now.
              </p>
            )}

            {login && (
              <div className="mt-4 space-y-3 border-t border-line pt-3.5">
                {login.url && (
                  <div className="space-y-1.5">
                    <div className="text-[12.5px] text-dim">
                      {login.kind === 'mint'
                        ? 'Open this link and approve, then paste the code back. The token it produces is stored encrypted and never shown.'
                        : 'Open this link, sign in to your own account, then paste the code it gives you.'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={login.url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-acc/15 px-3 py-1.5 text-[13px] text-acc hover:bg-acc/25"
                      >
                        <ExternalLink size={14} /> Open the sign-in page
                      </a>
                      <button
                        onClick={() => { void navigator.clipboard?.writeText(login.url ?? ''); toast('Link copied.'); }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] text-dim hover:bg-[#222]"
                      >
                        <Copy size={13} /> Copy link
                      </button>
                    </div>
                  </div>
                )}

                {(login.phase === 'awaiting_code' || (login.phase === 'running' && login.url)) && (
                  <form
                    onSubmit={(e) => { e.preventDefault(); void sendCode(p); }}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <input
                      value={codes[p] ?? ''}
                      onChange={(e) => setCodes((prev) => ({ ...prev, [p]: e.target.value }))}
                      placeholder="Paste the code from the sign-in page"
                      autoComplete="off" spellCheck={false} dir="ltr"
                      className="min-w-[16rem] flex-1 rounded-lg border border-line bg-[#111] px-3 py-1.5 font-mono text-[12.5px] outline-none focus:border-acc/60"
                    />
                    <button
                      type="submit"
                      disabled={busy === p || !(codes[p] ?? '').trim()}
                      className="rounded-lg bg-acc/15 px-3 py-1.5 text-[13px] text-acc hover:bg-acc/25 disabled:opacity-40"
                    >
                      Submit code
                    </button>
                  </form>
                )}

                {login.notice && (
                  <div className="rounded-lg border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[13px] text-warn">
                    {login.notice}
                  </div>
                )}
                {submitted[p] && !login.notice && login.phase !== 'done' && (
                  <div className="text-[12.5px] text-dim">Code sent to the CLI at {submitted[p]}.</div>
                )}
                {login.phase === 'running' && login.url && !login.notice && (
                  <div className="flex items-center gap-2 text-[13px] text-dim">
                    <Loader2 size={14} className="animate-spin" /> Waiting for the provider to confirm the code…
                  </div>
                )}
                {login.phase === 'running' && !login.url && (
                  <div className="flex items-center gap-2 text-[13px] text-dim">
                    <Loader2 size={14} className="animate-spin" /> Starting the sign-in…
                  </div>
                )}
                {login.phase === 'done' && (
                  <div className="text-[13px] text-ok">
                    {login.kind === 'mint'
                      ? 'One-year token saved. Every Claude call now uses it.'
                      : 'Signed in. New runs will use this session.'}
                  </div>
                )}
                {login.phase === 'failed' && (
                  <div className="text-[13px] text-err">{login.error ?? 'The sign-in did not complete.'}</div>
                )}

                {login.output && (
                  <details className="text-[12.5px]">
                    <summary className="cursor-pointer text-dim">What the CLI is showing</summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0e0e0e] p-2.5 font-mono text-[11.5px] leading-relaxed text-dim">
                      {login.output}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
