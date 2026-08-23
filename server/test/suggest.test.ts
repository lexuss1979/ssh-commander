import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTION_LENGTH,
  SUGGEST_MARKER,
  createSuggestionTokenFilter,
  extractSuggestion,
} from '../src/ai/suggest.js';

// Прогон фильтра по чанкам: возвращает всё, что ушло наружу до и после flush.
function streamChunks(chunks: string[]): string[] {
  const emitted: string[] = [];
  const filter = createSuggestionTokenFilter((t) => emitted.push(t));
  for (const chunk of chunks) filter.push(chunk);
  filter.flush();
  return emitted;
}

describe('extractSuggestion', () => {
  it('хвостовой маркер вырезается, подсказка возвращается', () => {
    const { content, suggestion } = extractSuggestion(
      'Перезапустить контейнер nginx?\n[[SUGGEST]] Да, перезапусти',
    );
    expect(content).toBe('Перезапустить контейнер nginx?');
    expect(suggestion).toBe('Да, перезапусти');
  });

  it('без маркера контент не меняется, подсказки нет', () => {
    const raw = 'Обычный ответ агента без маркера.';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });

  it('пустой ответ и null-подобный контент не ломаются', () => {
    expect(extractSuggestion('')).toEqual({ content: '', suggestion: null });
  });

  it('маркер в середине текста остаётся легитимным текстом', () => {
    const raw = 'Строка [[SUGGEST]] в середине ответа\nи вторая строка';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });

  it('пустая подсказка → null, маркер всё равно вырезан', () => {
    const { content, suggestion } = extractSuggestion('Вопрос агенту\n[[SUGGEST]]');
    expect(content).toBe('Вопрос агенту');
    expect(suggestion).toBeNull();
  });

  it('подсказка длиннее 100 символов → null, маркер вырезан', () => {
    const long = 'а'.repeat(MAX_SUGGESTION_LENGTH + 1);
    const { content, suggestion } = extractSuggestion(`Ответ\n[[SUGGEST]] ${long}`);
    expect(content).toBe('Ответ');
    expect(suggestion).toBeNull();
  });

  it('ровно 100 символов — допустимая подсказка', () => {
    const edge = 'а'.repeat(MAX_SUGGESTION_LENGTH);
    expect(extractSuggestion(`Ответ\n[[SUGGEST]] ${edge}`).suggestion).toBe(edge);
  });

  it('пробелы и переводы строк в подсказке схлопываются в один пробел', () => {
    const { suggestion } = extractSuggestion('Ответ\n[[SUGGEST]]   Да,   перезапусти\t nginx  \n');
    expect(suggestion).toBe('Да, перезапусти nginx');
  });

  it('перевод строки перед маркером и хвост после подсказки подрезаются', () => {
    const { content } = extractSuggestion('Ответ агента\n[[SUGGEST]] Да\n\n');
    expect(content).toBe('Ответ агента');
  });

  it('многострочный ответ с код-блоком, оканчивающимся на ], не путается с маркером', () => {
    const raw = 'Конфиг такой:\n```json\n["a", "b"]\n```\n\nКонец ответа.';
    expect(extractSuggestion(raw)).toEqual({ content: raw, suggestion: null });
  });
});

describe('createSuggestionTokenFilter', () => {
  const marked = `Контейнер работает.\n${SUGGEST_MARKER} Да, перезапусти nginx`;

  it('маркер, размазанный по произвольным границам чанков, не выходит наружу', () => {
    // Все двухчастные разрезы + посимвольная подача (худший случай).
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

  it('штатный случай: после полного маркера текст подсказки тоже глушится, flush пуст', () => {
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

  it('маркер внутри одного чанка: наружу уходит только текст до маркера', () => {
    const emitted = streamChunks([marked]);
    expect(emitted.join('')).toBe('Контейнер работает.\n');
  });

  it('одиночный [ в обычном тексте удерживается ровно до следующего чанка', () => {
    const emitted: string[] = [];
    const filter = createSuggestionTokenFilter((t) => emitted.push(t));
    filter.push('массив a[');
    expect(emitted.join('')).toBe('массив a');
    filter.push('0] = 1');
    expect(emitted.join('')).toBe('массив a[0] = 1');
    filter.flush();
    expect(emitted.join('')).toBe('массив a[0] = 1');
  });

  it('flush в префиксном режиме отдаёт удержанный хвост', () => {
    const emitted: string[] = [];
    const filter = createSuggestionTokenFilter((t) => emitted.push(t));
    filter.push('ответ (см. таблицу выше[');
    expect(emitted.join('')).toBe('ответ (см. таблицу выше');
    filter.flush();
    expect(emitted.join('')).toBe('ответ (см. таблицу выше[');
  });

  it('обычный текст без следов маркера проходит без задержки', () => {
    const emitted = streamChunks(['Просто ', 'текст ', 'ответа.']);
    expect(emitted).toEqual(['Просто ', 'текст ', 'ответа.']);
  });
});
