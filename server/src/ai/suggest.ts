// Подсказка вероятного ответа пользователя (план docs/agent-suggest-plan.md):
// системный промпт обязывает модель помечать хвостовую строку финального
// ответа маркером [[SUGGEST]]. Сервер вырезает маркер до this.messages/save()
// (в персист и контекст модели попадает только чистый контент), а текст
// подсказки уходит на фронтенд отдельным WS-событием suggestion.

export const SUGGEST_MARKER = '[[SUGGEST]]';
export const MAX_SUGGESTION_LENGTH = 100;

export interface ExtractedSuggestion {
  /** Контент без хвостовой строки-маркера. */
  content: string;
  /** Валидированная подсказка (одна строка, ≤ 100 символов) или null. */
  suggestion: string | null;
}

// Только хвостовой маркер: необязательный \n перед ним, сама строка-маркер и
// текст подсказки до конца строки (+ хвостовой пробел до конца ответа).
// Маркер в середине текста — легитимный текст, регулярка его не трогает.
const SUGGESTION_RE = /\n?\[\[SUGGEST\]\][ \t]*([^\n]*)\s*$/;

/**
 * Вырезает хвостовой маркер [[SUGGEST]] и валидирует подсказку: одна строка,
 * пробелы схлопываются, пустая или длиннее MAX_SUGGESTION_LENGTH → null
 * (модель ушла в рассуждения — лучше без подсказки). Маркер вырезается из
 * контента всегда, даже когда подсказка отброшена.
 */
export function extractSuggestion(raw: string): ExtractedSuggestion {
  const match = SUGGESTION_RE.exec(raw);
  if (!match) {
    return { content: raw, suggestion: null };
  }
  const suggestion = match[1].replace(/\s+/g, ' ').trim();
  return {
    content: raw.slice(0, match.index),
    suggestion: suggestion && suggestion.length <= MAX_SUGGESTION_LENGTH ? suggestion : null,
  };
}

/** Длина максимального суффикса строки, являющегося префиксом маркера. */
function markerPrefixSuffixLength(s: string): number {
  const max = Math.min(s.length, SUGGEST_MARKER.length);
  for (let k = max; k > 0; k -= 1) {
    if (SUGGEST_MARKER.startsWith(s.slice(s.length - k))) {
      return k;
    }
  }
  return 0;
}

/**
 * Holdback-фильтр стрима против вспышки маркера в пузыре ответа (классический
 * приём stop-sequence), два режима:
 * - префиксный (начальный): удерживает суффикс стрима, совпадающий с префиксом
 *   маркера; если следующий чанк маркер не продолжает — удержанное уходит
 *   наружу сразу (максимум один чанк задержки);
 * - подавление: полный маркер (по контракту всегда хвостовой) глушит всё до
 *   конца стрима — за ним идёт только текст подсказки, и он не должен
 *   мелькать в пузыре. flush() в этом режиме ничего не отдаёт наружу.
 */
export function createSuggestionTokenFilter(onToken: (t: string) => void): {
  push(token: string): void;
  flush(): void;
} {
  let held = '';
  let suppressed = false;

  return {
    push(token: string): void {
      if (suppressed || !token) return;
      held += token;
      // Полный маркер, завершившийся даже внутри одного чанка, переводит
      // фильтр в подавление: наружу уходит только текст до маркера.
      const markerAt = held.indexOf(SUGGEST_MARKER);
      if (markerAt >= 0) {
        const before = held.slice(0, markerAt);
        held = '';
        suppressed = true;
        if (before) onToken(before);
        return;
      }
      const keep = markerPrefixSuffixLength(held);
      const emit = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      if (emit) onToken(emit);
    },
    flush(): void {
      if (suppressed || !held) return;
      onToken(held);
      held = '';
    },
  };
}
