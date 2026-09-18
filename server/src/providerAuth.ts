/**
 * Signing the provider CLIs in from the web app.
 *
 * Tandem's Builder, Reviewer and Director are the `claude` and `codex` CLIs,
 * and they authenticate with their OWN credential stores under the service
 * user's home — not with anything Tandem holds. When one of those logins
 * expires the whole product stops: on 2026-09-18 every Director turn failed
 * with "OAuth session expired and could not be refreshed", and the only way to
 * fix it was an SSH session and an interactive terminal. That is the gap this
 * closes.
 *
 * How it works. Both CLIs refuse to start an interactive login without a
 * terminal — with stdin from /dev/null the CLI prints nothing and exits 0 — so
 * the login runs under a PTY borrowed from `script(1)`, which is
 * already on the host and costs no new dependency. The CLI prints an
 * authorization URL; the operator opens it in their own browser, signs in to
 * their own account, and pastes back the short code the provider shows them.
 *
 * What Tandem does NOT do: it never sees a password, never stores the pasted
 * code (it goes straight to the child's stdin and is not logged, evented or
 * written to disk), and never reads the credential file the CLI writes. The
 * output shown in the browser is scrubbed of anything token-shaped first, so a
 * credential a CLI decides to print cannot reach a browser or a log.
 *
 * A login is deliberately in-memory and short-lived. If the server restarts
 * mid-flow the flow is simply gone and the operator starts again; nothing about
 * a half-finished login is worth making durable.
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { config } from './config';
import { db } from './db';
import { decryptSecret, encryptSecret } from './integrations/store';

export type AuthProvider = 'claude' | 'codex';


export interface LoginState {
  provider: AuthProvider;
  /** running = working; awaiting_code = the operator must paste a code; done/failed = terminal */
  phase: 'running' | 'awaiting_code' | 'done' | 'failed';
  /** the URL to open, once the CLI has printed one */
  url: string | null;
  /** scrubbed tail of the CLI's output, for the operator to see what it is doing */
  output: string;
  /** the CLI's own most recent message to the operator, e.g. a rejected code */
  notice?: string;
  startedAt: number;
  error?: string;
}

interface Session extends LoginState {
  child: ChildProcess;
  raw: string;
  timer: NodeJS.Timeout;
  /** we have already pressed Enter for the rejection currently on screen */
  dismissed: boolean;
}

/** a login that has not finished in this long is abandoned */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** how much scrubbed output the UI is shown */
const OUTPUT_TAIL = 4_000;

const sessions = new Map<AuthProvider, Session>();

// ------------------------------------------------------------------ scrubbing

/**
 * Remove terminal control noise, then anything that could be a credential.
 *
 * The URL is kept — it is what the operator needs and it is not a secret on its
 * own (it is a PKCE authorize link). Long opaque strings that are NOT part of a
 * URL are replaced, so a token a CLI decides to print never reaches a browser,
 * a log or an event.
 */
/** the escape character, named so no editor or copy-paste can silently eat it */
const ESC = String.fromCharCode(27);

export function scrubCliOutput(text: string): string {
  const plain = text
    // OSC 8 hyperlinks (the CLI wraps the URL in one, repeatedly) and other OSC
    .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, 'g'), '')
    // Cursor-column moves are how this CLI lays words out: it prints "Welcome",
    // jumps to column 9, prints "to". Deleting them outright would run the words
    // together, so they become the space the reader expects.
    .replace(new RegExp(`${ESC}\\[[0-9]+G`, 'g'), ' ')
    // every other CSI, charset selection and two-character escape
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}[()][A-Z0-9]`, 'g'), '')
    .replace(new RegExp(`${ESC}[=>78]`, 'g'), '')
    // every remaining control character except tab and newline
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]{2,}/g, ' ');

  return plain
    // provider API keys and tokens, whatever the CLI decides to print
    .replace(/\b(?:sk|sk-ant|sk-proj|oat|rt)[-_][A-Za-z0-9._-]{12,}/gi, '\u00ABredacted\u00BB')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '\u00ABredacted\u00BB')
    // any other long opaque run that is not part of a URL
    .split('\n')
    .map((line) => (/https?:\/\//.test(line) ? line : line.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '\u00ABredacted\u00BB')))
    .join('\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l.trim() !== '' || (all[i - 1] ?? '').trim() !== '')
    .join('\n');
}

/** the authorization URL the CLI wants opened, if it has printed one yet */
export function findUrl(text: string): string | null {
  // The CLI repeats the URL: once as the OSC-8 hyperlink payload (complete) and
  // again as visible text the terminal wrapped (truncated). Take the LONGEST
  // match, which is the hyperlink payload.
  //
  // Control characters must terminate the match. The hyperlink payload ends in
  // a BEL, and without excluding it the match ran straight through into the
  // wrapped copy and produced a longer, corrupt "URL" that the operator would
  // have been handed as a link.
  const matches = text.match(/https?:\/\/[^\s"'<>\\\u0000-\u001F]+/g);
  if (!matches) return null;
  const auth = matches.filter((u) => /oauth|auth|login|device|activate/i.test(u));
  const pool = auth.length > 0 ? auth : matches;
  return pool.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** has the CLI asked for the code the provider showed the operator? */
function wantsCode(text: string): boolean {
  return /paste[^\n]*code|enter[^\n]*code|code here|authorization code/i.test(text);
}

// ------------------------------------------------------------------ the flow

/**
 * `claude auth login`, NOT `claude setup-token`.
 *
 * They look alike — both open the same OAuth page and both ask for a pasted
 * code — but setup-token MINTS A TOKEN AND PRINTS IT for you to put in
 * CLAUDE_CODE_OAUTH_TOKEN. It never signs the CLI in: the credentials file is
 * untouched and `claude auth status` still reports logged out afterwards. It
 * also asks for one scope (user:inference) where the real sign-in asks for
 * six. Built on setup-token this page could not have worked, and the scrubber
 * that protects the browser from a printed credential destroyed the only thing
 * it produced. `auth login` persists the session the Builder and Director use.
 */
function loginCommand(provider: AuthProvider): string {
  return provider === 'claude'
    ? `${config.claudeBin} auth login --claudeai`
    : `${config.codexBin} login --device-auth`;
}

/**
 * `script(1)` is the PTY, and its flags differ by platform: util-linux takes
 * `-qec CMD FILE`, BSD/macOS takes `-q FILE CMD...`. Production is Linux;
 * getting the macOS form right is what makes this testable on a developer
 * machine instead of only after a deploy.
 */
function ptyArgs(provider: AuthProvider): string[] {
  const cmd = loginCommand(provider);
  return process.platform === 'linux'
    ? ['-qec', cmd, '/dev/null']
    : ['-q', '/dev/null', 'sh', '-c', cmd];
}

export function getLogin(provider: AuthProvider): LoginState | null {
  const s = sessions.get(provider);
  if (!s) return null;
  const { provider: p, phase, url, output, notice, startedAt, error } = s;
  return { provider: p, phase, url, output, notice, startedAt, error };
}

export function startLogin(provider: AuthProvider): LoginState {
  cancelLogin(provider);
  const child = spawn('script', ptyArgs(provider), {
    cwd: config.dataDir,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session: Session = {
    provider, phase: 'running', url: null, output: '', startedAt: Date.now(),
    child, raw: '', dismissed: false,
    timer: setTimeout(() => finish(provider, 'failed', 'The sign-in did not finish within 10 minutes.'), LOGIN_TIMEOUT_MS),
  };
  sessions.set(provider, session);

  const absorb = (chunk: Buffer | string) => {
    session.raw = (session.raw + String(chunk)).slice(-40_000);
    session.output = scrubCliOutput(session.raw).slice(-OUTPUT_TAIL);
    // Track the CURRENT url, not just the first one: a rejected code makes the
    // CLI start a fresh authorization with a new challenge, and the operator
    // must be handed that new link rather than the dead one.
    const seen = findUrl(session.raw);
    if (seen && seen !== session.url) { session.url = seen; session.dismissed = false; }
    if (session.phase === 'running' && session.url && wantsCode(session.output)) session.phase = 'awaiting_code';

    // Surface the CLI's own verdict. Without this a rejected code looks like
    // nothing happening at all, which is exactly how it felt.
    const said = /(OAuth error:[^\n]*|Invalid code[^\n]*|Expired[^\n]*code[^\n]*)/i.exec(session.output);
    if (said) {
      session.notice = said[1].replace(/\s+/g, ' ').trim();
      session.phase = 'awaiting_code';
    }
    // "Press Enter to retry" is not a prompt to resend the same code — pressing
    // Enter restarts the whole authorization and prints a NEW url. Press it once
    // so the fresh link appears, then let the operator sign in again.
    if (!session.dismissed && /press enter to retry/i.test(session.output.slice(-400))) {
      session.dismissed = true;
      try { session.child.stdin?.write('\r'); } catch { /* the child is going away */ }
    }
  };
  child.stdout?.on('data', absorb);
  child.stderr?.on('data', absorb);
  child.on('error', (err) => finish(provider, 'failed', `The sign-in helper could not start: ${String(err)}`));
  child.on('close', (code) => {
    // the CLI is the authority on whether the login took: ask it separately
    // rather than guessing from an exit code produced under a PTY wrapper
    void checkStatus(provider).then((st) => {
      // BSD `script` cannot allocate a PTY when its own stdin is a pipe, which
      // is every server process. Production is Linux and unaffected; say so
      // rather than leaving a developer staring at an ioctl error.
      const noPty = /tcgetattr|ioctl|not a tty|illegal option/i.test(sessions.get(provider)?.output ?? '');
      finish(provider, st.loggedIn ? 'done' : 'failed', st.loggedIn ? undefined
        : noPty
          ? 'This host\'s `script` could not open a terminal for the CLI, so the sign-in never started. '
            + 'Provider sign-in works on the Linux server; it does not work from a macOS development machine.'
          : `The sign-in did not complete (the CLI exited with code ${code ?? 'unknown'}).`);
    });
  });
  return getLogin(provider)!;
}

function finish(provider: AuthProvider, phase: 'done' | 'failed', error?: string): void {
  const s = sessions.get(provider);
  if (!s || s.phase === 'done' || s.phase === 'failed') return;
  clearTimeout(s.timer);
  s.phase = phase;
  if (error) s.error = error;
  try { if (s.child.exitCode === null) s.child.kill('SIGTERM'); } catch { /* already gone */ }
}

/**
 * Hand the provider's code to the waiting CLI.
 *
 * The code is written to the child's stdin and is deliberately not returned,
 * logged, evented or stored anywhere. It is the operator's own short-lived
 * authorization code, and Tandem is only the pipe.
 */
export function submitCode(provider: AuthProvider, code: string): { ok: boolean; error?: string } {
  const s = sessions.get(provider);
  if (!s) return { ok: false, error: 'No sign-in is in progress.' };
  if (s.phase !== 'awaiting_code' && s.phase !== 'running') return { ok: false, error: `The sign-in is already ${s.phase}.` };
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: 'No code was provided.' };
  if (!s.child.stdin?.writable) return { ok: false, error: 'The sign-in process is no longer accepting input.' };
  try {
    // The prompt is a raw-mode terminal field, so Enter is CARRIAGE RETURN.
    // A newline is accepted into the field and never submits it: the pasted
    // code sat there masked as asterisks while nothing happened, which is
    // exactly the symptom this cost. Verified against the real CLI — with \r it
    // answers immediately, including "Invalid code" for a bad one.
    // Send the code and the Enter SEPARATELY.
    //
    // A short string written in one chunk is processed as individual
    // keystrokes and a trailing \r submits it — which is why a 16-character
    // dummy worked in testing. A real code is 92 characters, and a chunk that
    // size is handled as a PASTE: the text lands in the field and the carriage
    // return riding along with it is absorbed rather than read as Enter. The
    // log caught it exactly — 92 asterisks sitting in the prompt, phase still
    // awaiting_code, nothing submitted.
    s.child.stdin.write(trimmed);
    setTimeout(() => {
      try { sessions.get(provider)?.child.stdin?.write('\r'); } catch { /* gone */ }
    }, 300).unref?.();
    s.notice = undefined;
    s.phase = 'running';
    const before = s.raw.length;
    console.log(`[tandem] provider-auth: ${provider} sign-in — code of ${trimmed.length} chars written to the CLI`);
    // The CLI answers a code within seconds. If nothing at all comes back, the
    // write did not land where it needed to, and that is worth knowing rather
    // than leaving the operator watching a silent page.
    setTimeout(() => {
      const cur = sessions.get(provider);
      if (!cur || cur.raw.length !== before) return;
      console.log(`[tandem] provider-auth: ${provider} produced NO output in 20s after the code. `
        + `Redacted tail follows:\n${cur.output.slice(-1500)}`);
      cur.notice = 'The CLI did not react to that code within 20 seconds. Open "What the CLI is showing" below '
        + 'and send those lines on.';
    }, 20_000).unref?.();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not hand the code to the CLI: ${String(err)}` };
  }
}

export function cancelLogin(provider: AuthProvider): void {
  const s = sessions.get(provider);
  if (!s) return;
  clearTimeout(s.timer);
  try { s.child.kill('SIGTERM'); } catch { /* gone */ }
  sessions.delete(provider);
}

// ------------------------------------------------------------------ status

export interface ProviderStatus {
  provider: AuthProvider;
  loggedIn: boolean;
  detail: string;
}

/** Ask each CLI whether it is signed in. Read-only: neither command mutates. */
export function checkStatus(provider: AuthProvider): Promise<ProviderStatus> {
  const [bin, args] = provider === 'claude'
    ? [config.claudeBin, ['auth', 'status']]
    : [config.codexBin, ['login', 'status']];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim();
      if (provider === 'claude') {
        try {
          const parsed = JSON.parse(text);
          return resolve({
            provider,
            loggedIn: !!parsed.loggedIn,
            detail: parsed.loggedIn ? `Signed in (${parsed.authMethod ?? 'account'})` : 'Not signed in',
          });
        } catch { /* fall through to the text reading below */ }
      }
      if (err && !text) return resolve({ provider, loggedIn: false, detail: 'The CLI could not be run.' });
      const loggedIn = /logged in|signed in/i.test(text) && !/not logged in|not signed in/i.test(text);
      resolve({ provider, loggedIn, detail: scrubCliOutput(text).split('\n')[0]?.slice(0, 200) || 'Unknown' });
    });
  });
}

export async function allStatus(): Promise<ProviderStatus[]> {
  return Promise.all([checkStatus('claude'), checkStatus('codex')]);
}

// ------------------------------------------------------- long-lived token

/**
 * The one-year token, and why this is the only credential Tandem ever holds.
 *
 * A subscription sign-in refreshes itself for about four weeks and then stops
 * dead — which is how every Director turn came to fail with "OAuth session
 * expired and could not be refreshed". `claude auth login` fixes that in a
 * minute from the browser, but it has to be done again every month.
 *
 * `claude setup-token` mints a token valid for a year instead. Tandem does not
 * run that command: reading a credential back out of a repainting terminal is
 * guesswork, and a token reconstructed one character short is indistinguishable
 * from a good one until every call starts failing with 401 — which is exactly
 * what happened. The operator runs `claude setup-token` in a shell, where the
 * value can simply be copied, and pastes it into Admin. Tandem's job is to
 * check it, encrypt it and hand it to each invocation.
 *
 * It is encrypted at rest with the same AES-256-GCM key the integration
 * credentials use, is never returned by any route, never rendered, never logged
 * and never evented. The UI only ever learns that one exists and when it
 * expires.
 */
db.exec(`CREATE TABLE IF NOT EXISTS provider_tokens (
  provider TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
)`);

export interface StoredTokenMeta {
  provider: AuthProvider;
  createdAt: number;
  expiresAt: number | null;
}

/** a stored token must still look like a credential before it is handed to a CLI */
const CREDENTIAL_SHAPE = /^[A-Za-z0-9._-]{24,}$/;

/** would this value be accepted as a token to hand to the CLI? */
function looksLikeToken(value: string): boolean {
  return CREDENTIAL_SHAPE.test(value);
}

/** Metadata only — the token itself is never exposed outside this module. */
export function tokenMeta(provider: AuthProvider): StoredTokenMeta | null {
  const r = db.prepare('SELECT provider, expires_at, created_at FROM provider_tokens WHERE provider = ?').get(provider) as
    { provider: AuthProvider; expires_at: number | null; created_at: number } | undefined;
  return r ? { provider: r.provider, createdAt: r.created_at, expiresAt: r.expires_at } : null;
}

/** The token for a CLI invocation's environment. The one place it is read. */
export function tokenForEnv(provider: AuthProvider): string | null {
  const r = db.prepare('SELECT data FROM provider_tokens WHERE provider = ?').get(provider) as { data: string } | undefined;
  if (!r) return null;
  try {
    const value = decryptSecret(r.data).token;
    return value && looksLikeToken(value) ? value : null;
  } catch {
    return null; // an unreadable blob must never become a broken environment
  }
}

export function forgetToken(provider: AuthProvider): void {
  db.prepare('DELETE FROM provider_tokens WHERE provider = ?').run(provider);
}

/** storage without the API check — for tests that exercise the store itself */
export function saveForTest(token: string, expiresAt: number): void { saveToken('claude', token, expiresAt); }

/**
 * The CLI does not state an expiry with the token, and the operator pastes a
 * bare string, so the year is Tandem's own assumption about `setup-token`'s
 * documented lifetime. The UI says "about", because that is all this is.
 */
const ASSUMED_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Take a token the operator pasted, prove it works, and store it encrypted.
 *
 * The value is checked before it is stored, never after: a token that does not
 * authenticate must not become the credential every Builder, Reviewer and
 * Director call depends on. Nothing here echoes, logs or returns the token —
 * the caller learns only whether it was accepted.
 */
export async function storePastedToken(
  provider: AuthProvider,
  raw: string,
  model: string,
): Promise<{ ok: boolean; error?: string; meta?: StoredTokenMeta }> {
  const token = String(raw ?? '').trim();
  if (!token) return { ok: false, error: 'Paste the token first.' };
  if (/\s/.test(token)) {
    return { ok: false, error: 'That value contains a space or line break. Copy the token on its own, with nothing around it.' };
  }
  if (!looksLikeToken(token)) {
    return { ok: false, error: 'That does not look like a token. Expected a single run of letters, digits, dots, dashes or underscores.' };
  }
  if (provider !== 'claude') {
    return { ok: false, error: 'Only Claude Code takes a pasted token; sign Codex in above.' };
  }

  const check = await verifyToken(token, model);
  if (!check.ok) {
    return { ok: false, error: check.error || 'The API refused that token. Check you copied all of it.' };
  }

  saveToken(provider, token, Date.now() + ASSUMED_TOKEN_LIFETIME_MS);
  console.log(`[tandem] provider-auth: ${provider} long-lived token saved after a successful API check`);
  return { ok: true, meta: tokenMeta(provider) ?? undefined };
}

function saveToken(provider: AuthProvider, token: string, expiresAt: number | null): void {
  db.prepare(`INSERT INTO provider_tokens (provider, data, expires_at, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .run(provider, encryptSecret({ token }), expiresAt, Date.now());
}

/**
 * Prove a token actually authenticates, before it is allowed to become the
 * credential every call depends on.
 *
 * A truncated or stale token is indistinguishable from a good one by
 * inspection: it has the right prefix, the right alphabet, no stray
 * characters. The only authority is the API. One minimal call settles it, and
 * it costs a fraction of one session — against silently breaking every Builder
 * and Director call, which is exactly what an unchecked token did.
 */
export function verifyToken(token: string, model: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(config.claudeBin, [
      '-p', '--output-format', 'json', '--model', model,
      '--exclude-dynamic-system-prompt-sections', 'Reply with the single word OK.',
    ], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: token,
      },
    }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      if (/401|unauthor|invalid|authenticate/i.test(text)) {
        return resolve({ ok: false, error: scrubCliOutput(text).trim().slice(0, 200) });
      }
      if (err && !stdout) return resolve({ ok: false, error: scrubCliOutput(String(stderr || err.message)).slice(0, 200) });
      try {
        const d = JSON.parse(stdout);
        if (d.is_error || (d.subtype && d.subtype !== 'success')) {
          return resolve({ ok: false, error: scrubCliOutput(String(d.result ?? d.subtype)).slice(0, 200) });
        }
        return resolve({ ok: true });
      } catch {
        return resolve({ ok: false, error: 'The check returned output that could not be read.' });
      }
    });
  });
}

