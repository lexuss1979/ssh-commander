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
  /** Локаль активного языка ('ru-RU' | 'en-US') для toLocale*. */
  locale: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLang(): Lang {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('sc-lang');
  } catch {
    /* localStorage может быть недоступен */
  }
  return detectLang(saved, typeof navigator !== 'undefined' ? navigator.language : undefined);
}

/**
 * Провайдер языка. Монтируется в main.tsx вокруг <App /> — выше
 * auth-guard, чтобы LoginPage тоже имел доступ к контексту. Переключение —
 * setState + localStorage, без перезагрузки: keep-alive вкладки и
 * WS-панель агента не перемонтируются (тот же инвариант, что у темы).
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
          /* localStorage может быть недоступен */
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
