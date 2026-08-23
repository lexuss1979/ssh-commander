import type { OverviewResponse } from './overview.js';

/** Пороги алертов: проценты и load на ядро. Диапазоны валидирует роут. */
export interface AlertThresholds {
  diskPercent: number; // 50..99
  memPercent: number; // 50..99
  loadPerCore: number; // 0.5..16
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  diskPercent: 90,
  memPercent: 90,
  loadPerCore: 2,
};

export type AlertKind = 'server-down' | 'disk' | 'memory' | 'load';

export type AlertSeverity = 'crit' | 'warn';

/**
 * Состояние одного правила на один тик опроса. Отдаётся и для неактивных
 * правил: гистерезис на клиенте должен видеть значение ниже порога, а не
 * только факт срабатывания.
 */
export interface AlertRuleState {
  profileId: string;
  kind: AlertKind;
  /** Точка монтирования (kind='disk'). */
  subject?: string;
  severity: AlertSeverity;
  active: boolean;
  /** server-down: 0/1; disk/memory: %; load: load1/cores (2 знака). */
  value: number;
  /** server-down: 1; disk/mem: %; load: на ядро. */
  threshold: number;
  /** Только при active=true — текст для списка/уведомления. */
  message: string | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Предложный падеж для «при N …»: «при 1 ядре», «при 2 ядрах», «при 5 ядрах». */
function pluralCoresPrepositional(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ядре';
  return 'ядрах';
}

/**
 * Чистая оценка правил по снимку overview. SSH не трогает, своего кэша нет —
 * роут ходит через кэшированный collectOverview. Отсутствующая метрика
 * (null) означает отсутствие правила: вселенная состояний определяется
 * ответом, «пропавшее» правило клиент снимает молча.
 */
export function evaluateAlertRules(
  overview: OverviewResponse,
  thresholds: AlertThresholds,
): AlertRuleState[] {
  const rules: AlertRuleState[] = [];
  for (const e of overview.servers) {
    // Недоступность — единственное crit-правило, булево (value 0/1).
    rules.push({
      profileId: e.id,
      kind: 'server-down',
      severity: 'crit',
      active: !e.ok,
      value: e.ok ? 0 : 1,
      threshold: 1,
      message: e.ok ? null : `Сервер недоступен: ${e.error ?? 'нет данных'}`,
    });
    const m = e.metrics;
    if (!m) continue;
    for (const d of m.disks) {
      if (d.usedPercent === null) continue;
      rules.push({
        profileId: e.id,
        kind: 'disk',
        subject: d.mount,
        severity: 'warn',
        active: d.usedPercent >= thresholds.diskPercent,
        value: d.usedPercent,
        threshold: thresholds.diskPercent,
        message:
          d.usedPercent >= thresholds.diskPercent
            ? `Диск «${d.mount}» занят на ${d.usedPercent.toFixed(1)}% (порог ${thresholds.diskPercent}%)`
            : null,
      });
    }
    if (m.memory.usedPercent !== null) {
      const used = m.memory.usedPercent;
      rules.push({
        profileId: e.id,
        kind: 'memory',
        severity: 'warn',
        active: used >= thresholds.memPercent,
        value: used,
        threshold: thresholds.memPercent,
        message:
          used >= thresholds.memPercent
            ? `Память занята на ${used.toFixed(1)}% (порог ${thresholds.memPercent}%)`
            : null,
      });
    }
    // Делить не на что (ядра неизвестны) — правила нет вовсе.
    const cores = m.cpu.cores;
    if (m.loadAverage !== null && cores !== null && Number.isInteger(cores) && cores > 0) {
      const value = round2(m.loadAverage[0] / cores);
      rules.push({
        profileId: e.id,
        kind: 'load',
        severity: 'warn',
        active: value >= thresholds.loadPerCore,
        value,
        threshold: thresholds.loadPerCore,
        message:
          value >= thresholds.loadPerCore
            ? `Load ${m.loadAverage[0]} при ${cores} ${pluralCoresPrepositional(cores)} (${value}/ядро, порог ${thresholds.loadPerCore})`
            : null,
      });
    }
  }
  return rules;
}
