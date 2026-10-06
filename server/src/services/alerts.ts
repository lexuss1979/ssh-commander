import type { OverviewResponse } from './overview.js';

/** Alert thresholds: percentages and load per core. Ranges are validated by the route. */
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
 * State of one rule for one polling tick. Returned for inactive rules too:
 * client-side hysteresis needs to see the value below the threshold, not
 * just the fact of firing.
 */
export interface AlertRuleState {
  profileId: string;
  kind: AlertKind;
  /** Mount point (kind='disk'). */
  subject?: string;
  severity: AlertSeverity;
  active: boolean;
  /** server-down: 0/1; disk/memory: %; load: load1/cores (2 decimals). */
  value: number;
  /** server-down: 1; disk/mem: %; load: per core. */
  threshold: number;
  /**
   * Message about the current value — always filled (for inactive rules
   * too): an alert held by hysteresis shows the fresh figure, not the one
   * at which it fired.
   */
  message: string;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Prepositional case for «при N …»: «при 1 ядре», «при 2 ядрах», «при 5 ядрах». */
function pluralCoresPrepositional(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ядре';
  return 'ядрах';
}

/**
 * Pure evaluation of rules over an overview snapshot. Touches no SSH, has
 * no cache of its own — the route goes through the cached collectOverview.
 * A missing metric (null) means the rule is absent: the universe of states
 * is defined by the response, a «vanished» rule is silently cleared by the
 * client.
 */
export function evaluateAlertRules(
  overview: OverviewResponse,
  thresholds: AlertThresholds,
): AlertRuleState[] {
  const rules: AlertRuleState[] = [];
  for (const e of overview.servers) {
    // Unavailability — the only crit rule, boolean (value 0/1).
    rules.push({
      profileId: e.id,
      kind: 'server-down',
      severity: 'crit',
      active: !e.ok,
      value: e.ok ? 0 : 1,
      threshold: 1,
      message: e.ok ? 'Сервер доступен' : `Сервер недоступен: ${e.error ?? 'нет данных'}`,
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
        message: `Диск «${d.mount}» занят на ${d.usedPercent.toFixed(1)}% (порог ${thresholds.diskPercent}%)`,
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
        message: `Память занята на ${used.toFixed(1)}% (порог ${thresholds.memPercent}%)`,
      });
    }
    // Nothing to divide by (cores unknown) — no rule at all.
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
        message: `Load ${m.loadAverage[0]} при ${cores} ${pluralCoresPrepositional(cores)} (${value}/ядро, порог ${thresholds.loadPerCore})`,
      });
    }
  }
  return rules;
}
