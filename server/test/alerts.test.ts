import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlertRules,
  type AlertRuleState,
} from '../src/services/alerts.js';
import type { OverviewResponse, OverviewEntry } from '../src/services/overview.js';
import type { ServerMetrics } from '../src/services/metrics.js';

const T = { diskPercent: 90, memPercent: 90, loadPerCore: 2 };

function metrics(partial: Partial<ServerMetrics> = {}): ServerMetrics {
  return {
    timestamp: 1,
    cpu: { percent: 5, cores: 2 },
    memory: { totalBytes: 1000, availableBytes: 500, usedBytes: 500, usedPercent: 50 },
    disks: [{ filesystem: '/dev/sda1', mount: '/', totalBytes: 100, usedBytes: 50, availableBytes: 50, usedPercent: 50 }],
    uptimeSeconds: 100,
    loadAverage: [0.5, 0.4, 0.3],
    processes: [],
    ...partial,
  };
}

function entry(id: string, over: Partial<OverviewEntry> = {}): OverviewEntry {
  return {
    id,
    name: id,
    host: 'h',
    port: 22,
    username: 'u',
    ok: true,
    metrics: metrics(),
    ...over,
  };
}

function overview(servers: OverviewEntry[]): OverviewResponse {
  return { timestamp: 123, servers };
}

function byKind(rules: AlertRuleState[], kind: AlertRuleState['kind'], profileId?: string): AlertRuleState[] {
  return rules.filter((r) => r.kind === kind && (profileId === undefined || r.profileId === profileId));
}

describe('evaluateAlertRules: server-down', () => {
  it('недоступный профиль — crit, active, value 1, сообщение с текстом ошибки', () => {
    const rules = evaluateAlertRules(
      overview([entry('p1', { ok: false, error: 'Connection refused', metrics: undefined })]),
      T,
    );
    expect(rules).toHaveLength(1);
    const r = rules[0];
    expect(r.kind).toBe('server-down');
    expect(r.severity).toBe('crit');
    expect(r.active).toBe(true);
    expect(r.value).toBe(1);
    expect(r.threshold).toBe(1);
    expect(r.message).toBe('Сервер недоступен: Connection refused');
  });

  it('недоступный без текста ошибки — подставка «нет данных»', () => {
    const rules = evaluateAlertRules(overview([entry('p1', { ok: false, metrics: undefined })]), T);
    expect(rules[0].message).toBe('Сервер недоступен: нет данных');
  });

  it('доступный — active false, value 0, message null', () => {
    const rules = evaluateAlertRules(overview([entry('p1')]), T);
    const r = byKind(rules, 'server-down')[0];
    expect(r.active).toBe(false);
    expect(r.value).toBe(0);
    expect(r.message).toBeNull();
  });

  it('ok:true без metrics — единственное состояние server-down', () => {
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: undefined })]), T);
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe('server-down');
  });
});

describe('evaluateAlertRules: disk', () => {
  it('несколько дисков: состояние на каждый mount, subject = mount', () => {
    const m = metrics({
      disks: [
        { filesystem: '/dev/sda1', mount: '/', totalBytes: 100, usedBytes: 93, availableBytes: 7, usedPercent: 93 },
        { filesystem: '/dev/sdb1', mount: '/data', totalBytes: 100, usedBytes: 40, availableBytes: 60, usedPercent: 40 },
      ],
    });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    const disks = byKind(rules, 'disk');
    expect(disks).toHaveLength(2);
    const root = disks.find((r) => r.subject === '/')!;
    expect(root.active).toBe(true);
    expect(root.value).toBe(93);
    expect(root.message).toBe('Диск «/» занят на 93.0% (порог 90%)');
    const data = disks.find((r) => r.subject === '/data')!;
    expect(data.active).toBe(false);
    expect(data.message).toBeNull();
  });

  it('граница включительно: 90.0 при пороге 90 — active', () => {
    const m = metrics({
      disks: [{ filesystem: '/dev/sda1', mount: '/', totalBytes: 100, usedBytes: 90, availableBytes: 10, usedPercent: 90 }],
    });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    expect(byKind(rules, 'disk')[0].active).toBe(true);
  });

  it('usedPercent null — состояния нет', () => {
    const m = metrics({
      disks: [{ filesystem: '/dev/sda1', mount: '/', totalBytes: 100, usedBytes: 0, availableBytes: 100, usedPercent: null }],
    });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    expect(byKind(rules, 'disk')).toHaveLength(0);
  });
});

describe('evaluateAlertRules: memory', () => {
  it('за порогом — active с сообщением; под порогом — inactive; null — состояния нет', () => {
    const over = metrics({ memory: { totalBytes: 1, availableBytes: 0, usedBytes: 1, usedPercent: 91.2 } });
    const under = metrics({ memory: { totalBytes: 1, availableBytes: 1, usedBytes: 0, usedPercent: 40 } });
    const broken = metrics({ memory: { totalBytes: 1, availableBytes: null, usedBytes: null, usedPercent: null } });
    const rules = evaluateAlertRules(
      overview([entry('a', { metrics: over }), entry('b', { metrics: under }), entry('c', { metrics: broken })]),
      T,
    );
    const a = byKind(rules, 'memory', 'a')[0];
    expect(a.active).toBe(true);
    expect(a.message).toBe('Память занята на 91.2% (порог 90%)');
    const b = byKind(rules, 'memory', 'b')[0];
    expect(b.active).toBe(false);
    expect(byKind(rules, 'memory', 'c')).toHaveLength(0);
  });
});

describe('evaluateAlertRules: load', () => {
  it('load1 4.2 при 2 ядрах — value 2.1, active при пороге 2, исходные числа в сообщении', () => {
    const m = metrics({ cpu: { percent: 10, cores: 2 }, loadAverage: [4.2, 3, 2] });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    const r = byKind(rules, 'load')[0];
    expect(r.value).toBe(2.1);
    expect(r.active).toBe(true);
    expect(r.message).toBe('Load 4.2 при 2 ядрах (2.1/ядро, порог 2)');
  });

  it('округление до 2 знаков: 4.3 / 3 ядра — 1.43', () => {
    const m = metrics({ cpu: { percent: 10, cores: 3 }, loadAverage: [4.3, 3, 2] });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    expect(byKind(rules, 'load')[0].value).toBe(1.43);
  });

  it('под порогом — inactive с message null', () => {
    const m = metrics({ cpu: { percent: 10, cores: 4 }, loadAverage: [2, 2, 2] });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    const r = byKind(rules, 'load')[0];
    expect(r.value).toBe(0.5);
    expect(r.active).toBe(false);
    expect(r.message).toBeNull();
  });

  it('cores null или loadAverage null — состояния нет', () => {
    const noCores = metrics({ cpu: { percent: 10, cores: null } });
    const noLoad = metrics({ loadAverage: null });
    const rules = evaluateAlertRules(
      overview([entry('a', { metrics: noCores }), entry('b', { metrics: noLoad })]),
      T,
    );
    expect(byKind(rules, 'load')).toHaveLength(0);
  });

  it('cores 0 — состояния нет (делить не на что)', () => {
    const m = metrics({ cpu: { percent: 10, cores: 0 } });
    const rules = evaluateAlertRules(overview([entry('p1', { metrics: m })]), T);
    expect(byKind(rules, 'load')).toHaveLength(0);
  });
});

describe('evaluateAlertRules: общий вид', () => {
  it('несколько профилей в одном overview — правила всех', () => {
    const rules = evaluateAlertRules(
      overview([entry('a'), entry('b', { ok: false, metrics: undefined })]),
      T,
    );
    expect(rules.map((r) => r.profileId).sort()).toEqual(['a', 'a', 'a', 'a', 'b']);
  });

  it('DEFAULT_ALERT_THRESHOLDS = {90, 90, 2}', () => {
    expect(DEFAULT_ALERT_THRESHOLDS).toEqual({ diskPercent: 90, memPercent: 90, loadPerCore: 2 });
  });
});
