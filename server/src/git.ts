import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { GitFileStat, GitStatus } from '../../shared/types';

const run = promisify(execFile);
const cache = new Map<string, { at: number; value: GitStatus }>();

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function getGitStatus(rootPath: string): Promise<GitStatus> {
  const cached = cache.get(rootPath);
  if (cached && Date.now() - cached.at < 5_000) return cached.value;

  let value: GitStatus = { isRepo: false };
  try {
    if (fs.existsSync(path.join(rootPath, '.git'))) {
      const branch = (await git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const numstat = await git(rootPath, ['diff', '--numstat']);
      const untrackedOut = await git(rootPath, ['ls-files', '--others', '--exclude-standard']);

      const files: GitFileStat[] = [];
      let additions = 0;
      let deletions = 0;
      for (const line of numstat.split('\n')) {
        if (!line.trim()) continue;
        const [a, d, file] = line.split('\t');
        const add = a === '-' ? 0 : parseInt(a, 10);
        const del = d === '-' ? 0 : parseInt(d, 10);
        additions += add;
        deletions += del;
        files.push({ path: file, additions: add, deletions: del, status: 'modified' });
      }
      for (const file of untrackedOut.split('\n')) {
        if (!file.trim()) continue;
        let add = 0;
        try { add = fs.readFileSync(path.join(rootPath, file), 'utf8').split('\n').length; } catch { /* binary/unreadable */ }
        additions += add;
        files.push({ path: file, additions: add, deletions: 0, status: 'untracked' });
      }
      value = { isRepo: true, branch, changedFiles: files.length, additions, deletions, files };
    }
  } catch {
    value = { isRepo: false };
  }
  cache.set(rootPath, { at: Date.now(), value });
  return value;
}
