import { describe, expect, it } from 'vitest';
// Словарь строк агента (ai/strings.ts): выводы инструментов и служебные
// заметки на двух языках. ru-значения зафиксированы — на них завязаны
// тесты подсистем (multi-server, security-audit, disk-usage и др.).
import { AI_STRINGS, aiStr, type AiStringKey } from '../src/ai/strings.js';

const KEYS = Object.keys(AI_STRINGS.ru) as AiStringKey[];

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('ai/strings — паритет словарей ru/en', () => {
  it('множества ключей равны', () => {
    expect(Object.keys(AI_STRINGS.en).sort()).toEqual(Object.keys(AI_STRINGS.ru).sort());
  });

  it('плейсхолдеры {name} совпадают между ru и en', () => {
    for (const key of KEYS) {
      expect(placeholders(AI_STRINGS.en[key]), key).toEqual(placeholders(AI_STRINGS.ru[key]));
    }
  });

  it('ни одно en-значение не содержит кириллицы', () => {
    for (const key of KEYS) {
      expect(AI_STRINGS.en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});

describe('aiStr — интерполяция', () => {
  it('подставляет {name}-плейсхолдеры (строки и числа)', () => {
    expect(aiStr('ru', 'stepLimitReached', { n: 30 })).toBe('Достигнут лимит шагов (30).');
    expect(aiStr('en', 'stepLimitReached', { n: 30 })).toBe('Step limit reached (30).');
  });

  it('без params плейсхолдеры остаются как есть', () => {
    expect(aiStr('ru', 'stepLimitReached')).toBe('Достигнут лимит шагов ({n}).');
  });
});

describe('aiStr — спот-чеки зафиксированных строк', () => {
  it('ru «Неизвестный сервер» — байт-в-байт как раньше (multi-server.test.ts)', () => {
    expect(aiStr('ru', 'unknownServer', { name: 'nope', available: 'a, b' })).toBe(
      'Неизвестный сервер «nope». Подключённые к диалогу серверы: a, b. ' +
        'Полный список профилей — инструмент list_servers.',
    );
  });

  it('en-вариант — обычные кавычки вместо ёлочек', () => {
    expect(aiStr('en', 'unknownServer', { name: 'nope', available: 'a, b' })).toBe(
      'Unknown server "nope". Servers attached to this dialogue: a, b. ' +
        'Full profile list — the list_servers tool.',
    );
  });

  it('stoppedByUser на обоих языках', () => {
    expect(aiStr('ru', 'stoppedByUser')).toBe('Агент остановлен пользователем.');
    expect(aiStr('en', 'stoppedByUser')).toBe('The agent was stopped by the user.');
  });
});
