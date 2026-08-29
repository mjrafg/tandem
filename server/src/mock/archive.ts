import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const MAX_ENTRIES = 40_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB uncompressed

export interface ZipScan {
  ok: boolean;
  error?: string;
  entries: number;
  totalBytes: number;
}

/** Pre-flight safety scan: entry count, expansion size, zip-slip paths. */
export function scanZip(zipPath: string): ZipScan {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    return { ok: false, error: 'Not a valid ZIP archive.', entries: 0, totalBytes: 0 };
  }
  const entries = zip.getEntries();
  if (entries.length === 0) return { ok: false, error: 'The archive is empty.', entries: 0, totalBytes: 0 };
  if (entries.length > MAX_ENTRIES) {
    return { ok: false, error: `Too many entries (${entries.length.toLocaleString()} > ${MAX_ENTRIES.toLocaleString()}).`, entries: entries.length, totalBytes: 0 };
  }
  let totalBytes = 0;
  for (const e of entries) {
    const name = e.entryName;
    if (path.isAbsolute(name) || name.split('/').includes('..') || name.includes('\0')) {
      return { ok: false, error: `Unsafe path inside the archive: ${name}`, entries: entries.length, totalBytes };
    }
    totalBytes += e.header.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, error: 'The archive expands beyond the 1 GB safety limit.', entries: entries.length, totalBytes };
    }
  }
  return { ok: true, entries: entries.length, totalBytes };
}

let unzipAvailable: boolean | null = null;

export function hasUnzipBinary(): boolean {
  if (unzipAvailable == null) {
    try {
      unzipAvailable = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
    } catch {
      unzipAvailable = false;
    }
  }
  return unzipAvailable;
}

/** Fallback extractor (used when the `unzip` binary is unavailable). */
export function extractZipInternal(zipPath: string, target: string): { files: number; bytes: number } {
  const zip = new AdmZip(zipPath);
  fs.mkdirSync(target, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of zip.getEntries()) {
    const dest = path.resolve(target, entry.entryName);
    if (!dest.startsWith(path.resolve(target) + path.sep) && dest !== path.resolve(target)) {
      throw new Error(`Unsafe path inside the archive: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    const data = entry.getData();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    files += 1;
    bytes += data.length;
  }
  return { files, bytes };
}

/** Unique sibling path: name, name-2, name-3, … */
export function uniquePath(desired: string): string {
  if (!fs.existsSync(desired)) return desired;
  let i = 2;
  while (fs.existsSync(`${desired}-${i}`)) i += 1;
  return `${desired}-${i}`;
}

/** Rough recursive file count (capped, skips .git/node_modules). */
export function countFiles(dir: string, cap = 5_000): number {
  let count = 0;
  const walk = (d: string) => {
    if (count >= cap) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else count += 1;
      if (count >= cap) return;
    }
  };
  walk(dir);
  return count;
}
