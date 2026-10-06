// Likely-answer suggestion (plan in docs/agent-suggest-plan.md): the system
// prompt obliges the model to mark the trailing line of the final answer
// with the [[SUGGEST]] marker. The server cuts the marker before
// this.messages/save() (only clean content reaches the persist and the model
// context), and the suggestion text goes to the frontend as a separate WS
// suggestion event.

export const SUGGEST_MARKER = '[[SUGGEST]]';
export const MAX_SUGGESTION_LENGTH = 100;

export interface ExtractedSuggestion {
  /** The content without the trailing marker line. */
  content: string;
  /** The validated suggestion (a single line, ≤ 100 chars) or null. */
  suggestion: string | null;
}

// The trailing marker only: an optional \n before it, the marker line itself
// and the suggestion text to the end of the line (+ trailing whitespace to
// the end of the answer). A marker in the middle of the text is legitimate
// content — the regex leaves it alone.
const SUGGESTION_RE = /\n?\[\[SUGGEST\]\][ \t]*([^\n]*)\s*$/;

/**
 * Cuts the trailing [[SUGGEST]] marker and validates the suggestion: a single
 * line, whitespace collapsed; empty or longer than MAX_SUGGESTION_LENGTH →
 * null (the model drifted into reasoning — better no suggestion). The marker
 * is always cut from the content, even when the suggestion is discarded.
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

/** Length of the longest suffix of the string that is a prefix of the marker. */
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
 * Stream holdback filter against the marker flashing in the reply bubble
 * (the classic stop-sequence trick), two modes:
 * - prefix (initial): holds back the stream suffix that matches a prefix of
 *   the marker; if the next chunk does not continue the marker, the held
 *   text is emitted immediately (at most one chunk of delay);
 * - suppression: the full marker (by contract always trailing) mutes
 *   everything until the end of the stream — only the suggestion text comes
 *   after it, and it must not flash in the bubble. flush() in this mode
 *   emits nothing.
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
      // A full marker, even one completed within a single chunk, switches
      // the filter to suppression: only the text before the marker is emitted.
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
