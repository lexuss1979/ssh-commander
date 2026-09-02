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
 * Страница «Настройки» (эпик 23, docs/settings-model-plan.md): смена пароля
 * веб-интерфейса и AI-конфига после первого запуска — без правки
 * data/settings.json и рестарта. Монтируется **с** `requireAuth` (страница за
 * авторизацией — rate-limit не нужен, перебор текущего пароля был бы атакой
 * на самого себя). Ключ API наружу не возвращается никогда — только факт
 * «задан» (`apiKeySet`).
 *
 * Сессии при смене пароля не инвалидируются (single-user, in-memory):
 * открытые сессии живут до истечения TTL, новые входы — по новому паролю.
 */
export const settingsRouter = Router();

/** Маскированный статус настроек: единая форма ответа GET и PUT. */
function settingsStatus() {
  const ai = getAiSettings();
  return {
    ai: {
      provider: ai.provider,
      apiKeySet: Boolean(ai.apiKey),
      apiBase: ai.apiBase,
      model: ai.model,
      // Честный статус поиска, включая env-оверрайд для не-DeepSeek.
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
      .enum(['deepseek', 'openai', 'custom'], {
        errorMap: () => ({ message: 'Провайдер должен быть deepseek, openai или custom' }),
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
    // Пароль — только парой: смена требует и текущего, и нового.
    if (hasPasswordChange && (v.currentPassword === undefined || v.newPassword === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: 'Смена пароля передаётся парой полей: currentPassword и newPassword',
      });
    }
    if (!hasAiChange) return;
    // Очистка ключа — явный null (или пустая строка после trim) и ничего
    // больше: половинчатый «конфиг без ключа» не имеет смысла.
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
    // Замена AI-конфига — только целиком: ключ write-only (наружу не
    // отдаётся), «частично» заменить нельзя — незаданное поле удалило бы
    // работающий конфиг.
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
    // Пустая строка после trim эквивалентна null — это тоже очистка.
    aiApiKey: v.aiApiKey === undefined ? undefined : v.aiApiKey || null,
    aiProvider: v.aiProvider,
    // Срез хвостового '/' — как в config.ts и setup.
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
  if (currentPassword !== undefined && !verifyPassword(currentPassword)) {
    res.status(400).json({ error: 'Неверный текущий пароль' });
    return;
  }
  try {
    if (currentPassword !== undefined && newPassword !== undefined) {
      updateSettings({ passwordHash: hashPassword(newPassword) });
    }
    if (aiApiKey === null) {
      // Очистка ключа — агент недоступен: провайдер и модель без ключа не
      // имеют смысла, удаляются вместе (UI показывает дефолтный пресет).
      updateSettings({ aiProvider: null, aiApiKey: null, aiApiBase: null, aiModel: null });
    } else if (aiApiKey !== undefined && aiProvider && aiApiBase && aiModel) {
      // superRefine гарантирует все четыре поля при замене — guard тут только
      // для типов.
      updateSettings({ aiProvider, aiApiKey, aiApiBase, aiModel });
    }
  } catch (err) {
    // Битый settings.json (corrupt-guard) — изменения невозможны до ручного
    // исправления файла; 500 с текстом, а не молчаливая потеря.
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  res.json(settingsStatus());
});
