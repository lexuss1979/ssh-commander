import type { AlertKind, AlertRuleState, AlertSeverity } from './types';

/**
 * Клиентская часть алертов (эпик 20): настройки в localStorage, ключи,
 * гистерезис и переходы состояний. Вся математика правил — на сервере
 * (services/alerts.ts под unit-тестами); здесь только stateful-клей.
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

/** Толерантное чтение: битые/отсутствующие поля заменяются дефолтами. */
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
    /* localStorage может быть недоступен */
  }
}

/** Активный (держащийся) алерт — то, что видно в колокольчике и чипах. */
export interface ActiveAlert {
  key: string;
  profileId: string;
  kind: AlertKind;
  subject?: string;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  /** Момент перехода в активное состояние (мс). */
  since: number;
}

/** Дельта снятия по kind: пока value > threshold − delta, алерт держится. */
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
 * Переходы состояний по новому набору правил (вселенная состояний = ответ
 * сервера): новый активный → fired; держащийся по гистерезису — обновляется
 * без сброса since; снявшийся (значение упало ниже порога минус дельта)
 * и пропавший из ответа — resolved.
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
          // Сервер заполняет message всегда — текст несёт текущее значение,
          // алерт в зоне гистерезиса не показывает устаревшую цифру.
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
  // Ключи, исчезнувшие из ответа (профиль удалён, диск отмонтирован,
  // load-правило пропало из-за неизвестных ядер), снимаются молча.
  for (const [key, alert] of prev) {
    if (!seen.has(key)) resolved.push(alert);
  }
  return { next, fired, resolved };
}
