import type { AlertKind, AlertRuleState, AlertSeverity } from './types';

/**
 * The client side of alerts (epic 20): settings in localStorage, keys,
 * hysteresis and state transitions. All rule math lives on the server
 * (services/alerts.ts under unit tests); this is only the stateful glue.
 */

export interface AlertsSettings {
  enabled: boolean;
  disk: number;
  mem: number;
  load: number;
  notify: boolean;
}

export const DEFAULT_ALERTS_SETTINGS: AlertsSettings = {
  enabled: true,
  disk: 90,
  mem: 90,
  load: 2,
  notify: false,
};

const STORAGE_KEY = 'sc-alerts';

/** Tolerant read: broken/missing fields fall back to defaults. */
export function loadAlertsSettings(): AlertsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_ALERTS_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AlertsSettings>;
    const num = (v: unknown, min: number, max: number, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_ALERTS_SETTINGS.enabled,
      disk: num(parsed.disk, 50, 99, DEFAULT_ALERTS_SETTINGS.disk),
      mem: num(parsed.mem, 50, 99, DEFAULT_ALERTS_SETTINGS.mem),
      load: num(parsed.load, 0.5, 16, DEFAULT_ALERTS_SETTINGS.load),
      notify: typeof parsed.notify === 'boolean' ? parsed.notify : DEFAULT_ALERTS_SETTINGS.notify,
    };
  } catch {
    return { ...DEFAULT_ALERTS_SETTINGS };
  }
}

export function saveAlertsSettings(s: AlertsSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** An active (holding) alert — what shows up in the bell and the chips. */
export interface ActiveAlert {
  key: string;
  profileId: string;
  kind: AlertKind;
  subject?: string;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  /** The moment the alert went active (ms). */
  since: number;
}

/** Clear delta per kind: while value > threshold − delta, the alert holds. */
export const ALERT_CLEAR_DELTA: Record<AlertKind, number> = {
  'server-down': 0,
  disk: 5,
  memory: 5,
  load: 0.5,
};

export function alertKey(r: { profileId: string; kind: AlertKind; subject?: string }): string {
  return `${r.profileId}:${r.kind}:${r.subject ?? ''}`;
}

export interface MergeAlertStatesResult {
  next: Map<string, ActiveAlert>;
  fired: ActiveAlert[];
  resolved: ActiveAlert[];
}

/**
 * State transitions over the new set of rules (the universe of states =
 * the server response): a newly active one → fired; one holding by
 * hysteresis — updated without resetting since; one that cleared (the value
 * fell below the threshold minus the delta) and one missing from the
 * response — resolved.
 */
export function mergeAlertStates(
  prev: Map<string, ActiveAlert>,
  rules: AlertRuleState[],
  now: number,
): MergeAlertStatesResult {
  const next = new Map<string, ActiveAlert>();
  const fired: ActiveAlert[] = [];
  const resolved: ActiveAlert[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = alertKey(rule);
    seen.add(key);
    const existing = prev.get(key);
    if (existing) {
      const holds = rule.active || rule.value > rule.threshold - ALERT_CLEAR_DELTA[rule.kind];
      if (holds) {
        next.set(key, {
          ...existing,
          value: rule.value,
          threshold: rule.threshold,
          // The server always fills message — the text carries the current
          // value, an alert in the hysteresis zone never shows a stale figure.
          message: rule.message,
        });
      } else {
        resolved.push(existing);
      }
      continue;
    }
    if (!rule.active) continue;
    const alert: ActiveAlert = {
      key,
      profileId: rule.profileId,
      kind: rule.kind,
      ...(rule.subject !== undefined ? { subject: rule.subject } : {}),
      severity: rule.severity,
      message: rule.message,
      value: rule.value,
      threshold: rule.threshold,
      since: now,
    };
    next.set(key, alert);
    fired.push(alert);
  }
  // Keys that disappeared from the response (profile deleted, disk unmounted,
  // a load rule dropped due to unknown cores) are resolved silently.
  for (const [key, alert] of prev) {
    if (!seen.has(key)) resolved.push(alert);
  }
  return { next, fired, resolved };
}
