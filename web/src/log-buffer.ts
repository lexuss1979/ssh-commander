/**
 * Чистые хелперы кольцевого буфера строк для просмотрщика логов.
 * Модуль без React-зависимостей — держим чистым ради будущих юнит-тестов
 * (тест-раннера в web/ пока нет, эпик 20).
 */

export interface LogBufferState {
  lines: string[];
  pending: string;
}

/**
 * Делит накопленный текст по `\n`: полные строки уходят в буфер, неполная
 * хвостовая остаётся в `pending` до следующего чанка. Буфер обрезается до
 * `maxLines` с конца (кольцо).
 */
export function appendChunk(
  lines: string[],
  pending: string,
  chunk: string,
  maxLines: number,
): LogBufferState {
  const text = pending + chunk;
  const nl = text.lastIndexOf('\n');
  let complete: string[];
  let rest: string;
  if (nl === -1) {
    complete = [];
    rest = text;
  } else {
    complete = text.slice(0, nl).split('\n');
    rest = text.slice(nl + 1);
  }
  let next = complete.length > 0 ? [...lines, ...complete] : lines;
  if (next.length > maxLines) {
    next = next.slice(next.length - maxLines);
  }
  return { lines: next, pending: rest };
}

/** Хвост склеенного текста не длиннее `n` символов (для «В чат»). */
export function lastNChars(lines: string[], n: number): string {
  return lines.join('\n').slice(-n);
}
