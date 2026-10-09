import { describe, expect, it } from 'vitest';
import {
  attachedServersNote,
  memoryPromptHeader,
  multiServerNote,
  planApprovedMessage,
  planModeInstruction,
  suggestInstruction,
  systemPromptBase,
  visualsNote,
  webSearchNote,
  type PromptLang,
} from '../src/ai/prompts.js';
import { MAX_SUGGESTION_LENGTH, SUGGEST_MARKER } from '../src/ai/suggest.js';

const CYRILLIC = /[Ѐ-ӿ]/;

/** The full system prompt assembly with every conditional part enabled. */
function fullPrompt(lang: PromptLang): string {
  return (
    systemPromptBase(lang, 'user@host') +
    multiServerNote(lang) +
    attachedServersNote(lang, ['srv-a', 'srv-b']) +
    webSearchNote(lang) +
    visualsNote(lang) +
    suggestInstruction(lang)
  );
}

describe('ai prompts (i18n)', () => {
  it('the base prompt of both languages is non-empty and contains the [[SUGGEST]] marker', () => {
    for (const lang of ['ru', 'en'] as const) {
      const prompt = fullPrompt(lang);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain(SUGGEST_MARKER);
    }
  });

  it('the [[SUGGEST]] protocol is identical in both languages: the marker and the length limit', () => {
    for (const lang of ['ru', 'en'] as const) {
      expect(suggestInstruction(lang)).toContain(`${SUGGEST_MARKER} `);
      expect(suggestInstruction(lang)).toContain(String(MAX_SUGGESTION_LENGTH));
    }
  });

  it('the ru variant contains Cyrillic, the en variant does not', () => {
    expect(fullPrompt('ru')).toMatch(CYRILLIC);
    expect(fullPrompt('en')).not.toMatch(CYRILLIC);
    expect(memoryPromptHeader('ru')).toMatch(CYRILLIC);
    expect(memoryPromptHeader('en')).not.toMatch(CYRILLIC);
    expect(planApprovedMessage('ru')).toMatch(CYRILLIC);
    expect(planApprovedMessage('en')).not.toMatch(CYRILLIC);
  });

  it('planModeInstruction of both languages is non-empty and in its own language', () => {
    expect(planModeInstruction('ru').length).toBeGreaterThan(0);
    expect(planModeInstruction('en').length).toBeGreaterThan(0);
    expect(planModeInstruction('ru')).toMatch(CYRILLIC);
    expect(planModeInstruction('en')).not.toMatch(CYRILLIC);
    expect(planModeInstruction('ru')).not.toBe(planModeInstruction('en'));
  });

  it('visualsNote of both languages is in its own language and carries the untranslated fence markers', () => {
    expect(visualsNote('ru')).toMatch(CYRILLIC);
    expect(visualsNote('en')).not.toMatch(CYRILLIC);
    expect(visualsNote('ru')).not.toBe(visualsNote('en'));
    for (const lang of ['ru', 'en'] as const) {
      expect(visualsNote(lang)).toContain('```mermaid');
      expect(visualsNote(lang)).toContain('```chart');
      // The chart JSON schema keys are part of the contract with the frontend parser.
      for (const key of ['"type"', '"labels"', '"series"', '"data"']) {
        expect(visualsNote(lang)).toContain(key);
      }
    }
  });

  it('the lang choice: the variants differ, each in its own language', () => {
    const ru = systemPromptBase('ru', 'user@host');
    const en = systemPromptBase('en', 'user@host');
    expect(ru).not.toBe(en);
    expect(ru).toMatch(CYRILLIC);
    expect(en).not.toMatch(CYRILLIC);
    // The dynamic part (user@host) is substituted in both variants.
    expect(ru).toContain('user@host');
    expect(en).toContain('user@host');
    // Tool names are not translated.
    for (const tool of ['exec_readonly', 'security_audit', 'write_memory', 'disk_usage']) {
      expect(ru).toContain(tool);
      expect(en).toContain(tool);
    }
    // The attached servers list is substituted in both variants.
    expect(attachedServersNote('ru', ['a', 'b'])).toContain('a, b');
    expect(attachedServersNote('en', ['a', 'b'])).toContain('a, b');
  });
});
