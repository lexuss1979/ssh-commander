/**
 * Pure ring-buffer-of-lines helpers for the log viewer. The module has no
 * React dependencies — kept pure for future unit tests (no test runner in
 * web/ yet, epic 20).
 */

export interface LogBufferState {
  lines: string[];
  pending: string;
}

/**
 * Splits the accumulated text by `\n`: complete lines go into the buffer,
 * the trailing partial one stays in `pending` until the next chunk. The
 * buffer is trimmed to the last `maxLines` lines (a ring).
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

/** A tail of the joined text no longer than `n` chars (for "To chat"). */
export function lastNChars(lines: string[], n: number): string {
  return lines.join('\n').slice(-n);
}
