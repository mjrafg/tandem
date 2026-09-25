import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * File mentions in the chat become links into the Files dock. A chat provides
 * `open` (ChatView); outside a chat nothing is linked and text renders as is.
 */
export const FileLinkContext = createContext<{ open: (mention: string) => Promise<void> } | null>(null);

/** extensions a bare name (no folder) must end in to count as a file */
const KNOWN_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'log', 'txt', 'py', 'go', 'rs', 'java', 'kt', 'rb',
  'php', 'css', 'scss', 'less', 'html', 'htm', 'yml', 'yaml', 'toml', 'sql', 'sh', 'bash', 'env', 'lock', 'xml', 'csv',
  'conf', 'ini', 'cfg', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'vue', 'svelte', 'c', 'h', 'cpp', 'hpp', 'cs',
  'swift', 'dart', 'prisma', 'graphql', 'gql', 'proto', 'pdf', 'zip', 'tsbuildinfo', 'snap', 'patch', 'diff',
]);

/** product names that look like file names but are not files */
const NOT_FILES = new Set(['node.js', 'next.js', 'vue.js', 'react.js', 'express.js', 'nuxt.js', 'three.js', 'd3.js', 'chart.js', 'ember.js', 'deno.js']);

/**
 * Does this look like a path someone would want to open? Deliberately strict:
 * a false link is worse than a missing one. It must be one token, use only path
 * characters (commas only inside braces), and either contain a folder and end
 * in a file name or a slash, or be a bare file name with a known extension. It
 * may end in :line or :line:col.
 */
export function isPathLike(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3 || t.length > 300 || /\s/.test(t) || t.includes('://')) return false;
  const core = t.replace(/:\d+(?::\d+)?$/, '');
  if (!/^[\w@.+\-/{},*~?]+$/.test(core) || /^[-:]/.test(core)) return false;
  if (core.replace(/\{[^{}]*\}/g, '').includes(',')) return false;
  if (!/[A-Za-z]/.test(core)) return false;
  const last = core.replace(/\/+$/, '').split('/').pop() ?? '';
  const ext = (last.match(/\.([A-Za-z][\w]{0,11})$/) ?? [])[1]?.toLowerCase();
  if (core.includes('/')) {
    const segs = core.split('/').filter(Boolean);
    if (segs.length < 2 && !core.endsWith('/') && !core.startsWith('/')) return false;
    return !!ext || core.endsWith('/') || /[*{]/.test(last);
  }
  if (NOT_FILES.has(last.toLowerCase())) return false;
  return !!ext && KNOWN_EXT.has(ext) && /[A-Za-z_]/.test(last.slice(0, last.length - ext.length - 1) || '');
}

/** A mention that opens in the Files dock. */
export function FileLink({ mention, children, className = '' }: { mention: string; children?: ReactNode; className?: string }) {
  const ctx = useContext(FileLinkContext);
  const [busy, setBusy] = useState(false);
  if (!ctx) return <>{children ?? mention}</>;
  return (
    <button
      type="button"
      title={`Open ${mention}`}
      className={`inline cursor-pointer text-left underline decoration-dotted decoration-1 underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent ${busy ? 'cursor-wait opacity-70' : ''} ${className}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        try { await ctx.open(mention); } finally { setBusy(false); }
      }}
    >
      {children ?? mention}
    </button>
  );
}

/** a word split into what came before a path, the path (keeping :line), and the punctuation after it */
const WORD = /^([(\["'`]*)(.*?(?::\d+(?::\d+)?)?)([)\]}"'`.,;:!?]*)$/;

/** Plain text with every file mention in it turned into a link. */
export function LinkedText({ text }: { text: string }) {
  const ctx = useContext(FileLinkContext);
  if (!ctx || !text) return <>{text}</>;
  const parts = text.split(/(\s+)/);
  let any = false;
  const out = parts.map((part, i) => {
    if (!part || /^\s+$/.test(part)) return part;
    const [, lead = '', rest = '', trail = ''] = part.match(WORD) ?? [];
    if (!isPathLike(rest)) return part;
    any = true;
    return <span key={i}>{lead}<FileLink mention={rest} className="font-mono text-[0.93em]" />{trail}</span>;
  });
  return any ? <>{out}</> : <>{text}</>;
}
