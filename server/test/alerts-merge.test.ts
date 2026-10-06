import { describe, expect, it } from 'vitest';
// The alert client module — pure TypeScript without React/DOM (localStorage
// only in load/save), so it is covered by the server runner directly.
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
  it('the clear deltas per kind', () => {
    expect(ALERT_CLEAR_DELTA).toEqual({
      'server-down': 0,
      disk: 5,
      memory: 5,
      load: 0.5,
    });
  });

  it('the key includes the subject, without a subject — an empty tail', () => {
    expect(alertKey({ profileId: 'a', kind: 'disk', subject: '/data' })).toBe('a:disk:/data');
    expect(alertKey({ profileId: 'a', kind: 'memory' })).toBe('a:memory:');
  });
});

describe('mergeAlertStates', () => {
  it('a newly active rule → fired with since: now; an inactive one — skipped', () => {
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

  it('hysteresis: inactive within threshold−delta is held, message/value are updated, since is kept', () => {
    const prev = new Map([['p1:disk:/', active('disk', '/', 500)]]);
    // 87 > 90 − 5 — held; the server now always sends the message,
    // the text carries the current figure.
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

  it('clearing: value ≤ threshold − delta → resolved (the boundary inclusive)', () => {
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

  it('the delta 0 of server-down: cleared strictly by the active transition', () => {
    const down = active('server-down', undefined, 500);
    const held = mergeAlertStates(
      new Map([['p1:server-down:', down]]),
      [rule({ kind: 'server-down', severity: 'crit', active: false, value: 0, threshold: 1 })],
      2000,
    );
    expect(held.next.size).toBe(0);
    expect(held.resolved).toHaveLength(1);
  });

  it('an active rule stays active (not re-fired)', () => {
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

  it('a key missing from the response (a profile removed, a disk unmounted) → resolved silently', () => {
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

  it('the first sync (empty prev) — active rules simply land in fired', () => {
    const { fired } = mergeAlertStates(
      new Map(),
      [rule({ kind: 'disk', subject: '/', active: true, value: 91 })],
      1000,
    );
    expect(fired).toHaveLength(1);
  });
});

describe('loadAlertsSettings', () => {
  it('without localStorage (Node) → the defaults, the exception is swallowed', () => {
    expect(loadAlertsSettings()).toEqual({
      enabled: true,
      disk: 90,
      mem: 90,
      load: 2,
      notify: false,
    });
  });
});
