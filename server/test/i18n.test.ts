import { describe, expect, it } from 'vitest';
// The i18n core and dictionaries — pure TypeScript without React/DOM, covered
// by the server runner directly (the precedent — alerts-merge.test.ts).
import {
  detectLang,
  localeOf,
  translate,
  setActiveLang,
  t,
  activeLocale,
} from '../../web/src/i18n/core.js';
import { ru, plural } from '../../web/src/i18n/ru.js';
import { en } from '../../web/src/i18n/en.js';

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('the ru/en dictionary parity', () => {
  it('the key sets are equal', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it('the value types match (string vs function)', () => {
    for (const key of Object.keys(ru) as Array<keyof typeof ru>) {
      expect(typeof en[key], key).toBe(typeof ru[key]);
    }
  });

  it('the {name} placeholders of the string values match', () => {
    for (const key of Object.keys(ru) as Array<keyof typeof ru>) {
      const rv = ru[key];
      const ev = en[key];
      if (typeof rv === 'string' && typeof ev === 'string') {
        expect(placeholders(ev), key).toEqual(placeholders(rv));
      }
    }
  });

  it('no en string value contains Cyrillic', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const v = en[key];
      if (typeof v === 'string') expect(v, key).not.toMatch(/\p{Script=Cyrillic}/u);
    }
  });
});

describe('translate', () => {
  it('substitutes named placeholders', () => {
    expect(translate('ru', 'common.language')).toBe('Язык');
    expect(translate('en', 'common.language')).toBe('Language');
  });

  it('an unknown placeholder stays as is', () => {
    expect(translate('en', 'common.errorRequest', { stray: 1 })).toBe('Request failed');
  });

  it('function values are called with the argument', () => {
    expect(translate('ru', 'time.hoursAgo', 1)).toBe('1 час назад');
    expect(translate('ru', 'time.hoursAgo', 3)).toBe('3 часа назад');
    expect(translate('ru', 'time.hoursAgo', 11)).toBe('11 часов назад');
    expect(translate('en', 'time.hoursAgo', 1)).toBe('1 hour ago');
    expect(translate('en', 'time.hoursAgo', 5)).toBe('5 hours ago');
  });
});

describe('plural (ru)', () => {
  it('one/few/many', () => {
    const f = (n: number) => plural(n, 'час', 'часа', 'часов');
    expect(f(1)).toBe('час');
    expect(f(21)).toBe('час');
    expect(f(2)).toBe('часа');
    expect(f(4)).toBe('часа');
    expect(f(5)).toBe('часов');
    expect(f(11)).toBe('часов');
    expect(f(12)).toBe('часов');
    expect(f(0)).toBe('часов');
  });
});

describe('detectLang', () => {
  it('the saved choice takes priority over the browser locale', () => {
    expect(detectLang('en', 'ru-RU')).toBe('en');
    expect(detectLang('ru', 'en-US')).toBe('ru');
  });

  it('without a saved one — by navigator.language', () => {
    expect(detectLang(null, 'ru-RU')).toBe('ru');
    expect(detectLang(null, 'ru')).toBe('ru');
    expect(detectLang(null, 'en-US')).toBe('en');
    expect(detectLang(null, 'zh-CN')).toBe('en');
    expect(detectLang(null, undefined)).toBe('en');
  });

  it('garbage in the saved value is ignored', () => {
    expect(detectLang('fr', 'ru-RU')).toBe('ru');
  });
});

describe('localeOf', () => {
  it('ru → ru-RU, en → en-US', () => {
    expect(localeOf('ru')).toBe('ru-RU');
    expect(localeOf('en')).toBe('en-US');
  });
});

describe('the module-level active language (non-React access)', () => {
  it('t()/activeLocale() read setActiveLang', () => {
    setActiveLang('ru');
    expect(t('common.loading')).toBe('Загрузка…');
    expect(activeLocale()).toBe('ru-RU');
    setActiveLang('en');
    expect(t('common.loading')).toBe('Loading…');
    expect(activeLocale()).toBe('en-US');
  });
});
