import { ru } from './ru';
import { en } from './en';

// Чистое ядро i18n без React/DOM — покрывается раннером сервера
// (server/test/i18n.test.ts, прецедент alerts-merge.test.ts).

export type Lang = 'ru' | 'en';
export type I18nKey = keyof typeof ru;
export type I18nParams = Record<string, string | number>;

const dicts: Record<Lang, typeof ru> = { ru, en };

/**
 * Перевод ключа. Строковые значения — с подстановкой {placeholders};
 * функции (склонения) вызываются с переданным аргументом как есть.
 */
export function translate(lang: Lang, key: I18nKey, params?: I18nParams | number): string {
  const v = dicts[lang][key] as string | ((arg: unknown) => string);
  if (typeof v === 'function') return v(params);
  if (params == null || typeof params !== 'object') return v;
  return v.replace(/\{(\w+)\}/g, (m, name: string) =>
    params[name] !== undefined ? String(params[name]) : m,
  );
}

/** Сохранённый выбор ('sc-lang') приоритетнее локали браузера; дефолт — en. */
export function detectLang(saved: string | null, navLanguage: string | undefined): Lang {
  if (saved === 'ru' || saved === 'en') return saved;
  return navLanguage?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Локаль для toLocale*-форматирования дат и чисел. */
export function localeOf(lang: Lang): string {
  return lang === 'ru' ? 'ru-RU' : 'en-US';
}

// Активный язык на уровне модуля — доступ для не-React кода (api.ts и
// т.п.). LangProvider синхронизирует через setActiveLang; реактивность
// при переключении даёт контекст (компоненты обязаны брать useT()).
let activeLang: Lang = 'en';

export function setActiveLang(lang: Lang): void {
  activeLang = lang;
}

export function getActiveLang(): Lang {
  return activeLang;
}

/** Не-React вариант перевода: читает активный язык модуля. */
export function t(key: I18nKey, params?: I18nParams | number): string {
  return translate(activeLang, key, params);
}

/** Локаль активного языка — для toLocale* вне React-компонентов. */
export function activeLocale(): string {
  return localeOf(activeLang);
}
