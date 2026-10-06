import { Router } from 'express';
import { z } from 'zod';
import { SESSION_COOKIE, createSession, isRateLimited, resetLoginAttempts } from '../auth.js';
import {
  getSettings,
  hashPassword,
  onboardingRequired,
  OPENCODE_GO_API_BASE,
  saveSettings,
} from '../services/settings.js';

/**
 * First-run onboarding (plan — docs/settings-model-plan.md): the web
 * password and (optionally) the AI config are set once in the UI. Endpoints
 * are mounted without `requireAuth` — at the stage when the password does
 * not exist yet, there are no sessions. POST is available only while
 * onboarding is required (409 after success) — protects against rewriting
 * settings without auth; the rate limit shared with login (10 attempts /
 * 15 min) blocks brute force at this stage.
 *
 * Writes are a merge over the existing settings, not a rewrite: AI fields
 * seeded from env must not be wiped by a keyless form submit.
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
    aiProvider: z
      .enum(['deepseek', 'openai', 'opencode-go', 'custom'], {
        errorMap: () => ({ message: 'Провайдер должен быть deepseek, openai, opencode-go или custom' }),
      })
      .optional(),
    aiApiBase: z
      .string({ invalid_type_error: 'Base URL должен быть строкой' })
      .trim()
      .refine((v) => !v || /^https?:\/\//i.test(v), 'Base URL должен начинаться с http:// или https://')
      .optional(),
    aiModel: z
      .string({ invalid_type_error: 'Модель должна быть строкой' })
      .trim()
      .refine((v) => !v || !/\s/.test(v), 'Модель не может содержать пробелы')
      .optional(),
  })
  // Key present → provider and model are required (a preset without a model
  // does not work); for custom the base URL is required too — otherwise the
  // key would go to the default OpenAI base with an obscure error.
  .superRefine((v, ctx) => {
    if (!v.aiApiKey) return;
    if (!v.aiProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiProvider'],
        message: 'Провайдер обязателен при заданном ключе API',
      });
    }
    if (!v.aiModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiModel'],
        message: 'Модель обязательна при заданном ключе API',
      });
    }
    if (v.aiProvider === 'custom' && !v.aiApiBase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiApiBase'],
        message: 'Base URL обязателен для провайдера «Свой URL»',
      });
    }
  })
  .transform((v) => ({
    password: v.password,
    aiApiKey: v.aiApiKey || undefined,
    aiProvider: v.aiProvider,
    // Trailing '/' stripped — same as config.ts (config.ai.apiBase).
    aiApiBase: v.aiApiBase
      ? v.aiApiBase.replace(/\/+$/, '')
      : v.aiProvider === 'opencode-go' ? OPENCODE_GO_API_BASE : undefined,
    aiModel: v.aiModel || undefined,
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
  const { password, aiApiKey, aiProvider, aiApiBase, aiModel } = parsed.data;
  try {
    // Merge, not rewrite: AI fields are written only together with the
    // entered key — otherwise env-seeded fields would be wiped by an empty
    // form.
    const prev = getSettings() ?? {};
    saveSettings({
      ...prev,
      passwordHash: hashPassword(password),
      ...(aiApiKey ? { aiProvider, aiApiKey, aiApiBase, aiModel } : {}),
    });
  } catch (err) {
    // Broken settings.json (corrupt-guard) — onboarding is impossible until
    // the file is fixed manually; a 500 with text, not a silent overwrite.
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  // Auto-login: the password was just saved hashed — createSession goes
  // through verifyPassword (the settings branch). Same cookie path as login.
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
