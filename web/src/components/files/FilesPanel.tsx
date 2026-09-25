import {
  ArrowLeft, Check, ChevronRight, Copy, File, FileDiff, Folder, FolderTree, GitBranch, GitCommitHorizontal,
  Link2, Package, RefreshCw, WrapText, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  Chat, Project, RepoBranch, RepoBranches, RepoChanges, RepoEntry, RepoFile, RepoFileChange, RepoLog, RepoTree,
} from '@shared/types';
import { api } from '../../api';
import { fmtBytes, plural, timeAgo } from '../../lib/format';
import { DiffView } from '../DiffView';
import { Spinner } from '../ui';

export type FilesTab = 'files' | 'changes' | 'branches';

/** a file mention clicked in the chat, already resolved against the project */
export interface FileRequest {
  mention: string;
  matches: RepoEntry[];
  line?: number;
  /** when it was asked for: the same file twice is still two requests */
  at: number;
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** what the Changes tab is showing */
type ChangeSource =
  | { scope: 'working' }
  | { scope: 'branch'; ref: string; base?: string }
  | { scope: 'commit'; ref: string; label: string };

/** a request's result, its failure, or that it is still loading */
type Load<T> = { data?: T; error?: string; loading: boolean };

function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]): Load<T> {
  const [state, setState] = useState<Load<T>>({ loading: !!fn });
  useEffect(() => {
    if (!fn) { setState({ loading: false }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => { if (alive) setState({ data, loading: false }); },
      (err) => { if (alive) setState({ error: err instanceof Error ? err.message : String(err), loading: false }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/**
 * The project's files, changes and branches, read-only. It works on the chat's
 * own directory, so inside a Director session it shows that session's worktree
 * and branch. It fills whatever dock holds it (./Dock.tsx).
 */
export function FilesPanel({ chat, project, open, tab, onTab, onClose, request }: {
  chat: Chat; project: Project; open: boolean; tab: FilesTab; onTab: (t: FilesTab) => void; onClose: () => void;
  request?: FileRequest | null;
}) {
  const [reload, setReload] = useState(0);
  const [ref, setRef] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [source, setSource] = useState<ChangeSource>({ scope: 'working' });
  const [branch, setBranch] = useState<string | null>(null);
  /** the line a mention pointed at, highlighted in the open file */
  const [line, setLine] = useState<number | null>(null);
  /** a mention that matched several files: they are listed to pick from */
  const [matches, setMatches] = useState<FileRequest | null>(null);

  // a different chat or directory starts from the top
  useEffect(() => {
    setRef(null); setDir(''); setFile(null); setSource({ scope: 'working' }); setBranch(null); setLine(null); setMatches(null);
  }, [project.id]);

  // a file mentioned in the chat: open it (at its line), or list what matched
  useEffect(() => {
    if (!request) return;
    setRef(null);
    onTab('files');
    if (request.matches.length === 1) {
      const m = request.matches[0];
      setMatches(null);
      if (m.type === 'dir') { setDir(m.path); setFile(null); setLine(null); }
      else { setDir(parentOf(m.path)); setFile(m.path); setLine(request.line ?? null); }
    } else {
      setMatches(request); setFile(null); setLine(null);
    }
  }, [request?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // a run that just finished has changed files: show the new state
  const wasRunning = useRef(chat.running);
  useEffect(() => {
    if (wasRunning.current && !chat.running) setReload((n) => n + 1);
    wasRunning.current = chat.running;
  }, [chat.running]);

  const branches = useLoad<RepoBranches>(open ? () => api.repoBranches(project.id) : null, [open, project.id, reload]);

  const browse = useCallback((r: string | null, path = '', openFile: string | null = null) => {
    setRef(r); setDir(path); setFile(openFile); setLine(null); setMatches(null); onTab('files');
  }, [onTab]);

  if (!open) return null;
  const work = chat.gitState && chat.gitState.mode !== 'none' ? chat.gitState : null;
  const currentBranch = branches.data?.current ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-linesoft px-3.5 py-2.5">
          <FolderTree size={15} className="shrink-0 text-dim" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{project.name}</div>
            {currentBranch && (
              <div className="flex min-w-0 items-center gap-1 text-[11.5px] text-dim">
                <GitBranch size={11} className="shrink-0" />
                <span className="mono truncate">{currentBranch}</span>
              </div>
            )}
          </div>
          <button className="btn-ghost px-2 py-1.5" title="Refresh" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={14} />
          </button>
          <button className="btn-ghost -mr-1 px-2 py-1.5" onClick={onClose} aria-label="Close files panel"><X size={15} /></button>
        </div>

        <div className="flex shrink-0 border-b border-linesoft px-2" role="tablist">
          {([['files', 'Files'], ['changes', 'Changes'], ['branches', 'Branches']] as const).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={`-mb-px flex-1 border-b-2 px-2 py-2.5 text-[13px] transition-colors ${tab === k ? 'border-accent font-medium text-ink' : 'border-transparent text-dim hover:text-mut'}`}
              onClick={() => onTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'files' && (
            <FilesView
              projectId={project.id} projectName={project.name} reload={reload}
              branches={branches.data} refName={ref} dir={dir} file={file} line={line} matches={matches}
              onRef={(r) => browse(r)} onDir={(d) => { setDir(d); setFile(null); setLine(null); setMatches(null); }}
              onFile={(f) => { setFile(f); setLine(null); if (f) setDir(parentOf(f)); }}
              onCloseMatches={() => setMatches(null)}
            />
          )}
          {tab === 'changes' && (
            <ChangesView
              projectId={project.id} reload={reload} source={source} onSource={setSource} work={work}
              onOpenFile={(r, p) => browse(r, p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', p)}
            />
          )}
          {tab === 'branches' && (
            branch ? (
              <BranchDetail
                projectId={project.id} reload={reload} name={branch} branches={branches.data}
                onBack={() => setBranch(null)}
                onBrowse={() => browse(branch === currentBranch ? null : branch)}
                onChanges={(s) => { setSource(s); onTab('changes'); }}
              />
            ) : (
              <BranchesView state={branches} chatId={chat.id} workBranch={work?.workBranch ?? null} onOpen={setBranch} />
            )
          )}
        </div>
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function Loading() {
  return <div className="flex justify-center py-10"><Spinner size={16} /></div>;
}

function Failed({ error }: { error: string }) {
  return <p className="px-4 py-6 text-center text-[12.5px] text-err">{error}</p>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-dim">{children}</p>;
}

function NotARepo({ what }: { what: string }) {
  return <Empty>This folder is not a git repository, so it has no {what}.</Empty>;
}

// ---------------------------------------------------------------- files

function FilesView({ projectId, projectName, reload, branches, refName, dir, file, line, matches, onRef, onDir, onFile, onCloseMatches }: {
  projectId: string; projectName: string; reload: number; branches?: RepoBranches;
  refName: string | null; dir: string; file: string | null; line: number | null; matches: FileRequest | null;
  onRef: (r: string | null) => void; onDir: (d: string) => void; onFile: (f: string | null) => void; onCloseMatches: () => void;
}) {
  const tree = useLoad<RepoTree>(() => api.repoTree(projectId, dir, refName), [projectId, dir, refName, reload]);
  const crumbs = dir ? dir.split('/') : [];

  return (
    <div>
      <div className="sticky top-0 z-10 space-y-2 border-b border-linesoft bg-bg1 px-3 py-2.5">
        {branches?.isRepo && (
          <select
            aria-label="Which version of the files"
            className="input w-full cursor-pointer py-1.5 text-[13px]"
            value={refName ?? ''}
            onChange={(e) => onRef(e.target.value || null)}
          >
            <option value="" className="bg-bg1">On disk now</option>
            {branches.branches.map((b) => (
              <option key={b.name} value={b.name} className="bg-bg1">Branch {b.name}{b.current ? ', last commit' : ''}</option>
            ))}
            {refName && !branches.branches.some((b) => b.name === refName) && (
              <option value={refName} className="bg-bg1">Commit {refName.slice(0, 12)}</option>
            )}
          </select>
        )}
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-[12.5px]" aria-label="Folder path">
          <button className="rounded px-1 py-0.5 font-medium text-mut hover:bg-bg2 hover:text-ink" onClick={() => onDir('')}>{projectName}</button>
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex min-w-0 items-center gap-0.5">
              <ChevronRight size={12} className="shrink-0 text-dim" />
              <button className="mono min-w-0 truncate rounded px-1 py-0.5 text-mut hover:bg-bg2 hover:text-ink" onClick={() => onDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
          {file && (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <ChevronRight size={12} className="shrink-0 text-dim" />
              <span className="mono min-w-0 truncate px-1 text-ink">{file.split('/').pop()}</span>
            </span>
          )}
        </nav>
      </div>

      {file ? (
        <FileViewer
          projectId={projectId} path={file} refName={refName} reload={reload} line={line}
          backLabel={matches ? 'Matches' : 'Folder'} onBack={() => onFile(null)}
        />
      ) : matches ? (
        <MatchesView req={matches} onOpen={(e) => (e.type === 'dir' ? onDir(e.path) : onFile(e.path))} onClose={onCloseMatches} />
      ) : tree.loading && !tree.data ? <Loading /> : tree.error ? <Failed error={tree.error} /> : tree.data && (
        tree.data.entries.length === 0 ? <Empty>This folder is empty.</Empty> : (
          <ul className="py-1">
            {dir && (
              <li>
                <button className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] text-dim hover:bg-bg2" onClick={() => onDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')}>
                  <ArrowLeft size={14} /> Up
                </button>
              </li>
            )}
            {tree.data.entries.map((e) => <EntryRow key={e.path} e={e} onDir={onDir} onFile={onFile} />)}
            {tree.data.truncated && <li><Empty>Only the first {tree.data.entries.length} entries are shown.</Empty></li>}
          </ul>
        )
      )}
    </div>
  );
}

function EntryRow({ e, onDir, onFile }: { e: RepoEntry; onDir: (d: string) => void; onFile: (f: string) => void }) {
  const Icon = e.type === 'dir' ? Folder : e.type === 'symlink' ? Link2 : e.type === 'submodule' ? Package : File;
  const openable = e.type === 'dir' || e.type === 'file';
  const hint = e.type === 'symlink' ? 'link outside the project' : e.type === 'submodule' ? 'submodule' : null;
  return (
    <li>
      <button
        disabled={!openable}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-bg2 disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => (e.type === 'dir' ? onDir(e.path) : onFile(e.path))}
      >
        <Icon size={15} className={`shrink-0 ${e.type === 'dir' ? 'text-accent/80' : 'text-dim'}`} />
        <span className={`min-w-0 flex-1 truncate text-[13px] ${openable ? 'text-ink' : 'text-dim'}`}>{e.name}</span>
        {hint && <span className="shrink-0 text-[11px] text-dim">{hint}</span>}
        {e.size != null && <span className="shrink-0 text-[11px] tabular-nums text-dim">{fmtBytes(e.size)}</span>}
        {e.type === 'dir' && <ChevronRight size={14} className="shrink-0 text-dim" />}
      </button>
    </li>
  );
}

/** lines rendered at first; a large file shows the rest on request */
const FIRST_LINES = 3000;

function MatchesView({ req, onOpen, onClose }: { req: FileRequest; onOpen: (e: RepoEntry) => void; onClose: () => void }) {
  return (
    <div>
      <div className="flex items-start gap-2 border-b border-linesoft px-3.5 py-2.5">
        <p className="min-w-0 flex-1 text-[12.5px] text-mut">
          {plural(req.matches.length, 'file')} match <span className="mono break-all text-ink">{req.mention}</span>
        </p>
        <button className="btn-ghost -mr-1 shrink-0 px-1.5 py-1" onClick={onClose} aria-label="Close the matches"><X size={13} /></button>
      </div>
      <ul className="py-1">
        {req.matches.map((e) => (
          <li key={e.path}>
            <button className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-bg2" onClick={() => onOpen(e)}>
              {e.type === 'dir' ? <Folder size={15} className="shrink-0 text-accent/80" /> : <File size={15} className="shrink-0 text-dim" />}
              <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink" title={e.path}>{e.path}</span>
              {e.size != null && <span className="shrink-0 text-[11px] tabular-nums text-dim">{fmtBytes(e.size)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FileViewer({ projectId, path, refName, reload, line, backLabel, onBack }: {
  projectId: string; path: string; refName: string | null; reload: number; line?: number | null; backLabel: string; onBack: () => void;
}) {
  const f = useLoad<RepoFile>(() => api.repoFile(projectId, path, refName), [projectId, path, refName, reload]);
  const [wrap, setWrap] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => (f.data?.content ?? '').replace(/\n$/, '').split('\n'), [f.data?.content]);
  const shown = all ? lines : lines.slice(0, FIRST_LINES);
  // a mention with a line: bring that line into view, even past the first chunk
  const target = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!line || !f.data?.content) return;
    if (line > FIRST_LINES && !all) { setAll(true); return; }
    target.current?.scrollIntoView({ block: 'center' });
  }, [line, f.data?.content, all]);

  return (
    <div>
      <div className="flex items-center gap-1.5 border-b border-linesoft px-2 py-1.5">
        <button className="btn-ghost px-2 py-1 text-[12.5px]" onClick={onBack}><ArrowLeft size={13} /> {backLabel}</button>
        <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-dim">
          {f.data && <>{fmtBytes(f.data.size)}{!f.data.binary && <> · {plural(lines.length, 'line')}</>}{refName ? <> · {refName.length > 20 ? refName.slice(0, 12) : refName}</> : null}</>}
        </span>
        {f.data?.content != null && (
          <>
            <button className={`btn-ghost px-2 py-1 ${wrap ? 'text-accent' : ''}`} title="Wrap long lines" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              <WrapText size={14} />
            </button>
            <button
              className="btn-ghost px-2 py-1" title="Copy file contents"
              onClick={() => { void navigator.clipboard.writeText(f.data!.content!); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            >
              {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
            </button>
          </>
        )}
      </div>
      {f.loading && !f.data ? <Loading /> : f.error ? <Failed error={f.error} /> : f.data && (
        f.data.binary ? <Empty>This is a binary file ({fmtBytes(f.data.size)}), so it is not shown as text.</Empty> : (
          <>
            {f.data.truncated && (
              <p className="border-b border-linesoft bg-warn/10 px-3.5 py-2 text-[12px] text-warn">
                This file is {fmtBytes(f.data.size)}. Only the first {fmtBytes(f.data.content!.length)} are shown.
              </p>
            )}
            <div className={wrap ? '' : 'overflow-x-auto'}>
              <table className="mono w-full border-collapse text-[12px] leading-[1.6]">
                <tbody>
                  {shown.map((l, i) => (
                    <tr key={i} ref={i + 1 === line ? target : undefined} className={i + 1 === line ? 'bg-accent/15' : undefined}>
                      <td className="w-px select-none whitespace-nowrap border-r border-linesoft px-2.5 text-right align-top tabular-nums text-dim/70">{i + 1}</td>
                      <td className={`px-3 align-top text-[#c3c9d4] ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>{l || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lines.length > shown.length && (
              <div className="p-3 text-center">
                <button className="btn-outline px-3 py-1.5 text-[12.5px]" onClick={() => setAll(true)}>
                  Show all {lines.length.toLocaleString()} lines
                </button>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------- changes

const STATUS: Record<RepoFileChange['status'], { letter: string; tone: string; label: string }> = {
  added: { letter: 'A', tone: 'bg-ok/15 text-ok', label: 'added' },
  untracked: { letter: 'U', tone: 'bg-ok/15 text-ok', label: 'new, not yet committed' },
  modified: { letter: 'M', tone: 'bg-warn/15 text-warn', label: 'modified' },
  deleted: { letter: 'D', tone: 'bg-err/15 text-err', label: 'deleted' },
  renamed: { letter: 'R', tone: 'bg-accent/15 text-accent', label: 'renamed' },
};

function ChangesView({ projectId, reload, source, onSource, work, onOpenFile }: {
  projectId: string; reload: number; source: ChangeSource; onSource: (s: ChangeSource) => void;
  work: Chat['gitState'] | null; onOpenFile: (ref: string | null, path: string) => void;
}) {
  const key = JSON.stringify(source);
  const c = useLoad<RepoChanges>(
    () => source.scope === 'working'
      ? api.repoChanges(projectId, 'working')
      : source.scope === 'branch'
        ? api.repoChanges(projectId, 'branch', source.ref, source.base)
        : api.repoChanges(projectId, 'commit', source.ref),
    [projectId, key, reload],
  );
  // the chat's own branch against the branch it would merge into
  const ownBranch = work && work.workBranch && work.targetBranch && work.workBranch !== work.targetBranch
    ? { scope: 'branch' as const, ref: work.workBranch, base: work.targetBranch }
    : null;
  const isOwn = ownBranch && source.scope === 'branch' && source.ref === ownBranch.ref && source.base === ownBranch.base;
  const custom = source.scope === 'commit' || (source.scope === 'branch' && !isOwn);

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-[12px] transition-colors ${active ? 'border-accent/40 bg-accent/15 text-accent' : 'border-line text-mut hover:bg-bg2 hover:text-ink'}`;

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-linesoft bg-bg1 px-3 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          <button className={chip(source.scope === 'working')} onClick={() => onSource({ scope: 'working' })}>Uncommitted</button>
          {ownBranch && (
            <button className={chip(!!isOwn)} onClick={() => onSource(ownBranch)}>
              <span className="mono">{ownBranch.ref}</span> vs <span className="mono">{ownBranch.base}</span>
            </button>
          )}
          {custom && (
            <span className={`${chip(true)} inline-flex min-w-0 max-w-full items-center gap-1.5`}>
              {source.scope === 'commit'
                ? <><GitCommitHorizontal size={12} className="shrink-0" /><span className="min-w-0 truncate">{source.label}</span></>
                : <><GitBranch size={12} className="shrink-0" /><span className="mono min-w-0 truncate">{source.ref}</span></>}
              <button className="-mr-1 shrink-0 rounded-full p-0.5 hover:bg-accent/20" aria-label="Back to uncommitted changes" onClick={() => onSource({ scope: 'working' })}>
                <X size={11} />
              </button>
            </span>
          )}
        </div>
        {c.data?.isRepo && (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[12px] text-dim">
            <span>{plural(c.data.files.length, 'file')}</span>
            <span className="tabular-nums"><span className="text-ok">+{c.data.additions}</span> <span className="text-err">−{c.data.deletions}</span></span>
            <span className="min-w-0 truncate">{describe(c.data)}</span>
          </div>
        )}
      </div>
      {c.loading && !c.data ? <Loading /> : c.error ? <Failed error={c.error} /> : c.data && (
        !c.data.isRepo ? <NotARepo what="tracked changes" /> : c.data.files.length === 0 ? (
          <Empty>{source.scope === 'working' ? 'Nothing is uncommitted. Every change is in a commit.' : 'No file differs.'}</Empty>
        ) : (
          <ul className="divide-y divide-linesoft">
            {c.data.files.map((f) => (
              <ChangeRow
                key={`${key}:${f.path}`} f={f} startOpen={c.data!.files.length <= 3}
                onOpen={f.status === 'deleted' ? null : () => onOpenFile(source.scope === 'working' ? null : source.ref, f.path)}
              />
            ))}
            {c.data.truncated && <li><Empty>This change set is large. Some files are listed without their diff.</Empty></li>}
          </ul>
        )
      )}
    </div>
  );
}

function describe(c: RepoChanges): string {
  if (c.scope === 'working') return c.base ? 'on disk, against the last commit' : 'on disk, no commits yet';
  if (c.scope === 'branch') return `what ${c.head} changed since it left ${c.base}`;
  return c.base ? `commit ${c.head}, against its parent` : `commit ${c.head}, the first commit`;
}

function ChangeRow({ f, startOpen, onOpen }: { f: RepoFileChange; startOpen: boolean; onOpen: (() => void) | null }) {
  const [open, setOpen] = useState(startOpen);
  const s = STATUS[f.status];
  return (
    <li>
      <button className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-bg2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={13} className={`shrink-0 text-dim transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[10.5px] font-semibold ${s.tone}`} title={s.label}>{s.letter}</span>
        <span className="min-w-0 flex-1">
          <span className="mono block truncate text-[12.5px] text-ink" title={f.path}>{f.path}</span>
          {f.oldPath && <span className="mono block truncate text-[11px] text-dim">from {f.oldPath}</span>}
        </span>
        <span className="shrink-0 text-[11.5px] tabular-nums">
          {f.binary ? <span className="text-dim">binary</span> : <><span className="text-ok">+{f.additions}</span> <span className="text-err">−{f.deletions}</span></>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {f.diff ? <DiffView diff={f.diff} /> : (
            <p className="text-[12px] text-dim">
              {f.binary ? 'Binary file: no text diff.' : f.truncated ? 'This diff is too large to show here.' : f.status === 'renamed' ? 'Renamed with no content change.' : 'No text changes.'}
            </p>
          )}
          {f.truncated && f.diff && <p className="text-[11.5px] text-warn">The diff was cut here; the file has more changes.</p>}
          {onOpen && (
            <button className="btn-ghost px-2 py-1 text-[12px]" onClick={onOpen}><File size={12} /> Open the file</button>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- branches

function BranchesView({ state, chatId, workBranch, onOpen }: {
  state: Load<RepoBranches>; chatId: string; workBranch: string | null; onOpen: (name: string) => void;
}) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <Failed error={state.error} />;
  const d = state.data;
  if (!d) return null;
  if (!d.isRepo) return <NotARepo what="branches" />;
  if (d.branches.length === 0) return <Empty>This repository has no branches yet.</Empty>;
  return (
    <div>
      {d.base && (
        <p className="border-b border-linesoft px-3.5 py-2 text-[11.5px] text-dim">
          Ahead and behind are counted against <span className="mono text-mut">{d.base}</span>.
        </p>
      )}
      <ul className="divide-y divide-linesoft">
        {d.branches.map((b) => <BranchRow key={b.name} b={b} base={d.base} chatId={chatId} own={b.name === workBranch} onOpen={() => onOpen(b.name)} />)}
      </ul>
    </div>
  );
}

function BranchRow({ b, base, chatId, own, onOpen }: { b: RepoBranch; base: string | null; chatId: string; own: boolean; onOpen: () => void }) {
  return (
    <li className="px-3.5 py-2.5 hover:bg-bg2">
      <button className="block w-full text-left" onClick={onOpen}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <GitBranch size={13} className={`shrink-0 ${b.current ? 'text-accent' : 'text-dim'}`} />
          <span className="mono min-w-0 max-w-full break-all text-[13px] text-ink">{b.name}</span>
          {b.current && <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-[1px] text-[10.5px] text-accent">checked out</span>}
          {own && <span className="shrink-0 rounded-full bg-ok/15 px-1.5 py-[1px] text-[10.5px] text-ok">this chat</span>}
        </div>
        <div className="mt-0.5 truncate pl-[21px] text-[12px] text-mut">{b.subject}</div>
        <div className="mt-0.5 flex gap-2 pl-[21px] text-[11px] tabular-nums text-dim">
          {b.name !== base && b.ahead != null && <span>{b.ahead} ahead · {b.behind} behind</span>}
          <span className="ml-auto">{timeAgo(b.date)}</span>
        </div>
      </button>
      {b.chatId && b.chatId !== chatId && (
        <Link to={`/c/${b.chatId}`} className="mt-1 ml-[21px] inline-flex max-w-full items-center gap-1 text-[11.5px] text-accent hover:underline">
          <span className="truncate">Worked on in: {b.chatTitle || 'a chat'}</span>
        </Link>
      )}
    </li>
  );
}

function BranchDetail({ projectId, reload, name, branches, onBack, onBrowse, onChanges }: {
  projectId: string; reload: number; name: string; branches?: RepoBranches;
  onBack: () => void; onBrowse: () => void; onChanges: (s: ChangeSource) => void;
}) {
  const b = branches?.branches.find((x) => x.name === name);
  const base = branches?.base && branches.base !== name ? branches.base : null;
  const log = useLoad<RepoLog>(() => api.repoLog(projectId, name, base), [projectId, name, base, reload]);
  return (
    <div>
      <div className="border-b border-linesoft px-2 py-1.5">
        <button className="btn-ghost px-2 py-1 text-[12.5px]" onClick={onBack}><ArrowLeft size={13} /> All branches</button>
      </div>
      <div className="space-y-2.5 border-b border-linesoft px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={14} className="shrink-0 text-dim" />
          <span className="mono min-w-0 truncate text-[14px] font-medium">{name}</span>
        </div>
        {b && base && b.ahead != null && (
          <p className="text-[12px] text-dim">{plural(b.ahead, 'commit')} not on {base}, {plural(b.behind ?? 0, 'commit')} on {base} not here.</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button className="btn-outline px-2.5 py-1 text-[12.5px]" onClick={onBrowse}><FolderTree size={13} /> Browse files</button>
          {base && (
            <button className="btn-outline px-2.5 py-1 text-[12.5px]" onClick={() => onChanges({ scope: 'branch', ref: name, base })}>
              <FileDiff size={13} /> Changes vs <span className="mono">{base}</span>
            </button>
          )}
        </div>
      </div>
      <div className="px-3.5 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-dim">
        {base ? `Commits not on ${base}` : 'Recent commits'}
      </div>
      {log.loading && !log.data ? <Loading /> : log.error ? <Failed error={log.error} /> : log.data && (
        log.data.commits.length === 0 ? <Empty>No commits here that are not on {base}.</Empty> : (
          <ul className="divide-y divide-linesoft">
            {log.data.commits.map((c) => (
              <li key={c.sha}>
                <button
                  className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left hover:bg-bg2"
                  onClick={() => onChanges({ scope: 'commit', ref: c.sha, label: c.subject || c.sha.slice(0, 12) })}
                >
                  <GitCommitHorizontal size={14} className="mt-0.5 shrink-0 text-dim" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] leading-snug text-ink">{c.subject}</span>
                    <span className="mt-0.5 block text-[11px] text-dim">
                      <span className="mono">{c.sha.slice(0, 8)}</span> · {c.author} · {timeAgo(c.date)}
                    </span>
                  </span>
                  <ChevronRight size={14} className="mt-0.5 shrink-0 text-dim" />
                </button>
              </li>
            ))}
            {log.data.truncated && <li><Empty>Only the latest {log.data.commits.length} commits are shown.</Empty></li>}
          </ul>
        )
      )}
    </div>
  );
}
