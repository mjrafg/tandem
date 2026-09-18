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
 * terminal — `claude setup-token` with stdin from /dev/null prints nothing and
 * exits 0 — so the login runs under a PTY borrowed from `script(1)`, which is
 * already on the host and costs no new dependency. The CLI prints an
 * authorization URL; the operator opens it in their own browser, signs in to
 * their own account, and pastes back the short code the provider shows them.
 *
 * What Tandem does NOT do: it never sees a password, never stores the pasted
 * code (it goes straight to the child's stdin and is not logged, evented or
 * written to disk), and never reads the credential file the CLI writes. The
 * output shown in the browser is scrubbed of anything token-shaped first,
 * because `setup-token` in particular is designed to print a credential at the
 * end and that must not reach a browser or a log.
 *
 * A login is deliberately in-memory and short-lived. If the server restarts
 * mid-flow the flow is simply gone and the operator starts again; nothing about
 * a half-finished login is worth making durable.
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { config } from './config';

export type AuthProvider = 'claude' | 'codex';

export interface LoginState {
  provider: AuthProvider;
  /** running = working; awaiting_code = the operator must paste a code; done/failed = terminal */
  phase: 'running' | 'awaiting_code' | 'done' | 'failed';
  /** the URL to open, once the CLI has printed one */
  url: string | null;
  /** scrubbed tail of the CLI's output, for the operator to see what it is doing */
  output: string;
  startedAt: number;
  error?: string;
}

interface Session extends LoginState {
  child: ChildProcess;
  raw: string;
  timer: NodeJS.Timeout;
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
 * URL are replaced: `claude setup-token` prints a long-lived token when it
 * succeeds, and that must never reach a browser, a log or an event.
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

function loginCommand(provider: AuthProvider): string {
  return provider === 'claude'
    ? `${config.claudeBin} setup-token`
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
  const { provider: p, phase, url, output, startedAt, error } = s;
  return { provider: p, phase, url, output, startedAt, error };
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
    child, raw: '',
    timer: setTimeout(() => finish(provider, 'failed', 'The sign-in did not finish within 10 minutes.'), LOGIN_TIMEOUT_MS),
  };
  sessions.set(provider, session);

  const absorb = (chunk: Buffer | string) => {
    session.raw = (session.raw + String(chunk)).slice(-40_000);
    session.output = scrubCliOutput(session.raw).slice(-OUTPUT_TAIL);
    if (!session.url) session.url = findUrl(session.raw);
    if (session.phase === 'running' && session.url && wantsCode(session.output)) session.phase = 'awaiting_code';
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
    s.child.stdin.write(`${trimmed}\n`);
    s.phase = 'running';
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
