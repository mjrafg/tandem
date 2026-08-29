import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config';
import { db } from './db';

const SESSION_DAYS = 90;

// ---------------------------------------------------------------- passwords

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function getUser(): { email: string; pass: string } | null {
  return (db.prepare('SELECT email, pass FROM user WHERE id = 1').get() as any) ?? null;
}

export function setPassword(password: string): void {
  const pass = hashPassword(password);
  const existing = getUser();
  if (existing) db.prepare('UPDATE user SET pass = ? WHERE id = 1').run(pass);
  else db.prepare('INSERT INTO user (id, email, pass) VALUES (1, ?, ?)').run(config.adminEmail, pass);
}

/** On first boot with no user, create one so the app is never open. */
export function ensureUser(): void {
  if (getUser()) return;
  const envPw = process.env.TANDEM_INITIAL_PASSWORD;
  if (envPw) {
    setPassword(envPw);
    return;
  }
  const generated = randomBytes(9).toString('base64url');
  setPassword(generated);
  // Printed once at bootstrap so the operator can sign in; not stored in plaintext.
  console.log(`[tandem] created user ${config.adminEmail} with generated password: ${generated}`);
}

// ---------------------------------------------------------------- sessions

export function createSession(): string {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, created_at, last_seen) VALUES (?, ?, ?)').run(token, now, now);
  return token;
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function validSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = db.prepare('SELECT token, last_seen FROM sessions WHERE token = ?').get(token) as any;
  if (!row) return false;
  const now = Date.now();
  if (now - row.last_seen > SESSION_DAYS * 24 * 3600 * 1000) {
    destroySession(token);
    return false;
  }
  if (now - row.last_seen > 3600 * 1000) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now, token);
  }
  return true;
}

// ---------------------------------------------------------------- rate limit

const attempts = new Map<string, number[]>();

export function loginAllowed(ip: string): boolean {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < windowMs);
  attempts.set(ip, recent);
  return recent.length < 8;
}

export function recordLoginAttempt(ip: string): void {
  const list = attempts.get(ip) ?? [];
  list.push(Date.now());
  attempts.set(ip, list);
}

// ---------------------------------------------------------------- fastify hook

export function authHook(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const url = req.url;
  if (!url.startsWith('/api/')) return done();
  if (url.startsWith('/api/login') || url.startsWith('/api/health')) return done();
  const token = (req.cookies as Record<string, string | undefined>)?.tandem_sid;
  if (!validSession(token)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie('tandem_sid', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}
