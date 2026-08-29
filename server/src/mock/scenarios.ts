import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, Finding, SearchMatch } from '../../../shared/types';
import { BASE_PROMPTS } from '../settings';
import type { Run } from './engine';

/*
 * Milestone-1 simulation scenarios. These produce the realistic activity the
 * UI is evaluated with. The classification below is a mock-only convenience —
 * the real engine hands the message to the Builder and lets IT decide.
 */

// ---------------------------------------------------------------- utilities

const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const chance = (p: number) => Math.random() < p;

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

const FALLBACK_FILES = [
  'src/App.tsx', 'src/main.tsx', 'src/api/client.ts', 'src/components/Header.tsx',
  'src/components/Layout.tsx', 'src/pages/Home.tsx', 'src/pages/Settings.tsx',
  'src/lib/format.ts', 'src/styles.css', 'package.json', 'README.md',
];

/** Real file names from the project when available, plausible ones otherwise. */
export function sampleFiles(rootPath: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || found.length > 60) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(tsx?|jsx?|json|css|md|py|go|rs|vue|svelte)$/.test(e.name)) {
        found.push(path.relative(rootPath, full));
      }
    }
  };
  walk(rootPath, 0);
  const source = found.filter((f) => !/^(package(-lock)?\.json|README)/.test(f));
  return source.length >= 4 ? source : found.length >= 4 ? found : FALLBACK_FILES;
}

function keywords(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !['this', 'that', 'with', 'from', 'into', 'what', 'where', 'when', 'please', 'should'].includes(w));
}

function fileLines(rootPath: string, rel: string): number {
  try { return fs.readFileSync(path.join(rootPath, rel), 'utf8').split('\n').length; }
  catch { return rnd(40, 240); }
}

function composePrompt(h: Run, role: 'builder' | 'reviewer' | 'final_repair', request: string): string {
  const base = role === 'reviewer' ? BASE_PROMPTS.reviewer : role === 'final_repair' ? BASE_PROMPTS.final_repair : BASE_PROMPTS.builder;
  const roleCfg = role === 'reviewer' ? h.settings.roles.reviewer : h.settings.roles.builder;
  const extra = role === 'final_repair' ? h.settings.finalRepairInstructions : roleCfg.instructions;
  const parts = [base];
  if (h.settings.sharedInstructions.trim()) parts.push(h.settings.sharedInstructions.trim());
  if (extra.trim()) parts.push(extra.trim());
  parts.push(`Project: ${h.project.name}\nWorking directory: ${h.project.rootPath}`);
  parts.push(`[active conversation context · ~${Math.round(h.usageNow() / 1000)}k tokens]`);
  parts.push(request);
  return parts.join('\n\n');
}

function mkDiff(file: string, hunks: { at: number; context: string[]; remove: string[]; add: string[] }[]): string {
  const lines: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const h of hunks) {
    const oldCount = h.context.length + h.remove.length;
    const newCount = h.context.length + h.add.length;
    lines.push(`@@ -${h.at},${oldCount} +${h.at},${newCount} @@`);
    const half = Math.ceil(h.context.length / 2);
    for (const c of h.context.slice(0, half)) lines.push(` ${c}`);
    for (const r of h.remove) lines.push(`-${r}`);
    for (const a of h.add) lines.push(`+${a}`);
    for (const c of h.context.slice(half)) lines.push(` ${c}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- outputs

function testOutput(project: string, opts: { fail?: string } = {}): { stdout: string; exitCode: number } {
  const passFiles = rnd(2, 5);
  const tests = rnd(8, 34);
  if (opts.fail) {
    return {
      exitCode: 1,
      stdout: [
        ` RUN  v3.2.1 ${project}`,
        '',
        ` ❯ ${opts.fail} (1 failed)`,
        `   × ${opts.fail.replace(/\.test\.[jt]sx?$/, '')} > handles edge case`,
        '     AssertionError: expected 24.9 to equal 24.90',
        `      ❯ ${opts.fail}:31:29`,
        '',
        ` Test Files  1 failed | ${passFiles} passed (${passFiles + 1})`,
        `      Tests  1 failed | ${tests} passed (${tests + 1})`,
        `   Duration  ${(Math.random() * 2 + 0.6).toFixed(2)}s`,
      ].join('\n'),
    };
  }
  return {
    exitCode: 0,
    stdout: [
      ` RUN  v3.2.1 ${project}`,
      '',
      ...Array.from({ length: passFiles }, (_, i) => ` ✓ src/__tests__/suite-${i + 1}.test.ts (${rnd(2, 9)} tests) ${rnd(4, 38)}ms`),
      '',
      ` Test Files  ${passFiles} passed (${passFiles})`,
      `      Tests  ${tests} passed (${tests})`,
      `   Duration  ${(Math.random() * 1.6 + 0.4).toFixed(2)}s`,
    ].join('\n'),
  };
}

function buildOutput(): string {
  return [
    'vite v7.1.3 building for production...',
    `✓ ${rnd(120, 420)} modules transformed.`,
    `dist/index.html                 ${(Math.random() * 2 + 0.4).toFixed(2)} kB`,
    `dist/assets/index-B${rnd(100, 999)}x.css  ${(Math.random() * 40 + 8).toFixed(2)} kB │ gzip: ${(Math.random() * 8 + 2).toFixed(2)} kB`,
    `dist/assets/index-D${rnd(100, 999)}k.js  ${(Math.random() * 300 + 80).toFixed(2)} kB │ gzip: ${(Math.random() * 90 + 30).toFixed(2)} kB`,
    `✓ built in ${(Math.random() * 3 + 0.8).toFixed(2)}s`,
  ].join('\n');
}

function grepMatches(files: string[], term: string): SearchMatch[] {
  return pickN(files, rnd(2, 4)).map((f) => ({
    path: f,
    line: rnd(8, 160),
    preview: `…${term} referenced here (${f.split('/').pop()})…`,
  }));
}

// ---------------------------------------------------------------- flows

export async function buildScenario(h: Run, userText: string): Promise<void> {
  const files = sampleFiles(h.project.rootPath);
  const changeVerb = /\b(fix|add|implement|refactor|redesign|rework|make|create|build|update|change|remove|delete|improve|support|translate|migrate|rename|extract|convert)\b/i.test(userText);
  const commandish = /\b(run|execute|npm|pnpm|yarn|pytest|vitest|jest)\b.*\b(test|tests|build|lint|check)\b|^run\b|\brun the\b/i.test(userText);
  if (commandish && !changeVerb) return commandFlow(h, userText, files);
  if (changeVerb) return changeFlow(h, userText, files);
  return investigateFlow(h, userText, files);
}

// --- investigation: read-only, no reviewer ---------------------------------

async function investigateFlow(h: Run, userText: string, files: string[]): Promise<void> {
  h.status('Looking into it…');
  await h.sleep(rnd(400, 800));

  const reads = pickN(files, rnd(2, 4));
  for (const f of reads) {
    h.read(f, fileLines(h.project.rootPath, f));
    await h.sleep(rnd(150, 420));
  }
  const term = keywords(userText)[0] ?? 'handler';
  h.search(term, 'rg', grepMatches(files, term));
  await h.sleep(rnd(300, 700));

  const focus = reads[0] ?? files[0];
  const answer = [
    `Here's what I found about **${userText.replace(/\s+/g, ' ').trim().replace(/[.?!]$/, '')}**:`,
    '',
    `The relevant logic lives in \`${focus}\`. It ${chance(0.5) ? 'delegates to' : 'is wired together with'} \`${reads[1] ?? files[1]}\`, and the flow works like this:`,
    '',
    `1. The entry point in \`${focus}\` receives the call and validates its input.`,
    `2. Matching on \`${term}\` happens ${chance(0.5) ? 'via a lookup table' : 'in a switch over the request type'} before any work starts.`,
    `3. The result is shaped for the UI right before returning — that's the place to change if you want different output.`,
    '',
    `Nothing here modifies files or global state, so it's safe to experiment. If you want me to change the behavior, just say how.`,
  ].join('\n');

  await h.aiCall({
    role: 'builder',
    prompt: composePrompt(h, 'builder', `Request:\n${userText}`),
    responseText: answer,
    durationMs: rnd(2400, 4600),
    usage: {
      inputTokens: h.usageNow() + reads.length * 1400 + 900,
      outputTokens: Math.ceil(answer.length / 4) + rnd(300, 700),
    },
  });
  await h.assistant(answer);
}

// --- command flow: run something, report ------------------------------------

async function commandFlow(h: Run, userText: string, files: string[]): Promise<void> {
  h.status('Running…');
  await h.sleep(rnd(300, 600));

  const wantsBuild = /build/i.test(userText);
  const failing = chance(0.35) ? pickN(files.filter((f) => /\.[jt]sx?$/.test(f)), 1)[0] : undefined;
  const failName = failing ? failing.replace(/\.([jt]sx?)$/, '.test.$1') : undefined;

  if (wantsBuild) {
    await h.command('npm run build', { stdout: buildOutput(), durationMs: rnd(2800, 6400) });
  } else {
    const t = testOutput(h.project.rootPath, failName ? { fail: failName } : {});
    await h.command('npm test', { stdout: t.stdout, exitCode: t.exitCode, durationMs: rnd(2200, 5200) });
  }

  const summary = failName
    ? [
      `I ran the tests — **one failure**:`,
      '',
      `- \`${failName}\` › *handles edge case* — an assertion about number formatting: \`expected 24.9 to equal 24.90\`.`,
      '',
      `Everything else passes. The failing assertion points at a formatting/rounding mismatch rather than broken logic. Want me to fix it?`,
    ].join('\n')
    : wantsBuild
      ? `The production build completes cleanly — no type errors, no warnings that matter. Output sizes look normal for this project.`
      : `All tests pass. Nothing flaky, and the run completed quickly — no action needed.`;

  await h.aiCall({
    role: 'builder',
    prompt: composePrompt(h, 'builder', `Request:\n${userText}`),
    responseText: summary,
    durationMs: rnd(1800, 3200),
    usage: { inputTokens: h.usageNow() + 1100, outputTokens: Math.ceil(summary.length / 4) + rnd(200, 500) },
  });
  await h.assistant(summary);
}

// --- change flow: full builder → reviewer loop ------------------------------

async function changeFlow(h: Run, userText: string, files: string[]): Promise<void> {
  h.status('Inspecting project…');
  await h.sleep(rnd(400, 900));

  const reads = pickN(files, rnd(3, 5));
  for (const f of reads) {
    h.read(f, fileLines(h.project.rootPath, f));
    await h.sleep(rnd(140, 400));
  }
  const term = keywords(userText)[0] ?? 'render';
  h.search(term, 'rg', grepMatches(files, term));
  await h.sleep(rnd(250, 600));

  const changeable = (f: string) => /\.[jt]sx?$|\.css$|\.vue$|\.py$/.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f);
  const targets = pickN(reads.filter(changeable), 2);
  const fallbackTargets = files.filter(changeable);
  const primary = targets[0] ?? fallbackTargets[0] ?? files[0];
  const secondary = targets[1] ?? fallbackTargets.find((f) => f !== primary) ?? files[1] ?? primary;

  // Builder call (the work happens "inside" it in reality; the app shows it as
  // a sibling row per the product spec)
  const req = userText.replace(/\s+/g, ' ').trim().replace(/[.?!]$/, '');
  const answer = [
    `Done — **${req}** is implemented.`,
    '',
    `What changed:`,
    '',
    `- \`${primary}\` — the main change: the behavior now handles the case you described, with input validated before use.`,
    `- \`${secondary}\` — a small follow-up so the two stay consistent.`,
    '',
    `I ran the test suite afterwards and it passes. The change is deliberately narrow — no refactors beyond what the request needed.`,
  ].join('\n');

  await h.aiCall({
    role: 'builder',
    prompt: composePrompt(h, 'builder', `Request:\n${userText}`),
    responseText: answer,
    durationMs: rnd(3000, 4800),
    usage: {
      inputTokens: h.usageNow() + reads.length * 1400 + 1500,
      outputTokens: Math.ceil(answer.length / 4) + rnd(500, 1100),
    },
  });
  if (h.stopped) return;

  const changes: ChangedFile[] = [
    {
      path: primary,
      additions: 9,
      deletions: 3,
      diff: mkDiff(primary, [{
        at: rnd(14, 60),
        context: ['export function handle(input) {', '  const value = normalize(input);', '  return value;', '}'],
        remove: ['  const value = normalize(input);'],
        add: [
          '  if (input == null) {',
          "    throw new TypeError('input is required');",
          '  }',
          '  const value = normalize(input);',
          '  audit.record(value);',
        ],
      }]),
    },
    {
      path: secondary,
      additions: 4,
      deletions: 1,
      diff: mkDiff(secondary, [{
        at: rnd(6, 40),
        context: ['const config = {', '  retries: 2,', '};'],
        remove: ['  retries: 2,'],
        add: ['  retries: 2,', '  validateInput: true,'],
      }]),
    },
  ];
  h.change(changes);
  await h.sleep(rnd(300, 700));

  const firstTestFails = chance(0.3);
  if (firstTestFails) {
    const failName = primary.replace(/\.([jt]sx?)$/, '.test.$1');
    const t = testOutput(h.project.rootPath, { fail: failName });
    await h.command('npm test', { stdout: t.stdout, exitCode: t.exitCode, durationMs: rnd(2400, 4800) });
    h.status('A test failed — fixing it…');
    await h.sleep(rnd(500, 1000));
    h.change([{
      path: primary,
      additions: 2,
      deletions: 2,
      diff: mkDiff(primary, [{
        at: rnd(20, 70),
        context: ['  return format(value);'],
        remove: ['  return format(value);'],
        add: ['  return format(value, { decimals: 2 });'],
      }]),
    }]);
    changes[0].additions += 2;
    changes[0].deletions += 2;
  }
  const pass = testOutput(h.project.rootPath);
  await h.command('npm test', { stdout: pass.stdout, exitCode: 0, durationMs: rnd(2000, 4400) });

  await h.assistant(answer);
  if (h.stopped) return;

  // ---- review loop (only when enabled and files changed)
  if (!h.settings.roles.reviewer.enabled) return;

  await reviewLoop(h, userText, changes);
}

async function reviewLoop(h: Run, userText: string, changes: ChangedFile[]): Promise<void> {
  const primary = changes[0].path;
  h.status('Reviewer is checking the result…');
  await h.sleep(rnd(400, 800));

  const round1Findings: Finding[] = [
    {
      severity: 'major',
      title: 'Null-guard throws where callers expect a soft failure',
      file: primary,
      line: rnd(18, 60),
      detail: `The new TypeError propagates to two call sites that previously received undefined and handled it. One of them renders user-facing UI and will now crash on empty input.`,
      recommendation: 'Return early (or a Result) instead of throwing, or update both call sites to catch.',
    },
    {
      severity: 'minor',
      title: 'audit.record called on every invocation',
      file: primary,
      detail: 'The audit call runs in the hot path with no batching; the original request did not ask for auditing.',
      recommendation: 'Drop it or move it behind the existing debug flag.',
    },
  ];

  const hasFindings = chance(0.55);
  const reviewerReply = (verdict: 'pass' | 'findings', items: Finding[], round: number) => verdict === 'pass'
    ? `PASS — the implementation matches the request. I checked the changed files, ran a read-only inspection of call sites, and found no regressions or unrelated modifications. (round ${round})`
    : items.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : ''}\n   ${f.detail}`).join('\n');

  const reviewerCall = async (round: number, verdict: 'pass' | 'findings', items: Finding[], finalRepairNotReviewed?: boolean) => {
    await h.aiCall({
      role: 'reviewer',
      prompt: composePrompt(h, 'reviewer', `Original request:\n${userText}\n\nEvaluate the current project state (round ${round}). Changed files:\n${changes.map((c) => `- ${c.path}`).join('\n')}`),
      responseText: reviewerReply(verdict, items, round),
      durationMs: rnd(2600, 4600),
      usage: { inputTokens: rnd(7000, 14000), outputTokens: rnd(250, 800) },
    });
    h.findings({ verdict, round, items, ...(finalRepairNotReviewed ? { finalRepairNotReviewed } : {}) });
  };

  await reviewerCall(1, hasFindings ? 'findings' : 'pass', hasFindings ? round1Findings : []);
  if (!hasFindings || h.stopped) return;

  // ---- repair round
  h.status('Repairing based on reviewer findings…');
  await h.sleep(rnd(400, 900));
  const repairText = `Addressed both findings: the null-guard now returns early instead of throwing (call sites keep their existing behavior), and the audit call is gone from the hot path.`;
  await h.aiCall({
    role: 'builder',
    prompt: composePrompt(h, 'builder', `Reviewer findings to repair:\n${reviewerReply('findings', round1Findings, 1)}`),
    responseText: repairText,
    durationMs: rnd(2600, 4200),
    usage: { inputTokens: h.usageNow() + 2400, outputTokens: rnd(500, 1000) },
  });
  h.change([{
    path: primary,
    additions: 3,
    deletions: 5,
    diff: mkDiff(primary, [{
      at: rnd(16, 58),
      context: ['export function handle(input) {', '  const value = normalize(input);'],
      remove: ['  if (input == null) {', "    throw new TypeError('input is required');", '  }', '  audit.record(value);'],
      add: ['  if (input == null) return undefined;'],
    }]),
  }]);
  const pass2 = testOutput(h.project.rootPath);
  await h.command('npm test', { stdout: pass2.stdout, exitCode: 0, durationMs: rnd(1800, 3800) });
  await h.assistant(repairText);
  if (h.stopped) return;

  // ---- second (final) review
  const round2Pass = chance(0.75);
  if (round2Pass) {
    await reviewerCall(2, 'pass', []);
    return;
  }
  const round2Findings: Finding[] = [{
    severity: 'minor',
    title: 'Early return changes the declared return type',
    file: primary,
    detail: 'The function can now return undefined but its signature still promises a value; one strict-mode caller will fail typecheck.',
    recommendation: 'Widen the return type or coalesce at the boundary.',
  }];
  await reviewerCall(2, 'findings', round2Findings, true);
  if (h.stopped) return;

  // ---- final repair — never re-reviewed (hard product rule)
  h.status('Final repair…');
  await h.sleep(rnd(300, 700));
  const finalText = [
    `Final repair applied — the return type is widened and the one strict-mode caller coalesces the value.`,
    '',
    `**This final repair was not re-reviewed.** The review loop is capped at two rounds; if you want another pass, just ask.`,
  ].join('\n');
  await h.aiCall({
    role: 'final_repair',
    prompt: composePrompt(h, 'final_repair', `Remaining findings:\n${reviewerReply('findings', round2Findings, 2)}`),
    responseText: finalText,
    durationMs: rnd(2000, 3600),
    usage: { inputTokens: h.usageNow() + 1600, outputTokens: rnd(300, 700) },
  });
  h.change([{
    path: primary,
    additions: 2,
    deletions: 2,
    diff: mkDiff(primary, [{
      at: rnd(10, 44),
      context: ['export function handle(input) {'],
      remove: ['export function handle(input) {'],
      add: ['export function handle(input): Value | undefined {'],
    }]),
  }]);
  const pass3 = testOutput(h.project.rootPath);
  await h.command('npm test', { stdout: pass3.stdout, exitCode: 0, durationMs: rnd(1600, 3200) });
  await h.assistant(finalText);
}
