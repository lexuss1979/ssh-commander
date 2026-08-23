import { describe, expect, it } from 'vitest';
// Модуль клиента алертов — чистый TypeScript без React/DOM (localStorage
// только в load/save), поэтому покрывается раннером сервера напрямую.
import {
  ALERT_CLEAR_DELTA,
  alertKey,
  loadAlertsSettings,
  mergeAlertStates,
  type ActiveAlert,
} from '../../web/src/alerts.js';
import type { AlertRuleState } from '../../web/src/types.js';

function rule(over: Partial<AlertRuleState>): AlertRuleState {
  return {
    profileId: 'p1',
    kind: 'disk',
    severity: 'warn',
    active: false,
    value: 50,
    threshold: 90,
    message: '',
    ...over,
  };
}

function active(kind: AlertRuleState['kind'], subject: string | undefined, since: number): ActiveAlert {
  return {
    key: alertKey({ profileId: 'p1', kind, subject }),
    profileId: 'p1',
    ...(subject !== undefined ? { subject } : {}),
    kind,
    severity: 'warn',
    message: 'старое сообщение',
    value: 93.4,
    threshold: 90,
    since,
  };
}

describe('ALERT_CLEAR_DELTA / alertKey', () => {
  it('дельты снятия по kind', () => {
    expect(ALERT_CLEAR_DELTA).toEqual({
      'server-down': 0,
      disk: 5,
      memory: 5,
      load: 0.5,
    });
  });

  it('ключ включает subject, без subject — пустой хвост', () => {
    expect(alertKey({ profileId: 'a', kind: 'disk', subject: '/data' })).toBe('a:disk:/data');
    expect(alertKey({ profileId: 'a', kind: 'memory' })).toBe('a:memory:');
  });
});

describe('mergeAlertStates', () => {
  it('новое активное правило → fired с since: now; неактивное — пропуск', () => {
    const now = 1000;
    const { next, fired, resolved } = mergeAlertStates(
      new Map(),
      [
        rule({ kind: 'disk', subject: '/', active: true, value: 93, message: 'Диск «/» …' }),
        rule({ kind: 'memory', active: false, value: 60, message: 'Память …' }),
      ],
      now,
    );
    expect(fired).toHaveLength(1);
    expect(fired[0].since).toBe(now);
    expect(fired[0].message).toBe('Диск «/» …');
    expect(next.size).toBe(1);
    expect(resolved).toEqual([]);
  });

  it('гистерезис: inactive в зоне порог−дельта держится, message/value обновляются, since сохраняется', () => {
    const prev = new Map([['p1:disk:/', active('disk', '/', 500)]]);
    // 87 > 90 − 5 — держится; сервер теперь присылает message всегда,
    // текст несёт текущую цифру.
    const { next, fired, resolved } = mergeAlertStates(
      prev,
      [rule({ kind: 'disk', subject: '/', active: false, value: 87, message: 'Диск «/» занят на 87.0%' })],
      2000,
    );
    expect(next.size).toBe(1);
    const held = next.get('p1:disk:/')!;
    expect(held.since).toBe(500);
    expect(held.value).toBe(87);
    expect(held.message).toBe('Диск «/» занят на 87.0%');
    expect(fired).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('снятие: value ≤ порога − дельта → resolved (граница включительно)', () => {
    const prev = new Map([['p1:disk:/', active('disk', '/', 500)]]);
    const { next, resolved } = mergeAlertStates(
      prev,
      [rule({ kind: 'disk', subject: '/', active: false, value: 85, threshold: 90 })],
      2000,
    );
    expect(next.size).toBe(0);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].key).toBe('p1:disk:/');
  });

  it('дельта 0 у server-down: снятие строго по переходу active', () => {
    const down = active('server-down', undefined, 500);
    const held = mergeAlertStates(
      new Map([['p1:server-down:', down]]),
      [rule({ kind: 'server-down', severity: 'crit', active: false, value: 0, threshold: 1 })],
      2000,
    );
    expect(held.next.size).toBe(0);
    expect(held.resolved).toHaveLength(1);
  });

  it('активное правило остаётся активным (не пере-fired)', () => {
    const prev = new Map([['p1:disk:/', active('disk', '/', 500)]]);
    const { next, fired } = mergeAlertStates(
      prev,
      [rule({ kind: 'disk', subject: '/', active: true, value: 95, message: '95%' })],
      2000,
    );
    expect(fired).toEqual([]);
    expect(next.get('p1:disk:/')!.value).toBe(95);
    expect(next.get('p1:disk:/')!.since).toBe(500);
  });

  it('ключ, пропавший из ответа (профиль удалён, диск отмонтирован) → resolved молча', () => {
    const prev = new Map([
      ['p1:disk:/', active('disk', '/', 500)],
      ['p1:load:', active('load', undefined, 700)],
    ]);
    const { next, resolved } = mergeAlertStates(
      prev,
      [rule({ kind: 'disk', subject: '/', active: true, value: 93 })],
      2000,
    );
    expect(next.size).toBe(1);
    expect(resolved.map((a) => a.key)).toEqual(['p1:load:']);
  });

  it('первая синхронизация (prev пуст) — активные просто кладутся в fired', () => {
    const { fired } = mergeAlertStates(
      new Map(),
      [rule({ kind: 'disk', subject: '/', active: true, value: 91 })],
      1000,
    );
    expect(fired).toHaveLength(1);
  });
});

describe('loadAlertsSettings', () => {
  it('без localStorage (Node) → дефолты, исключение проглатывается', () => {
    expect(loadAlertsSettings()).toEqual({
      enabled: true,
      disk: 90,
      mem: 90,
      load: 2,
      notify: false,
    });
  });
});
