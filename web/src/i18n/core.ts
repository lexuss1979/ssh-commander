import { ru } from './ru';
import { en } from './en';

// Pure i18n core without React/DOM — covered by the server test runner
// (server/test/i18n.test.ts, the alerts-merge.test.ts precedent).

export type Lang = 'ru' | 'en';
export type I18nKey = keyof typeof ru;
export type I18nParams = Record<string, string | number>;

const dicts: Record<Lang, typeof ru> = { ru, en };

/**
 * Translate a key. String values get {placeholder} substitution;
 * functions (plural forms) are called with the passed argument as is.
 */
export function translate(lang: Lang, key: I18nKey, params?: I18nParams | number): string {
  const v = dicts[lang][key] as string | ((arg: unknown) => string);
  if (typeof v === 'function') return v(params);
  if (params == null || typeof params !== 'object') return v;
  return v.replace(/\{(\w+)\}/g, (m, name: string) =>
    params[name] !== undefined ? String(params[name]) : m,
  );
}

/** The saved choice ('sc-lang') outranks the browser locale; default — en. */
export function detectLang(saved: string | null, navLanguage: string | undefined): Lang {
  if (saved === 'ru' || saved === 'en') return saved;
  return navLanguage?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/** Locale for toLocale* formatting of dates and numbers. */
export function localeOf(lang: Lang): string {
  return lang === 'ru' ? 'ru-RU' : 'en-US';
}

// The active language at module level — access for non-React code (api.ts
// etc.). LangProvider syncs via setActiveLang; reactivity on switch comes
// from the context (components must use useT()).
let activeLang: Lang = 'en';

export function setActiveLang(lang: Lang): void {
  activeLang = lang;
}

export function getActiveLang(): Lang {
  return activeLang;
}

/** The non-React variant of translation: reads the module's active language. */
export function t(key: I18nKey, params?: I18nParams | number): string {
  return translate(activeLang, key, params);
}

/** Locale of the active language — for toLocale* outside React components. */
export function activeLocale(): string {
  return localeOf(activeLang);
}
