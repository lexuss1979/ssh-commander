import { Router } from 'express';
import { z } from 'zod';
import {
  getAiSettings,
  hashPassword,
  updateSettings,
  verifyPassword,
} from '../services/settings.js';
import { isSearchConfigured } from '../ai/web-search.js';

/**
 * Settings page (epic 23, docs/settings-model-plan.md): changing the web
 * password and AI config after the first run — without editing
 * data/settings.json or restarting. Mounted **with** `requireAuth` (the page
 * sits behind auth — no rate limit needed; brute-forcing the current
 * password would be an attack on oneself). The API key is never returned —
 * only the fact that it is set (`apiKeySet`).
 *
 * Sessions are not invalidated on password change (single-user, in-memory):
 * open sessions live until TTL expiry, new logins use the new password.
 */
export const settingsRouter = Router();

/** Masked settings status: the single response shape shared by GET and PUT. */
function settingsStatus() {
  const ai = getAiSettings();
  return {
    ai: {
      provider: ai.provider,
      apiKeySet: Boolean(ai.apiKey),
      apiBase: ai.apiBase,
      model: ai.model,
      // Honest search status, including the env override for non-DeepSeek.
      searchAvailable: isSearchConfigured(),
    },
  };
}

settingsRouter.get('/', (_req, res) => {
  res.json(settingsStatus());
});

const putBodySchema = z
  .object({
    currentPassword: z.string().optional(),
    newPassword: z
      .string({ invalid_type_error: 'Пароль должен быть строкой' })
      .min(8, 'Пароль должен быть не короче 8 символов')
      .refine((v) => !/[\r\n]/.test(v), 'Пароль не может содержать перевод строки')
      .optional(),
    aiApiKey: z
      .string({ invalid_type_error: 'Ключ API должен быть строкой' })
      .trim()
      .refine((v) => !v || !/\s/.test(v), 'Ключ API не может содержать пробелы или переводы строк')
      .nullable()
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
  .superRefine((v, ctx) => {
    const hasPasswordChange = v.currentPassword !== undefined || v.newPassword !== undefined;
    const otherAiPresent =
      v.aiProvider !== undefined || v.aiApiBase !== undefined || v.aiModel !== undefined;
    const hasAiChange = v.aiApiKey !== undefined || otherAiPresent;
    if (!hasPasswordChange && !hasAiChange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Нечего менять: передайте смену пароля или AI-конфиг',
      });
      return;
    }
    // Password changes come in pairs: both the current and the new one are required.
    if (hasPasswordChange && (v.currentPassword === undefined || v.newPassword === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'Смена пароля передаётся парой полей: currentPassword и newPassword',
      });
    }
    if (!hasAiChange) return;
    // Model-only change keeps the write-only key and the other AI settings.
    if (v.aiApiKey === undefined && v.aiProvider === undefined && v.aiApiBase === undefined && v.aiModel !== undefined) {
      if (!v.aiModel) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['aiModel'], message: 'Модель обязательна' });
      return;
    }
    // Clearing the key is an explicit null (or an empty string after trim)
    // and nothing else: a half-way "config without a key" makes no sense.
    if (v.aiApiKey === null || v.aiApiKey === '') {
      if (otherAiPresent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aiApiKey'],
          message: 'При очистке ключа другие AI-поля не передаются',
        });
      }
      return;
    }
    // Provider, base or key changes go as a whole, with the key entered
    // explicitly. The stored secret is not carried over to another endpoint.
    if (v.aiApiKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiApiKey'],
        message: 'Ключ API обязателен при смене AI-конфига',
      });
    }
    if (!v.aiProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiProvider'],
        message: 'Провайдер обязателен при заданном ключе API',
      });
    }
    if (!v.aiApiBase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiApiBase'],
        message: 'Base URL обязателен при заданном ключе API',
      });
    }
    if (!v.aiModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiModel'],
        message: 'Модель обязательна при заданном ключе API',
      });
    }
  })
  .transform((v) => ({
    currentPassword: v.currentPassword,
    newPassword: v.newPassword,
    // An empty string after trim is equivalent to null — also a clear.
    aiApiKey: v.aiApiKey === undefined ? undefined : v.aiApiKey || null,
    aiProvider: v.aiProvider,
    // Trailing '/' stripped — same as config.ts and setup.
    aiApiBase: v.aiApiBase ? v.aiApiBase.replace(/\/+$/, '') : undefined,
    aiModel: v.aiModel,
  }));

settingsRouter.put('/', (req, res) => {
  const parsed = putBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? 'Некорректные данные' });
    return;
  }
  const { currentPassword, newPassword, aiApiKey, aiProvider, aiApiBase, aiModel } = parsed.data;
  const modelOnly = aiApiKey === undefined && aiProvider === undefined && aiApiBase === undefined && aiModel !== undefined;
  if (modelOnly && !getAiSettings().apiKey) {
    res.status(400).json({ error: 'Сначала задайте ключ API и AI-конфиг' });
    return;
  }
  if (currentPassword !== undefined && !verifyPassword(currentPassword)) {
    res.status(400).json({ error: 'Неверный текущий пароль' });
    return;
  }
  try {
    if (currentPassword !== undefined && newPassword !== undefined) {
      updateSettings({ passwordHash: hashPassword(newPassword) });
    }
    if (modelOnly) {
      updateSettings({ aiModel });
    } else if (aiApiKey === null) {
      // Clearing the key makes the agent unavailable: provider and model
      // without a key are meaningless and removed together (the UI shows the
      // default preset).
      updateSettings({ aiProvider: null, aiApiKey: null, aiApiBase: null, aiModel: null });
    } else if (aiApiKey !== undefined && aiProvider && aiApiBase && aiModel) {
      // superRefine guarantees all four fields on replacement — this guard
      // is only for types.
      updateSettings({ aiProvider, aiApiKey, aiApiBase, aiModel });
    }
  } catch (err) {
    // Broken settings.json (corrupt-guard) — changes are impossible until
    // the file is fixed manually; a 500 with text, not a silent loss.
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  res.json(settingsStatus());
});
