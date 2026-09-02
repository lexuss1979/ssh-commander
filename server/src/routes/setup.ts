import { Router } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE, createSession, isRateLimited, resetLoginAttempts } from '../auth.js';
import {
  hashPassword,
  onboardingRequired,
  saveSettings,
} from '../services/settings.js';

/**
 * Первичная настройка при первом запуске (план — docs/onboarding-plan.md):
 * пароль веб-интерфейса и (опционально) ключ AI-API задаются в UI один раз.
 * Эндпоинты монтируются без `requireAuth` — на этапе, когда пароль ещё не
 * задан, сессий нет. POST доступен только пока onboarding required (409
 * после успеха) — защита от перезаписи настроек без авторизации; rate-limit
 * общий с логином (10 попыток / 15 мин) закрывает перебор на этом этапе.
 */
export const setupRouter = Router();

setupRouter.get('/status', (_req, res) => {
  res.json({ required: onboardingRequired() });
});

const setupBodySchema = z
  .object({
    password: z
      .string({ invalid_type_error: 'Пароль должен быть строкой' })
      .min(8, 'Пароль должен быть не короче 8 символов')
      .refine((v) => !/[\r\n]/.test(v), 'Пароль не может содержать перевод строки'),
    aiApiKey: z
      .string({ invalid_type_error: 'Ключ API должен быть строкой' })
      .trim()
      .refine((v) => !v || !/\s/.test(v), 'Ключ API не может содержать пробелы или переводы строк')
      .optional(),
    aiApiBase: z
      .string({ invalid_type_error: 'Base URL должен быть строкой' })
      .trim()
      .refine((v) => !v || /^https?:\/\//i.test(v), 'Base URL должен начинаться с http:// или https://')
      .optional(),
  })
  .transform((v) => ({
    password: v.password,
    aiApiKey: v.aiApiKey || undefined,
    // Срез хвостового '/' — как в config.ts (config.ai.apiBase).
    aiApiBase: v.aiApiBase ? v.aiApiBase.replace(/\/+$/, '') : undefined,
  }));

setupRouter.post('/', (req, res) => {
  if (!onboardingRequired()) {
    res.status(409).json({ error: 'Настройка уже выполнена' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    return;
  }
  const parsed = setupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'Некорректные данные' });
    return;
  }
  const { password, aiApiKey, aiApiBase } = parsed.data;
  try {
    saveSettings({
      passwordHash: hashPassword(password),
      aiApiKey,
      aiApiBase,
    });
  } catch (err) {
    // Битый settings.json (corrupt-guard) — настройка невозможна до ручного
    // исправления файла; 500 с текстом, а не молчаливая перезапись.
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  // Авто-вход: пароль только что сохранён хешем — createSession проходит
  // через verifyPassword (settings-ветка). Тот же путь cookie, что у login.
  const token = createSession(password);
  if (!token) {
    res.status(500).json({ error: 'Не удалось создать сессию' });
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
