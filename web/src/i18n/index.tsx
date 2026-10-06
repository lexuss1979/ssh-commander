import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  detectLang,
  localeOf,
  setActiveLang,
  translate,
  type I18nKey,
  type I18nParams,
  type Lang,
} from './core';

export type { I18nKey, I18nParams, Lang } from './core';

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey, params?: I18nParams | number) => string;
  /** Locale of the active language ('ru-RU' | 'en-US') for toLocale*. */
  locale: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLang(): Lang {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('sc-lang');
  } catch {
    /* localStorage may be unavailable */
  }
  return detectLang(saved, typeof navigator !== 'undefined' ? navigator.language : undefined);
}

/**
 * The language provider. Mounted in main.tsx around <App /> — above the
 * auth guard, so LoginPage has access to the context too. Switching is
 * setState + localStorage, no reload: keep-alive tabs and the agent's WS
 * panel do not remount (the same invariant as the theme).
 */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = readInitialLang();
    setActiveLang(initial);
    return initial;
  });

  useEffect(() => {
    setActiveLang(lang);
  }, [lang]);

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang: (next) => {
        setLangState(next);
        try {
          localStorage.setItem('sc-lang', next);
        } catch {
          /* localStorage may be unavailable */
        }
      },
      t: (key, params) => translate(lang, key, params),
      locale: localeOf(lang),
    }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useT() вне LangProvider');
  return ctx;
}
