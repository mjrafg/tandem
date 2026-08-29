import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { db, kvGet, kvSet } from '../db';
import { seedCheckoutChat, seedLoginChat, seedSlowDashboardChat, seedSpanishChat } from './seedChats';

/** Seed demo projects + example chats on first boot so the product is judgeable immediately. */
export function seedIfEmpty(): void {
  if (kvGet('seeded')) return;

  const portalPath = makePortalRepo();
  const talkbridgePath = makeTalkbridgeRepo();

  const now = Date.now();
  const portal = insertProject('customer-portal', portalPath, now - 26 * 3600_000, now - 3 * 3600_000);
  const talkbridge = insertProject('talkbridge', talkbridgePath, now - 3 * 24 * 3600_000, now - 40 * 60_000);

  seedCheckoutChat(portal, now - 26 * 3600_000);
  seedLoginChat(portal, now - 7 * 3600_000);
  seedSlowDashboardChat(portal, now - 3 * 3600_000);
  seedSpanishChat(talkbridge, now - 3 * 24 * 3600_000, now - 40 * 60_000);

  kvSet('seeded', { at: now });
  console.log('[tandem] seeded demo projects and chats');
}

// ---------------------------------------------------------------- helpers

function insertProject(name: string, rootPath: string, createdAt: number, lastOpenedAt: number): string {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, root_path, source, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, rootPath, 'directory', createdAt, lastOpenedAt);
  return id;
}

// ---------------------------------------------------------------- demo repos

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function gitCommitAll(root: string, message: string): void {
  const g = (args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=demo@tandem.local', '-c', 'user.name=Tandem Demo', ...args], { stdio: 'pipe' });
  try {
    g(['init', '-q', '-b', 'main']);
    g(['add', '-A']);
    g(['commit', '-q', '-m', message]);
  } catch (err) {
    console.warn('[tandem] demo repo git setup skipped:', String(err));
  }
}

function makePortalRepo(): string {
  const root = path.join(config.projectsDir, 'customer-portal');
  if (fs.existsSync(root)) return root;
  writeTree(root, {
    'package.json': `{
  "name": "customer-portal",
  "version": "2.4.1",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },
  "devDependencies": { "vite": "^7.0.0", "vitest": "^3.2.0", "typescript": "^5.7.0" }
}
`,
    'README.md': `# customer-portal

Storefront checkout and account portal.

- \`npm run dev\` — local dev server
- \`npm test\` — vitest suite
`,
    'src/checkout/total.ts': `import type { CartLine } from './cart';

/** All money math happens in integer cents to avoid float drift. */
export function lineTotalCents(line: CartLine): number {
  const unitCents = Math.round(line.unitPrice * 100);
  const discounted = Math.round(unitCents * (1 - line.discountPct / 100));
  return discounted * line.quantity;
}

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

export function formatCents(cents: number, locale = 'en-US', currency = 'USD'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
`,
    'src/checkout/total.test.ts': `import { describe, expect, it } from 'vitest';
import { cartTotalCents, formatCents, lineTotalCents } from './total';

describe('checkout totals', () => {
  it('rounds per line in cents', () => {
    expect(lineTotalCents({ sku: 'a', unitPrice: 8.33, quantity: 3, discountPct: 0 })).toBe(2499);
  });
  it('applies discounts before quantity', () => {
    expect(lineTotalCents({ sku: 'b', unitPrice: 10, quantity: 2, discountPct: 15 })).toBe(1700);
  });
  it('formats as currency', () => {
    expect(formatCents(2499)).toBe('$24.99');
  });
  it('sums an empty cart to zero', () => {
    expect(cartTotalCents([])).toBe(0);
  });
});
`,
    'src/checkout/cart.ts': `export interface CartLine {
  sku: string;
  unitPrice: number;
  quantity: number;
  discountPct: number;
}

export interface Cart {
  id: string;
  lines: CartLine[];
  couponCode?: string;
}

export function addLine(cart: Cart, line: CartLine): Cart {
  const existing = cart.lines.find((l) => l.sku === line.sku);
  if (!existing) return { ...cart, lines: [...cart.lines, line] };
  return {
    ...cart,
    lines: cart.lines.map((l) => (l.sku === line.sku ? { ...l, quantity: l.quantity + line.quantity } : l)),
  };
}
`,
    'src/components/CheckoutSummary.tsx': `import { cartTotalCents, formatCents } from '../checkout/total';
import type { Cart } from '../checkout/cart';

export function CheckoutSummary({ cart }: { cart: Cart }) {
  const total = cartTotalCents(cart.lines);
  return (
    <aside className="checkout-summary">
      <h2>Order summary</h2>
      <dl>
        <dt>Items</dt>
        <dd>{cart.lines.length}</dd>
        <dt>Total</dt>
        <dd data-testid="grand-total">{formatCents(total)}</dd>
      </dl>
      <button disabled={cart.lines.length === 0}>Place order</button>
    </aside>
  );
}
`,
    'src/pages/Login.tsx': `import { useState } from 'react';
import { api } from '../api/client';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) return setError('Enter a valid email address.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    try {
      await api.login(email, password);
      location.href = '/account';
    } catch {
      setError('Email or password is incorrect.');
    }
  }

  return (
    <form onSubmit={submit} aria-describedby={error ? 'login-error' : undefined}>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      {error && <p id="login-error" role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}
`,
    'src/api/client.ts': `const base = import.meta.env.VITE_API_URL ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...init,
  });
  if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    request('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  cart: () => request('/cart'),
};
`,
  });
  gitCommitAll(root, 'Checkout rounding fix + login validation');
  // leave the tree slightly dirty so the git chip has something real to show
  fs.appendFileSync(path.join(root, 'src/checkout/cart.ts'), `
export function removeLine(cart: Cart, sku: string): Cart {
  return { ...cart, lines: cart.lines.filter((l) => l.sku !== sku) };
}
`);
  fs.writeFileSync(path.join(root, 'src/checkout/discount.ts'), `import type { Cart } from './cart';

export function applyCoupon(cart: Cart, code: string): Cart {
  // TODO: validate against /api/coupons
  return { ...cart, couponCode: code.trim().toUpperCase() };
}
`);
  return root;
}

function makeTalkbridgeRepo(): string {
  const root = path.join(config.projectsDir, 'talkbridge');
  if (fs.existsSync(root)) return root;
  writeTree(root, {
    'package.json': `{
  "name": "talkbridge",
  "version": "1.9.0",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" }
}
`,
    'src/i18n/index.ts': `import en from './en.json';
import es from './es.json';

const dictionaries = { en, es } as const;
export type Locale = keyof typeof dictionaries;

let current: Locale = (localStorage.getItem('locale') as Locale) ?? 'en';

export function t(key: keyof typeof en): string {
  return dictionaries[current][key] ?? dictionaries.en[key] ?? key;
}

export function setLocale(locale: Locale): void {
  current = locale;
  localStorage.setItem('locale', locale);
  document.documentElement.lang = locale;
}
`,
    'src/i18n/en.json': `{
  "app.title": "TalkBridge",
  "nav.home": "Home",
  "nav.rooms": "Rooms",
  "nav.settings": "Settings",
  "home.welcome": "Talk to anyone, in any language.",
  "home.start": "Start a conversation",
  "settings.language": "Language",
  "settings.notifications": "Notifications"
}
`,
    'src/i18n/es.json': `{
  "app.title": "TalkBridge",
  "nav.home": "Inicio",
  "nav.rooms": "Salas",
  "nav.settings": "Ajustes",
  "home.welcome": "Habla con cualquiera, en cualquier idioma.",
  "home.start": "Iniciar una conversación",
  "settings.language": "Idioma",
  "settings.notifications": "Notificaciones"
}
`,
    'src/components/Header.tsx': `import { setLocale, t, type Locale } from '../i18n';

const locales: { value: Locale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

export function Header() {
  return (
    <header className="app-header">
      <strong>{t('app.title')}</strong>
      <nav>
        <a href="/">{t('nav.home')}</a>
        <a href="/rooms">{t('nav.rooms')}</a>
        <a href="/settings">{t('nav.settings')}</a>
      </nav>
      <select aria-label={t('settings.language')} onChange={(e) => setLocale(e.target.value as Locale)}>
        {locales.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>
    </header>
  );
}
`,
    'src/pages/Home.tsx': `import { t } from '../i18n';

export function Home() {
  return (
    <main>
      <h1>{t('home.welcome')}</h1>
      <button>{t('home.start')}</button>
    </main>
  );
}
`,
  });
  gitCommitAll(root, 'Spanish locale + language picker');
  return root;
}
