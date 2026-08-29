import { db } from '../db';
import { config } from '../config';
import path from 'node:path';

import { insertChatRow, Timeline, seedPrompt, CLAUDE_CLI, CODEX_CLI } from './seedUtil';

const P = (name: string) => path.join(config.projectsDir, name);

// ---------------------------------------------------------------------------
// A · customer-portal · full two-round review cycle
// ---------------------------------------------------------------------------
export function seedCheckoutChat(projectId: string, start: number): void {
  const chatId = insertChatRow(projectId, 'Fix checkout total rounding', start);
  const tl = new Timeline(chatId, start);
  const dir = P('customer-portal');
  tl.runId = 'seed-run-a';

  tl.ev('user_message', { text: 'The checkout total sometimes shows three decimals (e.g. $24.997). Fix the rounding so totals always display correct 2-decimal currency amounts.' }, 0);
  tl.ev('run', { phase: 'started' }, 900);
  tl.ev('status', { text: 'Inspecting project…' }, 400);
  tl.ev('file_read', { path: 'src/checkout/total.ts', lines: 21 }, 700);
  tl.ev('file_read', { path: 'src/checkout/cart.ts', lines: 29 }, 420);
  tl.ev('file_read', { path: 'src/components/CheckoutSummary.tsx', lines: 20 }, 380);
  tl.ev('search', {
    query: 'toFixed', tool: 'rg', matches: [
      { path: 'src/checkout/total.ts', line: 14, preview: 'return (subtotal * (1 - discountPct / 100)).toFixed(3)' },
      { path: 'src/components/CheckoutSummary.tsx', line: 11, preview: '<dd data-testid="grand-total">${total.toFixed(2)}</dd>' },
    ],
  }, 600);

  const builderAnswer = [
    'Fixed — checkout totals are now computed in **integer cents** and formatted with `Intl.NumberFormat`, so a third decimal can no longer appear.',
    '',
    'What was wrong: `lineTotal` multiplied floats (`unitPrice * quantity * discount`) and the UI formatted the raw float. `8.33 × 3` produced `24.990000000000002`, and the discount path truncated with `toFixed(3)`.',
    '',
    'Changes:',
    '- `src/checkout/total.ts` — money math rewritten in cents (`lineTotalCents`, `cartTotalCents`), plus a `formatCents` helper using `Intl.NumberFormat`.',
    '- `src/components/CheckoutSummary.tsx` — renders `formatCents(total)` instead of `$${total.toFixed(2)}`.',
    '',
    'One existing test asserted the buggy behavior; I updated it, and the suite now passes (10/10).',
  ].join('\n');

  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'customer-portal', dir, 3, 'Request:\nThe checkout total sometimes shows three decimals (e.g. $24.997). Fix the rounding so totals always display correct 2-decimal currency amounts.') },
    response: { text: builderAnswer, usage: { inputTokens: 14_200, outputTokens: 1_030 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 4_120, simulated: true,
  }, 4_300);

  tl.ev('file_change', {
    files: [
      {
        path: 'src/checkout/total.ts', additions: 12, deletions: 6,
        diff: [
          '--- a/src/checkout/total.ts',
          '+++ b/src/checkout/total.ts',
          '@@ -1,10 +1,17 @@',
          " import type { CartLine } from './cart';",
          ' ',
          '-export function lineTotal(line: CartLine): number {',
          '-  return line.unitPrice * line.quantity * (1 - line.discountPct / 100);',
          '+/** All money math happens in integer cents to avoid float drift. */',
          '+export function lineTotalCents(line: CartLine): number {',
          '+  const unitCents = Math.round(line.unitPrice * 100);',
          '+  const discounted = Math.round(unitCents * (1 - line.discountPct / 100));',
          '+  return discounted * line.quantity;',
          ' }',
          ' ',
          '-export function cartTotal(lines: CartLine[]): number {',
          '-  return lines.reduce((sum, line) => sum + lineTotal(line), 0);',
          '+export function cartTotalCents(lines: CartLine[]): number {',
          '+  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);',
          '+}',
          '+',
          '+export function formatCents(cents: number, locale = \'en-US\', currency = \'USD\'): string {',
          '+  return new Intl.NumberFormat(locale, { style: \'currency\', currency }).format(cents / 100);',
          ' }',
        ].join('\n'),
      },
      {
        path: 'src/components/CheckoutSummary.tsx', additions: 3, deletions: 3,
        diff: [
          '--- a/src/components/CheckoutSummary.tsx',
          '+++ b/src/components/CheckoutSummary.tsx',
          '@@ -1,8 +1,8 @@',
          "-import { cartTotal } from '../checkout/total';",
          "+import { cartTotalCents, formatCents } from '../checkout/total';",
          " import type { Cart } from '../checkout/cart';",
          ' ',
          ' export function CheckoutSummary({ cart }: { cart: Cart }) {',
          '-  const total = cartTotal(cart.lines);',
          '+  const total = cartTotalCents(cart.lines);',
          '@@ -9,7 +9,7 @@',
          '         <dt>Total</dt>',
          '-        <dd data-testid="grand-total">${total.toFixed(2)}</dd>',
          '+        <dd data-testid="grand-total">{formatCents(total)}</dd>',
        ].join('\n'),
      },
    ],
  }, 800);

  tl.ev('command', {
    command: 'npm test', cwd: dir,
    stdout: [
      ' RUN  v3.2.1 ' + dir,
      '',
      ' ❯ src/checkout/total.test.ts (1 failed)',
      '   × checkout totals > keeps legacy float behaviour',
      '     AssertionError: expected 2499 to equal 24.990000000000002',
      '      ❯ src/checkout/total.test.ts:12:41',
      '',
      ' Test Files  1 failed | 2 passed (3)',
      '      Tests  1 failed | 9 passed (10)',
      '   Duration  1.24s',
    ].join('\n'),
    stderr: '', exitCode: 1, durationMs: 3_180, status: 'done',
  }, 3_400);

  tl.ev('status', { text: 'One test asserted the old float behavior — updating it…' }, 700);
  tl.ev('file_change', {
    files: [{
      path: 'src/checkout/total.test.ts', additions: 4, deletions: 4,
      diff: [
        '--- a/src/checkout/total.test.ts',
        '+++ b/src/checkout/total.test.ts',
        '@@ -9,8 +9,8 @@',
        "-  it('keeps legacy float behaviour', () => {",
        "-    expect(lineTotal({ sku: 'a', unitPrice: 8.33, quantity: 3, discountPct: 0 })).toBe(24.990000000000002);",
        "+  it('rounds per line in cents', () => {",
        "+    expect(lineTotalCents({ sku: 'a', unitPrice: 8.33, quantity: 3, discountPct: 0 })).toBe(2499);",
        '   });',
      ].join('\n'),
    }],
  }, 900);
  tl.ev('command', {
    command: 'npm test', cwd: dir,
    stdout: [
      ' RUN  v3.2.1 ' + dir,
      '',
      ' ✓ src/checkout/total.test.ts (4 tests) 11ms',
      ' ✓ src/checkout/cart.test.ts (3 tests) 8ms',
      ' ✓ src/components/summary.test.tsx (3 tests) 21ms',
      '',
      ' Test Files  3 passed (3)',
      '      Tests  10 passed (10)',
      '   Duration  1.08s',
    ].join('\n'),
    stderr: '', exitCode: 0, durationMs: 2_890, status: 'done',
  }, 3_000);

  tl.ev('assistant_message', { text: builderAnswer }, 1_600);

  // review round 1 → findings
  tl.ev('status', { text: 'Reviewer is checking the result…' }, 700);
  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'customer-portal', dir, 3, 'Original request:\nFix the checkout rounding so totals always display 2-decimal currency amounts.\n\nEvaluate the current project state (round 1).') },
    response: {
      text: [
        '1. [major] Coupon path still does float math before rounding — src/checkout/discount.ts:9',
        '   applyCoupon computes `total * (1 - coupon.pct / 100)` on the float total and only then converts to cents, so a 15% coupon on $8.33×3 reproduces the third decimal. The new lineTotalCents path is bypassed entirely.',
        '2. [minor] Locale hard-coded — src/checkout/total.ts:17',
        "   formatCents defaults to en-US; the portal already exposes the shopper's locale in session.locale.",
      ].join('\n'),
      usage: { inputTokens: 9_420, outputTokens: 410 },
    },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_240, simulated: true,
  }, 3_400);
  tl.ev('findings', {
    verdict: 'findings', round: 1, items: [
      {
        severity: 'major', title: 'Coupon path still does float math before rounding',
        file: 'src/checkout/discount.ts', line: 9,
        detail: 'applyCoupon multiplies the float total and converts to cents afterwards, reproducing the third-decimal bug for discounted carts. The new cents-based path is bypassed.',
        recommendation: 'Apply the coupon percentage in cents inside cartTotalCents (or a dedicated cents helper) so every money operation stays integer.',
      },
      {
        severity: 'minor', title: 'Locale hard-coded to en-US',
        file: 'src/checkout/total.ts', line: 17,
        detail: "formatCents defaults to en-US even though the shopper's locale is available in the session.",
        recommendation: 'Thread session.locale through CheckoutSummary.',
      },
    ],
  }, 300);

  // repair
  tl.ev('status', { text: 'Repairing based on reviewer findings…' }, 800);
  const repairText = 'Both findings addressed: coupon percentages are now applied in cents inside `cartTotalCents`, and `CheckoutSummary` passes `session.locale` to `formatCents`. Tests extended for the coupon path (12/12 pass).';
  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'customer-portal', dir, 21, 'Reviewer findings to repair:\n1. [major] Coupon path still does float math before rounding — src/checkout/discount.ts:9\n2. [minor] Locale hard-coded — src/checkout/total.ts:17') },
    response: { text: repairText, usage: { inputTokens: 21_900, outputTokens: 720 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_760, simulated: true,
  }, 3_900);
  tl.ev('file_change', {
    files: [{
      path: 'src/checkout/discount.ts', additions: 7, deletions: 4,
      diff: [
        '--- a/src/checkout/discount.ts',
        '+++ b/src/checkout/discount.ts',
        '@@ -5,9 +5,12 @@',
        '-export function applyCoupon(totalDollars: number, coupon: Coupon): number {',
        '-  const discounted = totalDollars * (1 - coupon.pct / 100);',
        '-  return Math.round(discounted * 100) / 100;',
        '+export function applyCouponCents(totalCents: number, coupon: Coupon): number {',
        '+  if (coupon.pct <= 0) return totalCents;',
        '+  return Math.round(totalCents * (1 - coupon.pct / 100));',
        ' }',
      ].join('\n'),
    }],
  }, 700);
  tl.ev('command', {
    command: 'npm test', cwd: dir,
    stdout: ' RUN  v3.2.1 ' + dir + '\n\n ✓ src/checkout/total.test.ts (5 tests) 12ms\n ✓ src/checkout/discount.test.ts (4 tests) 6ms\n ✓ src/checkout/cart.test.ts (3 tests) 9ms\n\n Test Files  3 passed (3)\n      Tests  12 passed (12)\n   Duration  1.12s',
    stderr: '', exitCode: 0, durationMs: 2_640, status: 'done',
  }, 2_800);
  tl.ev('assistant_message', { text: repairText }, 1_000);

  // review round 2 → pass
  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'customer-portal', dir, 24, 'Original request:\nFix the checkout rounding.\n\nEvaluate the current project state (round 2).') },
    response: { text: 'PASS — money math is integer-cents end to end (lines, cart, coupon), formatting is locale-aware, tests cover the previously broken discount path, and no unrelated files changed.', usage: { inputTokens: 10_180, outputTokens: 240 } },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 2_980, simulated: true,
  }, 3_100);
  tl.ev('findings', { verdict: 'pass', round: 2, items: [] }, 300);
  tl.ev('run', { phase: 'finished' }, 200);
  tl.finish();
}

// ---------------------------------------------------------------------------
// B · customer-portal · small change, review passes first round
// ---------------------------------------------------------------------------
export function seedLoginChat(projectId: string, start: number): void {
  const chatId = insertChatRow(projectId, 'Improve login validation', start);
  const tl = new Timeline(chatId, start);
  const dir = P('customer-portal');
  tl.runId = 'seed-run-b';

  tl.ev('user_message', { text: 'Improve the login form validation: inline errors instead of alerts, and disable the submit button while the request is in flight.' }, 0);
  tl.ev('run', { phase: 'started' }, 800);
  tl.ev('status', { text: 'Inspecting project…' }, 400);
  tl.ev('file_read', { path: 'src/pages/Login.tsx', lines: 31 }, 600);
  tl.ev('file_read', { path: 'src/api/client.ts', lines: 22 }, 350);

  const answer = [
    'Done. The login form now validates inline and can\'t be double-submitted:',
    '',
    '- `src/pages/Login.tsx` — errors render under the fields with `role="alert"` (screen-reader friendly) instead of `window.alert`; a `pending` state disables the button and shows "Signing in…" while the request runs.',
    '- Validation happens on submit *and* clears as you type, so stale errors don\'t linger.',
    '',
    'The existing tests still pass; I added one for the pending state (11/11).',
  ].join('\n');

  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'customer-portal', dir, 3, 'Request:\nImprove the login form validation: inline errors instead of alerts, and disable the submit button while the request is in flight.') },
    response: { text: answer, usage: { inputTokens: 11_300, outputTokens: 860 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_480, simulated: true,
  }, 3_600);

  tl.ev('file_change', {
    files: [{
      path: 'src/pages/Login.tsx', additions: 14, deletions: 5,
      diff: [
        '--- a/src/pages/Login.tsx',
        '+++ b/src/pages/Login.tsx',
        '@@ -4,16 +4,24 @@',
        ' export function Login() {',
        "   const [email, setEmail] = useState('');",
        "   const [password, setPassword] = useState('');",
        '+  const [error, setError] = useState<string | null>(null);',
        '+  const [pending, setPending] = useState(false);',
        ' ',
        '   async function submit(e: React.FormEvent) {',
        '     e.preventDefault();',
        "-    if (!email.includes('@')) return alert('bad email');",
        "+    if (!email.includes('@')) return setError('Enter a valid email address.');",
        "+    if (password.length < 8) return setError('Password must be at least 8 characters.');",
        '+    setPending(true);',
        '     try {',
        '       await api.login(email, password);',
        "       location.href = '/account';",
        '+    } catch {',
        "+      setError('Email or password is incorrect.');",
        '+    } finally {',
        '+      setPending(false);',
        '     }',
        '   }',
        '@@ -24,6 +32,7 @@',
        '-      <button type="submit">Sign in</button>',
        '+      {error && <p id="login-error" role="alert">{error}</p>}',
        '+      <button type="submit" disabled={pending}>{pending ? \'Signing in…\' : \'Sign in\'}</button>',
      ].join('\n'),
    }],
  }, 700);

  tl.ev('command', {
    command: 'npm test -- src/pages', cwd: dir,
    stdout: ' RUN  v3.2.1 ' + dir + '\n\n ✓ src/pages/login.test.tsx (11 tests) 64ms\n\n Test Files  1 passed (1)\n      Tests  11 passed (11)\n   Duration  0.92s',
    stderr: '', exitCode: 0, durationMs: 2_310, status: 'done',
  }, 2_500);

  tl.ev('assistant_message', { text: answer }, 1_400);
  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'customer-portal', dir, 3, 'Original request:\nImprove the login form validation.\n\nEvaluate the current project state (round 1).') },
    response: { text: 'PASS — inline errors are accessible (role=alert, aria-describedby), the pending state prevents double submission, no regressions in the auth flow, and the change stays inside the login page.', usage: { inputTokens: 8_240, outputTokens: 210 } },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 2_760, simulated: true,
  }, 2_900);
  tl.ev('findings', { verdict: 'pass', round: 1, items: [] }, 300);
  tl.ev('run', { phase: 'finished' }, 200);
  tl.finish();
}

// ---------------------------------------------------------------------------
// C · customer-portal · read-only investigation (no reviewer)
// ---------------------------------------------------------------------------
export function seedSlowDashboardChat(projectId: string, start: number): void {
  const chatId = insertChatRow(projectId, 'Why is the dashboard slow?', start);
  const tl = new Timeline(chatId, start);
  const dir = P('customer-portal');
  tl.runId = 'seed-run-c';

  tl.ev('user_message', { text: 'Why is the account dashboard so slow to load? It takes 3–4 seconds before anything renders.' }, 0);
  tl.ev('run', { phase: 'started' }, 700);
  tl.ev('status', { text: 'Looking into it…' }, 500);
  tl.ev('file_read', { path: 'src/pages/Dashboard.tsx', lines: 148 }, 800);
  tl.ev('file_read', { path: 'src/api/client.ts', lines: 22 }, 420);
  tl.ev('search', {
    query: 'useEffect', tool: 'rg', matches: [
      { path: 'src/pages/Dashboard.tsx', line: 24, preview: 'useEffect(() => { void loadOrders(); }, []);' },
      { path: 'src/pages/Dashboard.tsx', line: 31, preview: 'useEffect(() => { void loadRecommendations(); }, [orders]);' },
      { path: 'src/pages/Dashboard.tsx', line: 38, preview: 'useEffect(() => { void loadProfile(); }, [recommendations]);' },
    ],
  }, 700);
  tl.ev('command', {
    command: "rg -n 'await api\\.' src/pages/Dashboard.tsx", cwd: dir,
    stdout: '25:    const orders = await api.orders();\n32:    const recommendations = await api.recommendations(orders.map(o => o.id));\n39:    const profile = await api.profile();\n41:    const stats = await api.stats(profile.id);',
    stderr: '', exitCode: 0, durationMs: 640, status: 'done',
  }, 900);

  const answer = [
    'Found it — the dashboard loads its data as a **waterfall of four sequential requests**, each one gated on the previous:',
    '',
    '1. `orders` loads first (`useEffect` on mount, ~800ms)',
    '2. `recommendations` waits for orders (`useEffect` keyed on `orders`, ~900ms)',
    '3. `profile` waits for recommendations (~700ms)',
    '4. `stats` waits for profile (~800ms)',
    '',
    'That chain alone is ~3.2s before first render, which matches what you\'re seeing. Only step 2 genuinely depends on step 1 — `profile` and `stats` are independent.',
    '',
    '**Fix options** (I haven\'t changed anything yet):',
    '- Parallelize: `Promise.all` for `orders`, `profile`, and `stats`; chain only `recommendations`. Cuts to ~1.7s.',
    '- Render incrementally: show the shell + each card as its data lands, so first paint is immediate.',
    '',
    'Say the word and I\'ll implement either (or both).',
  ].join('\n');

  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'customer-portal', dir, 3, 'Request:\nWhy is the account dashboard so slow to load? It takes 3–4 seconds before anything renders.') },
    response: { text: answer, usage: { inputTokens: 12_600, outputTokens: 940 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 4_050, simulated: true,
  }, 4_200);
  tl.ev('assistant_message', { text: answer }, 1_500);
  tl.ev('run', { phase: 'finished' }, 200);
  tl.finish();
}

// ---------------------------------------------------------------------------
// D · talkbridge · long chat: growth, provider error, applied compaction,
//     post-compaction work — leaves the meter in the warning zone
// ---------------------------------------------------------------------------
export function seedSpanishChat(projectId: string, start: number, end: number): void {
  const chatId = insertChatRow(projectId, 'Add Spanish support', start);
  const tl = new Timeline(chatId, start);
  const dir = P('talkbridge');
  tl.runId = 'seed-run-d1';

  tl.ev('user_message', { text: 'Add Spanish support to talkbridge. All UI strings should come from a translation layer, with English as fallback.' }, 0);
  tl.ev('run', { phase: 'started' }, 800);
  tl.ev('status', { text: 'Inspecting project…' }, 500);
  tl.ev('file_read', { path: 'src/components/Header.tsx', lines: 24 }, 700);
  tl.ev('file_read', { path: 'src/pages/Home.tsx', lines: 11 }, 380);
  tl.ev('file_read', { path: 'src/pages/Settings.tsx', lines: 64 }, 340);
  tl.ev('search', {
    query: 'hardcoded UI strings', tool: 'rg', matches: [
      { path: 'src/components/Header.tsx', line: 9, preview: "<strong>TalkBridge</strong>" },
      { path: 'src/pages/Home.tsx', line: 5, preview: '<h1>Talk to anyone, in any language.</h1>' },
      { path: 'src/pages/Settings.tsx', line: 18, preview: "<label>Notifications</label>" },
    ],
  }, 650);

  const answer1 = [
    'Spanish support is in. I introduced a small i18n layer rather than pulling in a heavy library:',
    '',
    '- `src/i18n/index.ts` — `t(key)` lookup with the current locale, English fallback, and `setLocale` persisting to `localStorage`.',
    '- `src/i18n/en.json` / `src/i18n/es.json` — all 38 UI strings extracted and translated.',
    '- `src/components/Header.tsx` — language `<select>` (English / Español) wired to `setLocale`.',
    '- Every page now renders through `t()` — no hard-coded strings remain (`rg` confirms).',
    '',
    'Build and tests pass. Refresh keeps the chosen language.',
  ].join('\n');

  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'talkbridge', dir, 3, 'Request:\nAdd Spanish support to talkbridge. All UI strings should come from a translation layer, with English as fallback.') },
    response: { text: answer1, usage: { inputTokens: 16_800, outputTokens: 1_240 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 5_820, simulated: true,
  }, 6_000);

  tl.ev('file_change', {
    files: [
      {
        path: 'src/i18n/index.ts', additions: 19, deletions: 0,
        diff: '--- /dev/null\n+++ b/src/i18n/index.ts\n@@ -0,0 +1,19 @@\n+import en from \'./en.json\';\n+import es from \'./es.json\';\n+\n+const dictionaries = { en, es } as const;\n+export type Locale = keyof typeof dictionaries;\n+\n+let current: Locale = (localStorage.getItem(\'locale\') as Locale) ?? \'en\';\n+\n+export function t(key: keyof typeof en): string {\n+  return dictionaries[current][key] ?? dictionaries.en[key] ?? key;\n+}\n+\n+export function setLocale(locale: Locale): void {\n+  current = locale;\n+  localStorage.setItem(\'locale\', locale);\n+  document.documentElement.lang = locale;\n+}',
      },
      {
        path: 'src/i18n/es.json', additions: 40, deletions: 0,
        diff: '--- /dev/null\n+++ b/src/i18n/es.json\n@@ -0,0 +1,40 @@\n+{\n+  "app.title": "TalkBridge",\n+  "nav.home": "Inicio",\n+  "nav.rooms": "Salas",\n+  "nav.settings": "Ajustes",\n+  "home.welcome": "Habla con cualquiera, en cualquier idioma.",\n+  "home.start": "Iniciar una conversación",\n+  …',
      },
      {
        path: 'src/components/Header.tsx', additions: 11, deletions: 4,
        diff: '--- a/src/components/Header.tsx\n+++ b/src/components/Header.tsx\n@@ -1,12 +1,19 @@\n+import { setLocale, t, type Locale } from \'../i18n\';\n+\n+const locales: { value: Locale; label: string }[] = [\n+  { value: \'en\', label: \'English\' },\n+  { value: \'es\', label: \'Español\' },\n+];\n \n export function Header() {\n   return (\n     <header className="app-header">\n-      <strong>TalkBridge</strong>\n+      <strong>{t(\'app.title\')}</strong>\n+      <select aria-label={t(\'settings.language\')} onChange={(e) => setLocale(e.target.value as Locale)}>\n+        {locales.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}\n+      </select>',
      },
    ],
  }, 900);

  tl.ev('command', {
    command: 'npm run build', cwd: dir,
    stdout: 'vite v7.1.3 building for production...\n✓ 214 modules transformed.\ndist/index.html                 0.63 kB\ndist/assets/index-Bx41k.css    24.18 kB │ gzip: 5.22 kB\ndist/assets/index-Dk93m.js    182.44 kB │ gzip: 58.71 kB\n✓ built in 2.41s',
    stderr: '', exitCode: 0, durationMs: 4_100, status: 'done',
  }, 4_300);
  tl.ev('assistant_message', { text: answer1 }, 1_800);

  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'talkbridge', dir, 3, 'Original request:\nAdd Spanish support.\n\nEvaluate the current project state (round 1).') },
    response: { text: 'PASS — all rendered strings route through t(), the es.json dictionary is complete against en.json (38/38 keys), fallback works when a key is missing, and the locale survives reload. No unrelated changes.', usage: { inputTokens: 11_030, outputTokens: 260 } },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_310, simulated: true,
  }, 3_500);
  tl.ev('findings', { verdict: 'pass', round: 1, items: [] }, 300);
  tl.ev('run', { phase: 'finished' }, 200);

  // ---- day 2: more work, a provider hiccup, growing context
  tl.t = start + 20 * 3600_000;
  tl.runId = 'seed-run-d2';
  tl.ev('user_message', { text: 'Great. Also translate the settings page, the email templates, and all toast messages. Keep the translation keys consistent with the existing naming scheme.' }, 0);
  tl.ev('run', { phase: 'started' }, 700);
  tl.ev('status', { text: 'Extending the translation layer…' }, 500);
  tl.ev('file_read', { path: 'src/pages/Settings.tsx', lines: 64 }, 600);
  tl.ev('file_read', { path: 'src/emails/welcome.tsx', lines: 88 }, 500);
  tl.ev('file_read', { path: 'src/lib/toast.ts', lines: 41 }, 400);

  tl.ev('error', {
    message: 'Claude Code CLI call failed — connection reset while streaming the response',
    detail: 'exit code 1 after 42s · stream ended mid-message · the call was retried once and succeeded',
    source: 'builder', retryable: true,
  }, 42_000);
  tl.ev('status', { text: 'Retrying the Builder call…' }, 600);

  const answer2 = [
    'All three areas are translated now:',
    '',
    '- `src/pages/Settings.tsx` — 14 new keys under `settings.*`.',
    '- `src/emails/*.tsx` — templates take a `locale` prop; subjects and bodies pull from `emails.*` keys.',
    '- `src/lib/toast.ts` — toasts accept keys instead of raw strings; 9 call sites updated.',
    '',
    '`es.json` grew from 38 to 74 keys, every one translated (no English leaking through). Build passes.',
  ].join('\n');
  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'talkbridge', dir, 27, 'Request:\nAlso translate the settings page, the email templates, and all toast messages.') },
    response: { text: answer2, usage: { inputTokens: 31_400, outputTokens: 1_580 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 7_240, simulated: true,
  }, 7_400);
  tl.ev('file_change', {
    files: [
      { path: 'src/pages/Settings.tsx', additions: 18, deletions: 14, diff: '--- a/src/pages/Settings.tsx\n+++ b/src/pages/Settings.tsx\n@@ -12,9 +12,9 @@\n-      <h1>Settings</h1>\n+      <h1>{t(\'settings.title\')}</h1>\n@@ -18,7 +18,7 @@\n-      <label>Notifications</label>\n+      <label>{t(\'settings.notifications\')}</label>\n…' },
      { path: 'src/emails/welcome.tsx', additions: 12, deletions: 9, diff: '--- a/src/emails/welcome.tsx\n+++ b/src/emails/welcome.tsx\n@@ -3,8 +3,10 @@\n-export function WelcomeEmail({ name }: Props) {\n+export function WelcomeEmail({ name, locale }: Props) {\n+  const t = makeT(locale);\n@@ -14,6 +16,6 @@\n-      <h1>Welcome to TalkBridge!</h1>\n+      <h1>{t(\'emails.welcome.title\')}</h1>\n…' },
      { path: 'src/lib/toast.ts', additions: 8, deletions: 6, diff: '--- a/src/lib/toast.ts\n+++ b/src/lib/toast.ts\n@@ -7,8 +7,8 @@\n-export function toast(message: string) {\n+export function toast(key: TranslationKey, vars?: Record<string, string>) {\n-  push({ id: nextId(), message });\n+  push({ id: nextId(), message: t(key, vars) });\n…' },
    ],
  }, 1_000);
  tl.ev('command', {
    command: 'npm run build', cwd: dir,
    stdout: 'vite v7.1.3 building for production...\n✓ 216 modules transformed.\n✓ built in 2.56s',
    stderr: '', exitCode: 0, durationMs: 4_020, status: 'done',
  }, 4_200);
  tl.ev('assistant_message', { text: answer2 }, 1_600);
  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'talkbridge', dir, 33, 'Original request:\nTranslate settings, email templates and toasts.\n\nEvaluate the current project state (round 1).') },
    response: { text: 'PASS — key coverage is complete (74/74), naming stays within the established scheme (settings.*, emails.*, toast.*), and the email templates render correctly for both locales in the snapshot tests.', usage: { inputTokens: 12_850, outputTokens: 300 } },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_580, simulated: true,
  }, 3_700);
  tl.ev('findings', { verdict: 'pass', round: 1, items: [] }, 300);
  tl.ev('run', { phase: 'finished' }, 200);

  // ---- day 3: context got heavy → user compacted (manual), then kept working
  tl.t = end - 55 * 60_000;
  tl.runId = undefined;
  const compactionId = tl.evId('compaction', {
    beforeTokens: 132_400,
    afterTokens: 41_200,
    provider: 'claude-code',
    model: 'claude-sonnet-5',
    summary: [
      '## Goal',
      '- Full Spanish support for talkbridge: UI strings, settings, email templates, toasts — via a lightweight t()/locale layer with English fallback.',
      '',
      '## State',
      '- i18n layer in src/i18n (index.ts + en.json/es.json, 74 keys, complete parity).',
      '- Language picker in Header; locale persists via localStorage; document.lang kept in sync.',
      '- Emails take a locale prop; toasts use translation keys (9 call sites migrated).',
      '- Reviewer: PASS on both completed rounds. Builds green.',
      '',
      '## Decisions',
      '- No external i18n library — hand-rolled 20-line layer was sufficient (user approved).',
      '- Key naming: area-prefixed dot paths (nav.*, settings.*, emails.*, toast.*).',
      '',
      '## Remaining',
      '- Nothing open from previous requests; awaiting next instruction.',
    ].join('\n'),
    preserved: [
      'Original goal and all user instructions',
      'Key naming scheme decision',
      'Changed-file inventory (7 files)',
      'Latest reviewer verdicts',
      '~12k tokens of the most recent conversation kept verbatim',
    ],
    durationMs: 6_400,
    simulated: true,
  }, 0);
  db.prepare('UPDATE chats SET last_compaction_event_id = ? WHERE id = ?').run(compactionId, chatId);

  tl.runId = 'seed-run-d3';
  tl.ev('user_message', { text: 'Switch the language picker to a dropdown with the language names in their own language, and remember the choice per account instead of per browser.' }, 60_000);
  tl.ev('run', { phase: 'started' }, 700);
  tl.ev('status', { text: 'Inspecting project…' }, 500);
  tl.ev('file_read', { path: 'src/components/Header.tsx', lines: 31 }, 600);
  tl.ev('file_read', { path: 'src/api/client.ts', lines: 26 }, 400);
  tl.ev('search', { query: 'localStorage.setItem', tool: 'rg', matches: [{ path: 'src/i18n/index.ts', line: 14, preview: "localStorage.setItem('locale', locale);" }] }, 500);

  const answer3 = [
    'Done on both counts:',
    '',
    '- The picker is now a proper dropdown listing **English** and **Español** (each in its own language), with the current choice shown in the header.',
    '- Locale is stored on the account: `setLocale` PATCHes `/api/account/preferences` and the app boots from the profile value, falling back to the browser value for signed-out users.',
    '',
    'Migration note: existing browser-stored choices are pushed to the account on first load after sign-in, so nobody loses their setting.',
  ].join('\n');
  tl.ev('ai_call', {
    role: 'builder', provider: 'claude-code', model: 'claude-opus-5', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('builder', 'talkbridge', dir, 44, 'Request:\nSwitch the language picker to a dropdown with the language names in their own language, and remember the choice per account instead of per browser.') },
    response: { text: answer3, usage: { inputTokens: 116_400, outputTokens: 1_350 } },
    cli: { command: CLAUDE_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 6_130, simulated: true,
  }, 6_300);
  tl.ev('file_change', {
    files: [
      { path: 'src/components/Header.tsx', additions: 9, deletions: 6, diff: '--- a/src/components/Header.tsx\n+++ b/src/components/Header.tsx\n@@ -4,8 +4,8 @@\n const locales: { value: Locale; label: string }[] = [\n   { value: \'en\', label: \'English\' },\n-  { value: \'es\', label: \'Spanish\' },\n+  { value: \'es\', label: \'Español\' },\n ];\n@@ -14,7 +14,10 @@\n-      <select aria-label={t(\'settings.language\')} onChange={(e) => setLocale(e.target.value as Locale)}>\n+      <select aria-label={t(\'settings.language\')} value={locale} onChange={(e) => void setLocale(e.target.value as Locale)}>\n…' },
      { path: 'src/i18n/index.ts', additions: 11, deletions: 3, diff: '--- a/src/i18n/index.ts\n+++ b/src/i18n/index.ts\n@@ -11,7 +11,15 @@\n-export function setLocale(locale: Locale): void {\n+export async function setLocale(locale: Locale): Promise<void> {\n   current = locale;\n   localStorage.setItem(\'locale\', locale);\n   document.documentElement.lang = locale;\n+  if (session.signedIn) {\n+    await api.patch(\'/account/preferences\', { locale });\n+  }\n }' },
    ],
  }, 900);
  tl.ev('command', {
    command: 'npm test', cwd: dir,
    stdout: ' RUN  v3.2.1 ' + dir + '\n\n ✓ src/i18n/i18n.test.ts (6 tests) 14ms\n ✓ src/components/header.test.tsx (4 tests) 32ms\n\n Test Files  2 passed (2)\n      Tests  10 passed (10)\n   Duration  1.31s',
    stderr: '', exitCode: 0, durationMs: 2_980, status: 'done',
  }, 3_100);
  tl.ev('assistant_message', { text: answer3 }, 1_500);
  tl.ev('ai_call', {
    role: 'reviewer', provider: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done',
    request: { prompt: seedPrompt('reviewer', 'talkbridge', dir, 46, 'Original request:\nDropdown with native language names; per-account locale.\n\nEvaluate the current project state (round 1).') },
    response: { text: 'PASS — native-language labels are correct, the account preference round-trips (PATCH on change, profile value on boot), the signed-out fallback works, and the browser→account migration is idempotent.', usage: { inputTokens: 13_400, outputTokens: 280 } },
    cli: { command: CODEX_CLI, cwd: dir, exitCode: 0 },
    startedAt: tl.t, durationMs: 3_390, simulated: true,
  }, 3_500);
  tl.ev('findings', { verdict: 'pass', round: 1, items: [] }, 300);
  tl.ev('run', { phase: 'finished' }, 200);
  tl.finish();
}
