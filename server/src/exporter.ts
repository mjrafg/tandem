import fs from 'node:fs';
import path from 'node:path';
import type {
  AiCallPayload, BrowserActionPayload, Chat, ChatEvent, CommandPayload, CompactionPayload, ContextUsage,
  FileChangePayload, FileReadPayload, FindingsPayload, Project, SearchPayload,
} from '../../shared/types';
import { shotsDir } from './config';

export interface ExportBundle {
  exportedAt: number;
  app: { name: string; version: string };
  project: Project;
  chat: Chat;
  usage: ContextUsage;
  events: ChatEvent[];
}

const fmtTime = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const fmtDur = (ms?: number) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// ---------------------------------------------------------------- markdown

export function toMarkdown(b: ExportBundle): string {
  const out: string[] = [];
  out.push(`# ${b.chat.title}`);
  out.push('');
  out.push(`- **Project:** ${b.project.name} (\`${b.project.rootPath}\`)`);
  out.push(`- **Created:** ${fmtTime(b.chat.createdAt)} · **Last activity:** ${fmtTime(b.chat.updatedAt)}`);
  out.push(`- **Context at export:** ~${Math.round(b.usage.usedTokens / 1000)}k / ${Math.round(b.usage.limit / 1000)}k tokens (${b.usage.pct}%, estimated)`);
  out.push(`- **Exported:** ${fmtTime(b.exportedAt)} by ${b.app.name} v${b.app.version}`);
  out.push('');

  for (const e of b.events) {
    out.push(...eventToMarkdown(e, b.chat.id));
    out.push('');
  }
  return out.join('\n');
}

function eventToMarkdown(e: ChatEvent, chatId: string): string[] {
  const t = fmtTime(e.ts);
  switch (e.kind) {
    case 'user_message': {
      const p = e.payload as any;
      const lines = [`---`, ``, `### 🧑 User · ${t}`, ``, p.text || ''];
      if (p.attachments?.length) {
        lines.push('', ...p.attachments.map((a: any) => `> 📎 **${a.name}** (${fmtSize(a.size)})${a.path ? ` — \`${a.path}\`` : ''}`));
      }
      return lines;
    }
    case 'assistant_message':
      return [`### 🤖 Assistant · ${t}`, ``, (e.payload as any).text];
    case 'status':
      return [`> _${(e.payload as any).text}_`];
    case 'run': {
      const p = e.payload as any;
      const review = p.phase === 'started' && p.review !== undefined
        ? ` · Reviewer: ${p.review ? 'on' : 'skipped by user'}`
        : '';
      return [`> **Run ${p.phase}**${review} · ${t}`];
    }
    case 'command': {
      const p = e.payload as CommandPayload;
      const lines = [`<details><summary><b>Command</b> · <code>${escapeHtml(p.command)}</code> · exit ${p.exitCode ?? '—'} · ${fmtDur(p.durationMs)}</summary>`, ''];
      lines.push(`\`\`\`\n$ ${p.command}   # cwd: ${p.cwd}\n${p.stdout || '(no stdout)'}${p.stderr ? `\n[stderr]\n${p.stderr}` : ''}\n\`\`\``, '', '</details>');
      return lines;
    }
    case 'file_read': {
      const p = e.payload as FileReadPayload;
      return [`- 📄 Read \`${p.path}\`${p.lines ? ` (${p.lines} lines)` : ''}`];
    }
    case 'search': {
      const p = e.payload as SearchPayload;
      const lines = [`<details><summary><b>Search</b> · <code>${escapeHtml(p.query)}</code> (${p.tool}, ${p.matches.length} matches)</summary>`, ''];
      for (const m of p.matches) lines.push(`- \`${m.path}:${m.line}\` — ${m.preview}`);
      lines.push('', '</details>');
      return lines;
    }
    case 'file_change': {
      const p = e.payload as FileChangePayload;
      const lines = [`<details><summary><b>Changed ${p.files.length} file(s)</b> · +${p.files.reduce((n, f) => n + f.additions, 0)} −${p.files.reduce((n, f) => n + f.deletions, 0)}</summary>`, ''];
      for (const f of p.files) {
        lines.push(`**\`${f.path}\`** (+${f.additions} −${f.deletions})`, '', '```diff', f.diff, '```', '');
      }
      lines.push('</details>');
      return lines;
    }
    case 'ai_call': {
      const p = e.payload as AiCallPayload;
      const title = `${p.provider === 'claude-code' ? 'Claude' : 'Codex'} · ${roleLabel(p.role)}`;
      const lines = [`<details><summary><b>AI call — ${title}</b> · ${p.model} · ${p.effort} effort · ${fmtDur(p.durationMs)}${p.simulated ? ' · simulated' : ''} · ${p.status}</summary>`, ''];
      if (p.cli) lines.push(`- CLI: \`${p.cli.command}\` (cwd \`${p.cli.cwd}\`, exit ${p.cli.exitCode ?? '—'})`);
      if (p.response?.usage) lines.push(`- Usage: ${p.response.usage.inputTokens.toLocaleString()} in / ${p.response.usage.outputTokens.toLocaleString()} out tokens`);
      lines.push('', '**Request:**', '', '```', p.request.prompt, '```');
      if (p.response) lines.push('', '**Response:**', '', '```', p.response.text, '```');
      if (p.tools?.length) {
        lines.push('', `**Tandem tools available (${p.tools.length}):**`, '');
        for (const t of p.tools) lines.push(`- \`${t.name}\` — ${t.description}`);
      }
      if (p.error) lines.push('', `**Error:** ${p.error}`);
      lines.push('', '</details>');
      return lines;
    }
    case 'findings': {
      const p = e.payload as FindingsPayload;
      if (p.verdict === 'pass') return [`✅ **Reviewer PASS** (round ${p.round})`];
      const lines = [`⚠️ **Reviewer findings** (round ${p.round})${p.finalRepairNotReviewed ? ' — final repair afterwards was **not re-reviewed**' : ''}:`, ''];
      for (const f of p.items) {
        lines.push(`- **[${f.severity}] ${f.title}**${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}`);
        lines.push(`  ${f.detail}`);
        if (f.recommendation) lines.push(`  _Recommendation: ${f.recommendation}_`);
      }
      return lines;
    }
    case 'compaction': {
      const p = e.payload as CompactionPayload;
      return [
        `<details><summary><b>🗜 Context compacted</b> · ${Math.round(p.beforeTokens / 1000)}k → ${Math.round(p.afterTokens / 1000)}k tokens · ${p.model}${p.simulated ? ' · simulated' : ''}</summary>`,
        '',
        `Preserved: ${p.preserved.join('; ')}`,
        '',
        '**Compacted context:**', '', p.summary, '', '</details>',
      ];
    }
    case 'error': {
      const p = e.payload as any;
      return [`🛑 **Error** (${p.source ?? 'app'}): ${p.message}${p.detail ? `\n\n> ${p.detail}` : ''}`];
    }
    case 'checkpoint': {
      const p = e.payload as any;
      const label = p.action === 'merge' ? `Merged \`${p.branch}\` → \`${p.target}\``
        : p.action === 'push' ? `Pushed to \`origin/${p.target}\``
        : p.action === 'preserve' ? `Uncommitted changes preserved on \`${p.branch}\``
        : `Checkpoint saved on \`${p.branch}\``;
      const lines = [`- 🔖 **${label}**${p.commit ? ` · \`${p.commit}\`` : ''}${p.message ? ` — ${p.message}` : ''}`];
      if (p.files?.length) lines.push(...p.files.map((f: string) => `  - ${f}`));
      return lines;
    }
    case 'browser': {
      const p = e.payload as BrowserActionPayload;
      const lines = [`- 🌐 **Browser** (${p.role ?? 'agent'}): ${p.detail}${p.status === 'failed' ? ' — **failed**' : ''}${p.durationMs ? ` · ${fmtDur(p.durationMs)}` : ''}`];
      if (p.url) lines.push(`  - \`${p.url}\`${p.title ? ` — ${p.title}` : ''}`);
      if (p.value) lines.push(`  - value: \`${p.value}\``);
      if (p.error) lines.push(`  - error: ${p.error}`);
      if (p.screenshotFile) lines.push(`  - screenshot: \`shots/${chatId}/${p.screenshotFile}\` (embedded in the HTML export)`);
      if (p.console?.length) lines.push(...p.console.map((c) => `  - console [${c.level}]: ${c.text}`));
      return lines;
    }
    default:
      return [`- (${(e as ChatEvent).kind})`];
  }
}

function roleLabel(role: string): string {
  return role === 'final_repair' ? 'Final repair' : role.charAt(0).toUpperCase() + role.slice(1);
}

// ---------------------------------------------------------------- html

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toHtml(b: ExportBundle): string {
  const rows = b.events.map((e) => eventToHtml(e, b.chat.id)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(b.chat.title)} — Tandem export</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0c0e; color: #e8eaed; font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .meta { color: #9aa0a8; font-size: 13px; margin-bottom: 40px; }
  .meta code { color: #c6cad2; }
  .ev { margin: 14px 0; }
  .user { background: #1c2230; border: 1px solid #2a3550; border-radius: 14px; padding: 14px 18px; margin: 28px 0 18px; }
  .user .who, .assistant .who { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #8ea2d0; margin-bottom: 6px; }
  .assistant .who { color: #b0a68e; }
  .assistant { padding: 4px 2px; }
  .status { color: #9aa0a8; font-style: italic; font-size: 13.5px; }
  details { background: #121418; border: 1px solid #24272d; border-radius: 12px; padding: 0; overflow: hidden; }
  summary { cursor: pointer; padding: 10px 16px; font-size: 13.5px; color: #c6cad2; user-select: none; }
  summary:hover { background: #16191e; }
  .body { padding: 6px 16px 16px; border-top: 1px solid #1e2126; }
  pre { background: #0e1013; border: 1px solid #1e2126; border-radius: 8px; padding: 12px 14px; overflow-x: auto; font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #d5d9e0; white-space: pre-wrap; word-break: break-word; }
  .diff-add { color: #7ee08a; } .diff-del { color: #ff8f8a; } .diff-hunk { color: #7ca7f0; }
  .pass { color: #57ab5a; font-weight: 600; }
  .warn { color: #d8a03d; font-weight: 600; }
  .err { color: #e5534b; font-weight: 600; }
  .kv { color: #9aa0a8; font-size: 12.5px; margin: 4px 0; }
  ul { margin: 8px 0; padding-left: 22px; }
  .sev { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 99px; padding: 1px 8px; margin-right: 6px; }
  .sev.major { background: #3d2222; color: #ff8f8a; } .sev.minor { background: #3a3222; color: #e0c26a; }
  h4 { margin: 10px 0 4px; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(b.chat.title)}</h1>
  <div class="meta">
    Project <code>${escapeHtml(b.project.name)}</code> · <code>${escapeHtml(b.project.rootPath)}</code><br>
    ${fmtTime(b.chat.createdAt)} → ${fmtTime(b.chat.updatedAt)} · context ~${Math.round(b.usage.usedTokens / 1000)}k/${Math.round(b.usage.limit / 1000)}k (${b.usage.pct}%, estimated)<br>
    Exported ${fmtTime(b.exportedAt)} · ${escapeHtml(b.app.name)} v${b.app.version}
  </div>
${rows}
</div>
</body>
</html>`;
}

function diffToHtml(diff: string): string {
  return diff.split('\n').map((l) => {
    const esc = escapeHtml(l);
    if (l.startsWith('+')) return `<span class="diff-add">${esc}</span>`;
    if (l.startsWith('-')) return `<span class="diff-del">${esc}</span>`;
    if (l.startsWith('@@')) return `<span class="diff-hunk">${esc}</span>`;
    return esc;
  }).join('\n');
}

function eventToHtml(e: ChatEvent, chatId: string): string {
  const t = fmtTime(e.ts);
  switch (e.kind) {
    case 'user_message': {
      const p = e.payload as any;
      const atts = p.attachments?.length
        ? `<div class="kv" style="margin-top:6px">${p.attachments.map((a: any) => `📎 <b>${escapeHtml(a.name)}</b> (${fmtSize(a.size)})${a.path ? ` — <code>${escapeHtml(a.path)}</code>` : ''}`).join('<br>')}</div>`
        : '';
      return `<div class="ev user"><div class="who">User · ${t}</div>${mdLite(p.text || '')}${atts}</div>`;
    }
    case 'assistant_message':
      return `<div class="ev assistant"><div class="who">Assistant · ${t}</div>${mdLite((e.payload as any).text)}</div>`;
    case 'status':
      return `<div class="ev status">${escapeHtml((e.payload as any).text)}</div>`;
    case 'run': {
      const p = e.payload as any;
      const review = p.phase === 'started' && p.review !== undefined ? ` · Reviewer: ${p.review ? 'on' : 'skipped by user'}` : '';
      return `<div class="ev status">run ${escapeHtml(p.phase)}${escapeHtml(review)} · ${t}</div>`;
    }
    case 'command': {
      const p = e.payload as CommandPayload;
      const cls = (p.exitCode ?? 0) === 0 ? '' : ' <span class="err">exit ' + p.exitCode + '</span>';
      return `<div class="ev"><details><summary>Ran <code>${escapeHtml(p.command)}</code> · ${fmtDur(p.durationMs)}${cls}</summary><div class="body">
<div class="kv">cwd <code>${escapeHtml(p.cwd)}</code> · exit ${p.exitCode ?? '—'} · ${fmtDur(p.durationMs)} · ${t}</div>
<pre>${escapeHtml(p.stdout || '(no stdout)')}${p.stderr ? '\n\n[stderr]\n' + escapeHtml(p.stderr) : ''}</pre></div></details></div>`;
    }
    case 'file_read': {
      const p = e.payload as FileReadPayload;
      return `<div class="ev status">Read <code>${escapeHtml(p.path)}</code>${p.lines ? ` (${p.lines} lines)` : ''}</div>`;
    }
    case 'search': {
      const p = e.payload as SearchPayload;
      return `<div class="ev"><details><summary>Searched <code>${escapeHtml(p.query)}</code> · ${p.matches.length} matches</summary><div class="body"><ul>${p.matches.map((m) => `<li><code>${escapeHtml(m.path)}:${m.line}</code> — ${escapeHtml(m.preview)}</li>`).join('')}</ul></div></details></div>`;
    }
    case 'file_change': {
      const p = e.payload as FileChangePayload;
      const adds = p.files.reduce((n, f) => n + f.additions, 0);
      const dels = p.files.reduce((n, f) => n + f.deletions, 0);
      return `<div class="ev"><details><summary>Changed ${p.files.length} file(s) · <span class="diff-add">+${adds}</span> <span class="diff-del">−${dels}</span></summary><div class="body">${p.files.map((f) => `<h4><code>${escapeHtml(f.path)}</code> (+${f.additions} −${f.deletions})</h4><pre>${diffToHtml(f.diff)}</pre>`).join('')}</div></details></div>`;
    }
    case 'ai_call': {
      const p = e.payload as AiCallPayload;
      const who = p.provider === 'claude-code' ? 'Claude' : 'Codex';
      return `<div class="ev"><details><summary>Asked ${who} · ${roleLabel(p.role)} · ${escapeHtml(p.model)} · ${fmtDur(p.durationMs)}${p.simulated ? ' · simulated' : ''}</summary><div class="body">
<div class="kv">provider ${p.provider} · effort ${p.effort} · status ${p.status} · started ${fmtTime(p.startedAt)}${p.response?.usage ? ` · ${p.response.usage.inputTokens.toLocaleString()} in / ${p.response.usage.outputTokens.toLocaleString()} out` : ''}</div>
${p.cli ? `<div class="kv">cli <code>${escapeHtml(p.cli.command)}</code> · cwd <code>${escapeHtml(p.cli.cwd)}</code> · exit ${p.cli.exitCode ?? '—'}</div>` : ''}
<h4>Request</h4><pre>${escapeHtml(p.request.prompt)}</pre>
${p.response ? `<h4>Response</h4><pre>${escapeHtml(p.response.text)}</pre>` : ''}
${p.tools?.length ? `<details><summary>Tandem tools available · ${p.tools.length}</summary><ul>${p.tools.map((t) => `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.description)}</li>`).join('')}</ul></details>` : ''}
${p.error ? `<h4 class="err">Error</h4><pre>${escapeHtml(p.error)}</pre>` : ''}
</div></details></div>`;
    }
    case 'findings': {
      const p = e.payload as FindingsPayload;
      if (p.verdict === 'pass') return `<div class="ev"><span class="pass">✓ Reviewer PASS</span> <span class="kv">(round ${p.round})</span></div>`;
      return `<div class="ev"><details open><summary><span class="warn">Reviewer findings</span> · round ${p.round}${p.finalRepairNotReviewed ? ' · final repair not re-reviewed' : ''}</summary><div class="body"><ul>${p.items.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span><b>${escapeHtml(f.title)}</b>${f.file ? ` — <code>${escapeHtml(f.file)}${f.line ? ':' + f.line : ''}</code>` : ''}<br>${escapeHtml(f.detail)}${f.recommendation ? `<br><i>Recommendation: ${escapeHtml(f.recommendation)}</i>` : ''}</li>`).join('')}</ul></div></details></div>`;
    }
    case 'compaction': {
      const p = e.payload as CompactionPayload;
      return `<div class="ev"><details><summary>🗜 Context compacted · ${Math.round(p.beforeTokens / 1000)}k → ${Math.round(p.afterTokens / 1000)}k · ${escapeHtml(p.model)}${p.simulated ? ' · simulated' : ''}</summary><div class="body">
<div class="kv">provider ${p.provider} · duration ${fmtDur(p.durationMs)} · ${t}</div>
<h4>Preserved</h4><ul>${p.preserved.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
<h4>Compacted context</h4><pre>${escapeHtml(p.summary)}</pre></div></details></div>`;
    }
    case 'error': {
      const p = e.payload as any;
      return `<div class="ev"><span class="err">✕ ${escapeHtml(p.message)}</span>${p.detail ? `<div class="kv">${escapeHtml(p.detail)}</div>` : ''}</div>`;
    }
    case 'checkpoint': {
      const p = e.payload as any;
      const label = p.action === 'merge' ? `Merged ${escapeHtml(p.branch)} → ${escapeHtml(p.target ?? '')}`
        : p.action === 'push' ? `Pushed to origin/${escapeHtml(p.target ?? '')}`
        : p.action === 'preserve' ? `Uncommitted changes preserved on ${escapeHtml(p.branch)}`
        : `Checkpoint saved on ${escapeHtml(p.branch)}`;
      return `<div class="ev"><details><summary>🔖 ${label}${p.commit ? ` · <code>${escapeHtml(p.commit)}</code>` : ''}</summary><div class="body">
${p.message ? `<div class="kv">${escapeHtml(p.message)}</div>` : ''}
${p.files?.length ? `<ul>${p.files.map((f: string) => `<li><code>${escapeHtml(f)}</code></li>`).join('')}</ul>` : ''}
</div></details></div>`;
    }
    case 'browser': {
      const p = e.payload as BrowserActionPayload;
      let img = '';
      if (p.screenshotFile) {
        try {
          const data = fs.readFileSync(path.join(shotsDir, chatId, p.screenshotFile));
          img = `<div><img src="data:image/jpeg;base64,${data.toString('base64')}" style="max-width:100%;border:1px solid #24272d;border-radius:8px;margin-top:6px"></div>`;
        } catch {
          img = `<div class="kv">screenshot file missing: ${escapeHtml(p.screenshotFile)}</div>`;
        }
      }
      return `<div class="ev"><details${p.status === 'failed' || p.screenshotFile ? ' open' : ''}><summary>🌐 Browser (${escapeHtml(p.role ?? 'agent')}) · ${escapeHtml(p.detail)}${p.status === 'failed' ? ' · <span class="err">failed</span>' : ''}${p.durationMs ? ` · ${fmtDur(p.durationMs)}` : ''}</summary><div class="body">
${p.url ? `<div class="kv"><code>${escapeHtml(p.url)}</code>${p.title ? ` — ${escapeHtml(p.title)}` : ''}</div>` : ''}
${p.viewport ? `<div class="kv">viewport ${p.viewport.width}×${p.viewport.height}${p.viewport.deviceScaleFactor && p.viewport.deviceScaleFactor !== 1 ? ` @${p.viewport.deviceScaleFactor}x` : ''}</div>` : ''}
${p.value ? `<div class="kv">value <code>${escapeHtml(p.value)}</code></div>` : ''}
${p.error ? `<div class="kv err">${escapeHtml(p.error)}</div>` : ''}
${p.console?.length ? `<pre>${escapeHtml(p.console.map((c) => `[${c.level}] ${c.text}`).join('\n'))}</pre>` : ''}
${img}
</div></details></div>`;
    }
    default:
      return '';
  }
}

/** minimal markdown → html for message bodies (bold, code, lists, paragraphs) */
function mdLite(text: string): string {
  const esc = escapeHtml(text);
  const withInline = esc
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const blocks = withInline.split(/\n{2,}/).map((blk) => {
    const lines = blk.split('\n');
    if (lines.every((l) => /^[-*] /.test(l) || /^\d+\. /.test(l))) {
      const items = lines.map((l) => `<li>${l.replace(/^[-*] /, '').replace(/^\d+\. /, '')}</li>`).join('');
      return /^\d+\. /.test(lines[0]) ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    }
    return `<p>${blk.replace(/\n/g, '<br>')}</p>`;
  });
  return blocks.join('');
}
