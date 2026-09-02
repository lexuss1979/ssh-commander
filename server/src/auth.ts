import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { verifyPassword } from './services/settings.js';

export const SESSION_COOKIE = 'sc_session';

const sessions = new Map<string, number>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

export function createSession(password: string): string | null {
  // Проверка через settings-сервис (docs/settings-model-plan.md): только хеш
  // из settings.json → scrypt; env-фолбэка нет — env-пароль сеется хешем
  // при первом старте.
  if (!verifyPassword(password)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + config.sessionTtlMs);
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function hasSession(token: string): boolean {
  pruneSessions();
  return sessions.has(token);
}

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  pruneLoginAttempts(now);
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

/** A successful login clears the failure counter for this IP. */
export function resetLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// Drop expired entries so the map does not grow with one-off IPs.
function pruneLoginAttempts(now: number): void {
  for (const [ip, entry] of loginAttempts) {
    if (entry.resetAt <= now) loginAttempts.delete(ip);
  }
}

export function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return '';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!token || !hasSession(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as Request & { sessionToken?: string }).sessionToken = token;
  next();
}

export function authToken(req: Request): string {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

