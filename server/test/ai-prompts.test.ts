import { describe, expect, it } from 'vitest';
import {
  attachedServersNote,
  memoryPromptHeader,
  multiServerNote,
  planApprovedMessage,
  planModeInstruction,
  suggestInstruction,
  systemPromptBase,
  webSearchNote,
  type PromptLang,
} from '../src/ai/prompts.js';
import { MAX_SUGGESTION_LENGTH, SUGGEST_MARKER } from '../src/ai/suggest.js';

const CYRILLIC = /[Ѐ-ӿ]/;

/** Полная сборка системного промпта со всеми условными частями включёнными. */
function fullPrompt(lang: PromptLang): string {
  return (
    systemPromptBase(lang, 'user@host') +
    multiServerNote(lang) +
    attachedServersNote(lang, ['srv-a', 'srv-b']) +
    webSearchNote(lang) +
    suggestInstruction(lang)
  );
}

describe('ai prompts (i18n)', () => {
  it('базовый промпт обоих языков непустой и содержит маркер [[SUGGEST]]', () => {
    for (const lang of ['ru', 'en'] as const) {
      const prompt = fullPrompt(lang);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain(SUGGEST_MARKER);
    }
  });

  it('протокол [[SUGGEST]] одинаков в обоих языках: маркер и лимит длины', () => {
    for (const lang of ['ru', 'en'] as const) {
      expect(suggestInstruction(lang)).toContain(`${SUGGEST_MARKER} `);
      expect(suggestInstruction(lang)).toContain(String(MAX_SUGGESTION_LENGTH));
    }
  });

  it('ru-вариант содержит кириллицу, en-вариант — нет', () => {
    expect(fullPrompt('ru')).toMatch(CYRILLIC);
    expect(fullPrompt('en')).not.toMatch(CYRILLIC);
    expect(memoryPromptHeader('ru')).toMatch(CYRILLIC);
    expect(memoryPromptHeader('en')).not.toMatch(CYRILLIC);
    expect(planApprovedMessage('ru')).toMatch(CYRILLIC);
    expect(planApprovedMessage('en')).not.toMatch(CYRILLIC);
  });

  it('PLAN_MODE_INSTRUCTION обоих языков непустые и на своём языке', () => {
    expect(planModeInstruction('ru').length).toBeGreaterThan(0);
    expect(planModeInstruction('en').length).toBeGreaterThan(0);
    expect(planModeInstruction('ru')).toMatch(CYRILLIC);
    expect(planModeInstruction('en')).not.toMatch(CYRILLIC);
    expect(planModeInstruction('ru')).not.toBe(planModeInstruction('en'));
  });

  it('выбор по lang: варианты различаются, каждый на своём языке', () => {
    const ru = systemPromptBase('ru', 'user@host');
    const en = systemPromptBase('en', 'user@host');
    expect(ru).not.toBe(en);
    expect(ru).toMatch(CYRILLIC);
    expect(en).not.toMatch(CYRILLIC);
    // Динамическая часть (user@host) подставляется в обоих вариантах.
    expect(ru).toContain('user@host');
    expect(en).toContain('user@host');
    // Имена инструментов не переводятся.
    for (const tool of ['exec_readonly', 'security_audit', 'write_memory', 'disk_usage']) {
      expect(ru).toContain(tool);
      expect(en).toContain(tool);
    }
    // Список подключённых серверов подставляется в обоих вариантах.
    expect(attachedServersNote('ru', ['a', 'b'])).toContain('a, b');
    expect(attachedServersNote('en', ['a', 'b'])).toContain('a, b');
  });
});
