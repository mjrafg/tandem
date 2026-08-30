import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, shotsDir } from '../config';

/**
 * The OS-enforced read-only boundary shared by every AI process tree that must
 * not modify the repository (the Reviewer, the Project Director). bubblewrap
 * bind-mounts the project, Tandem's own code, and the database read-only;
 * writes fail with EROFS at the kernel level, no matter what the model or the
 * CLI decides. Callers keep an honest degraded mode for hosts without bwrap.
 */

let bwrapOk: boolean | null = null;

/** One-time real probe: bwrap present AND usable unprivileged here. */
export function bwrapAvailable(): boolean {
  if (bwrapOk !== null) return bwrapOk;
  try {
    const r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--ro-bind', '/tmp', '/tmp', '--', 'true'], { timeout: 10_000 });
    bwrapOk = !r.error && r.status === 0;
  } catch {
    bwrapOk = false;
  }
  return bwrapOk;
}

/** bwrap arguments placing an AI process tree in a read-only jail. */
export function readOnlyJailArgs(projectPath: string, cwd: string): string[] {
  const args = ['--dev-bind', '/', '/'];
  const ro = (p: string) => {
    if (p && fs.existsSync(p)) args.push('--ro-bind', p, p);
  };
  const rw = (p: string) => {
    if (p && fs.existsSync(p)) args.push('--bind', p, p);
  };
  ro(projectPath);                                    // the work under review
  ro(config.projectsDir);                             // EVERY project, not just the active one
  ro(path.dirname(process.argv[1] ?? ''));            // Tandem's own code
  ro(config.dataDir);                                 // chats, events, credentials, worktrees
  // surfaces that would let a jailed model change FUTURE turns' behavior:
  // the Claude CLI install and the user-level hook/instruction files (the
  // session store ~/.claude/projects must stay writable for --resume). The
  // hook/instruction files get inert placeholders when absent — otherwise a
  // jailed model could CREATE them, since their parent dir must stay writable.
  const home = os.homedir();
  const roEnsureFile = (p: string, placeholder: string) => {
    try {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, placeholder, { flag: 'wx' });
      }
    } catch { /* best effort — ro() below still guards the existing-file case */ }
    ro(p);
  };
  ro(path.join(home, '.local', 'share', 'claude'));
  ro(path.join(home, '.local', 'bin'));
  roEnsureFile(path.join(home, '.claude', 'settings.json'), '{}\n');
  roEnsureFile(path.join(home, '.claude', 'CLAUDE.md'), '');
  rw(shotsDir);                                       // browser screenshots stay writable
  rw(path.join(config.dataDir, 'tmp'));
  args.push('--die-with-parent', '--chdir', cwd, '--');
  return args;
}
