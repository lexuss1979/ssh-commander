/**
 * One-time contextual tips ("did you know") — the level-2 core of the
 * discoverability epic (docs/feature-discovery-plan.md). A tip is shown
 * exactly once: the flag lives in localStorage and the ✕ button dismisses
 * the banner forever. Pages may also call markTipSeen() when the feature
 * was actually used, so the tip goes away on its own.
 *
 * Pure module without React — same style as alerts.ts.
 */

export type TipId = 'agent-multi-server' | 'files-folder-download' | 'files-log-pin';

const STORAGE_KEY = 'sc-tips';

type SeenMap = Partial<Record<TipId, true>>;

function loadSeen(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Broken JSON (or a non-object value) starts from a clean map.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SeenMap;
  } catch {
    return {};
  }
}

/**
 * True when the tip was already shown and dismissed/used. When localStorage
 * is unavailable or the value is broken, returns false — the tip is shown,
 * which is the safe default (it never blocks anything).
 */
export function isTipSeen(id: TipId): boolean {
  return loadSeen()[id] === true;
}

/** Mark the tip as seen forever; write errors are ignored silently. */
export function markTipSeen(id: TipId): void {
  try {
    const seen = loadSeen();
    seen[id] = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* localStorage may be unavailable */
  }
}
