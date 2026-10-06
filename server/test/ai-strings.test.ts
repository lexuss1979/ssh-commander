import { describe, expect, it } from 'vitest';
// The agent strings dictionary (ai/strings.ts): tool outputs and service
// notes in two languages. The ru values are pinned — the subsystem tests
// (multi-server, security-audit, disk-usage etc.) rely on them.
import { AI_STRINGS, aiStr, type AiStringKey } from '../src/ai/strings.js';

const KEYS = Object.keys(AI_STRINGS.ru) as AiStringKey[];

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('ai/strings — the ru/en dictionary parity', () => {
  it('the key sets are equal', () => {
    expect(Object.keys(AI_STRINGS.en).sort()).toEqual(Object.keys(AI_STRINGS.ru).sort());
  });

  it('the {name} placeholders match between ru and en', () => {
    for (const key of KEYS) {
      expect(placeholders(AI_STRINGS.en[key]), key).toEqual(placeholders(AI_STRINGS.ru[key]));
    }
  });

  it('no en value contains Cyrillic', () => {
    for (const key of KEYS) {
      expect(AI_STRINGS.en[key], key).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
});

describe('aiStr — interpolation', () => {
  it('substitutes {name} placeholders (strings and numbers)', () => {
    expect(aiStr('ru', 'stepLimitReached', { n: 30 })).toBe('Достигнут лимит шагов (30).');
    expect(aiStr('en', 'stepLimitReached', { n: 30 })).toBe('Step limit reached (30).');
  });

  it('without params the placeholders stay as is', () => {
    expect(aiStr('ru', 'stepLimitReached')).toBe('Достигнут лимит шагов ({n}).');
  });
});

describe('aiStr — spot checks of the pinned strings', () => {
  it('ru «Неизвестный сервер» — byte-for-byte as before (multi-server.test.ts)', () => {
    expect(aiStr('ru', 'unknownServer', { name: 'nope', available: 'a, b' })).toBe(
      'Неизвестный сервер «nope». Подключённые к диалогу серверы: a, b. ' +
        'Полный список профилей — инструмент list_servers.',
    );
  });

  it('the en variant — plain quotes instead of guillemets', () => {
    expect(aiStr('en', 'unknownServer', { name: 'nope', available: 'a, b' })).toBe(
      'Unknown server "nope". Servers attached to this dialogue: a, b. ' +
        'Full profile list — the list_servers tool.',
    );
  });

  it('stoppedByUser in both languages', () => {
    expect(aiStr('ru', 'stoppedByUser')).toBe('Агент остановлен пользователем.');
    expect(aiStr('en', 'stoppedByUser')).toBe('The agent was stopped by the user.');
  });
});
