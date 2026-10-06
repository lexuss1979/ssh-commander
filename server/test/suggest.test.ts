import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTION_LENGTH,
  SUGGEST_MARKER,
  createSuggestionTokenFilter,
  extractSuggestion,
} from '../src/ai/suggest.js';

// Run the filter over chunks: returns everything emitted before and after flush.
function streamChunks(chunks: string[]): string[] {
  const emitted: string[] = [];
  const filter = createSuggestionTokenFilter((t) => emitted.push(t));
  for (const chunk of chunks) filter.push(chunk);
  filter.flush();
  return emitted;
}

describe('extractSuggestion', () => {
  it('a trailing marker is cut out, the suggestion is returned', () => {
    const { content, suggestion } = extractSuggestion(
      'Перезапустить контейнер nginx?\n[[SUGGEST]] Да, перезапусти',
    );
    expect(content).toBe('Перезапустить контейнер nginx?');
    expect(suggestion).toBe('Да, перезапусти');
  });

  it('without a marker the content is unchanged, no suggestion', () => {
    const raw = 'Обычный ответ агента без маркера.';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });

  it('an empty response and null-like content do not break', () => {
    expect(extractSuggestion('')).toEqual({ content: '', suggestion: null });
  });

  it('a marker in the middle of the text stays legitimate text', () => {
    const raw = 'Строка [[SUGGEST]] в середине ответа\nи вторая строка';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });

  it('an empty suggestion → null, the marker is still cut out', () => {
    const { content, suggestion } = extractSuggestion('Вопрос агенту\n[[SUGGEST]]');
    expect(content).toBe('Вопрос агенту');
    expect(suggestion).toBeNull();
  });

  it('a suggestion longer than 100 characters → null, the marker is cut out', () => {
    const long = 'а'.repeat(MAX_SUGGESTION_LENGTH + 1);
    const { content, suggestion } = extractSuggestion(`Ответ\n[[SUGGEST]] ${long}`);
    expect(content).toBe('Ответ');
    expect(suggestion).toBeNull();
  });

  it('exactly 100 characters — a valid suggestion', () => {
    const edge = 'а'.repeat(MAX_SUGGESTION_LENGTH);
    expect(extractSuggestion(`Ответ\n[[SUGGEST]] ${edge}`).suggestion).toBe(edge);
  });

  it('spaces and newlines in the suggestion collapse into one space', () => {
    const { suggestion } = extractSuggestion('Ответ\n[[SUGGEST]]   Да,   перезапусти\t nginx  \n');
    expect(suggestion).toBe('Да, перезапусти nginx');
  });

  it('the newline before the marker and the tail after the suggestion are trimmed', () => {
    const { content } = extractSuggestion('Ответ агента\n[[SUGGEST]] Да\n\n');
    expect(content).toBe('Ответ агента');
  });

  it('a multi-line response with a code block ending in ] is not confused with the marker', () => {
    const raw = 'Конфиг такой:\n```json\n["a", "b"]\n```\n\nКонец ответа.';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });
});

describe('createSuggestionTokenFilter', () => {
  const marked = `Контейнер работает.\n${SUGGEST_MARKER} Да, перезапусти nginx`;

  it('a marker spread across arbitrary chunk boundaries never leaks out', () => {
    // All two-part splits + character-by-character feeding (the worst case).
    const splits: string[][] = [];
    for (let i = 1; i < marked.length; i += 1) {
      splits.push([marked.slice(0, i), marked.slice(i)]);
    }
    splits.push([...marked]);
    for (const chunks of splits) {
      const emitted = streamChunks(chunks);
      expect(emitted.join('')).toBe('Контейнер работает.\n');
    }
  });

  it('the normal case: after a complete marker the suggestion text is muted too, flush is empty', () => {
    const emitted: string[] = [];
    const filter = createSuggestionTokenFilter((t) => emitted.push(t));
    filter.push('Контейнер работает.\n');
    filter.push('[[SUG');
    filter.push('GEST]]');
    expect(emitted.join('')).toBe('Контейнер работает.\n');
    filter.push(' Да, перезапусти nginx');
    filter.push(' и ещё чанк');
    filter.flush();
    expect(emitted.join('')).toBe('Контейнер работает.\n');
  });

  it('the marker inside a single chunk: only the text before the marker goes out', () => {
    const emitted = streamChunks([marked]);
    expect(emitted.join('')).toBe('Контейнер работает.\n');
  });

  it('a lone [ in regular text is held exactly until the next chunk', () => {
    const emitted: string[] = [];
    const filter = createSuggestionTokenFilter((t) => emitted.push(t));
    filter.push('массив a[');
    expect(emitted.join('')).toBe('массив a');
    filter.push('0] = 1');
    expect(emitted.join('')).toBe('массив a[0] = 1');
    filter.flush();
    expect(emitted.join('')).toBe('массив a[0] = 1');
  });

  it('flush in prefix mode hands out the held tail', () => {
    const emitted: string[] = [];
    const filter = createSuggestionTokenFilter((t) => emitted.push(t));
    filter.push('ответ (см. таблицу выше[');
    expect(emitted.join('')).toBe('ответ (см. таблицу выше');
    filter.flush();
    expect(emitted.join('')).toBe('ответ (см. таблицу выше[');
  });

  it('regular text without any marker traces passes without delay', () => {
    const emitted = streamChunks(['Просто ', 'текст ', 'ответа.']);
    expect(emitted).toEqual(['Просто ', 'текст ', 'ответа.']);
  });
});
