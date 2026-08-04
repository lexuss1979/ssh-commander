import { Router } from 'express';
import {
  SESSION_COOKIE,
  authToken,
  createSession,
  destroySession,
  isRateLimited,
  resetLoginAttempts,
} from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте позже.' });
    return;
  }
  const password = String(req.body?.password ?? '');
  const token = createSession(password);
  if (!token) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  resetLoginAttempts(ip);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  destroySession(authToken(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

