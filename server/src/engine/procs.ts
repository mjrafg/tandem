import { spawn } from 'node:child_process';
import type { RunCtx } from './run';
import { killChild } from './run';

export interface StreamResult {
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  stderrTail: string;
}

/**
 * Spawn a CLI, feed optional stdin, and hand each stdout line (NDJSON) to
 * `onLine`. Registers the child on the run context so Stop kills it.
 */
export function spawnStreaming(opts: {
  ctx: RunCtx;
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdinData?: string;
  timeoutMs: number;
  onLine: (line: string) => void;
}): Promise<StreamResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let buffer = '';
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: [opts.stdinData != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, timedOut: false, spawnError: String(err), stderrTail: '' });
      return;
    }
    opts.ctx.child = child;

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(opts.ctx);
    }, opts.timeoutMs);

    if (opts.stdinData != null && child.stdin) {
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try { opts.onLine(line); } catch { /* one bad line must not kill the run */ }
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.ctx.child === child) opts.ctx.child = undefined;
      const rest = buffer.trim();
      if (rest) {
        try { opts.onLine(rest); } catch { /* ignore */ }
      }
      resolve({ exitCode, timedOut, spawnError, stderrTail: stderr.trim() });
    };

    child.on('error', (err) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}
