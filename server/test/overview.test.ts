import { describe, expect, it } from 'vitest';
import type { Profile } from '../src/types.js';
import type { ServerMetrics } from '../src/services/metrics.js';
import {
  countContainers,
  toOverviewEntry,
  type ProfileProbe,
} from '../src/services/overview.js';

function makeProfile(id: string): Profile {
  return {
    id,
    name: `srv-${id}`,
    host: `${id}.example.com`,
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
  };
}

function makeMetrics(): ServerMetrics {
  return {
    timestamp: 1_700_000_000_000,
    cpu: { percent: 12.5, cores: 4 },
    memory: {
      totalBytes: 16_000_000_000,
      availableBytes: 8_000_000_000,
      usedBytes: 8_000_000_000,
      usedPercent: 50,
    },
    disks: [],
    uptimeSeconds: 86400,
    loadAverage: [0.1, 0.2, 0.3],
    processes: [],
  };
}

function fulfilled(probe: ProfileProbe): PromiseSettledResult<ProfileProbe> {
  return { status: 'fulfilled', value: probe };
}

function rejected(message: string): PromiseSettledResult<ProfileProbe> {
  return { status: 'rejected', reason: new Error(message) };
}

describe('countContainers', () => {
  it('counts total and running containers by State', () => {
    const summary = countContainers([
      { ID: 'a', State: 'running' },
      { ID: 'b', State: 'exited' },
      { ID: 'c', State: 'running' },
    ]);
    expect(summary).toEqual({ containersTotal: 3, containersRunning: 2 });
  });

  it('treats missing State as not running and accepts empty output', () => {
    expect(countContainers([{ ID: 'a' }])).toEqual({
      containersTotal: 1,
      containersRunning: 0,
    });
    expect(countContainers([])).toEqual({ containersTotal: 0, containersRunning: 0 });
  });
});

describe('toOverviewEntry', () => {
  it('maps a fulfilled probe with metrics and docker counters', () => {
    const entry = toOverviewEntry(
      makeProfile('a1'),
      fulfilled({
        metrics: makeMetrics(),
        docker: { containersTotal: 5, containersRunning: 2 },
      }),
    );
    expect(entry).toMatchObject({
      id: 'a1',
      name: 'srv-a1',
      host: 'a1.example.com',
      port: 22,
      username: 'root',
      ok: true,
      docker: { containersTotal: 5, containersRunning: 2 },
    });
    expect(entry.metrics?.cpu.percent).toBe(12.5);
    expect(entry.error).toBeUndefined();
  });

  it('omits docker when unavailable but metrics succeeded', () => {
    const entry = toOverviewEntry(makeProfile('b2'), fulfilled({ metrics: makeMetrics() }));
    expect(entry.ok).toBe(true);
    expect(entry.metrics).toBeDefined();
    expect(entry.docker).toBeUndefined();
    expect(entry.externalIp).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  it('passes through externalIp when detected', () => {
    const entry = toOverviewEntry(
      makeProfile('e5'),
      fulfilled({ metrics: makeMetrics(), externalIp: '203.0.113.10' }),
    );
    expect(entry.ok).toBe(true);
    expect(entry.externalIp).toBe('203.0.113.10');
  });

  it('maps a rejected probe to ok:false with the error message', () => {
    const entry = toOverviewEntry(makeProfile('c3'), rejected('Connection refused'));
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('Connection refused');
    expect(entry.metrics).toBeUndefined();
    expect(entry.docker).toBeUndefined();
  });

  it('stringifies non-Error rejection reasons', () => {
    const entry = toOverviewEntry(makeProfile('d4'), {
      status: 'rejected',
      reason: 'boom',
    });
    expect(entry).toMatchObject({ ok: false, error: 'boom' });
  });

  it('mixed settled results map independently (part of fleet down)', () => {
    const profiles = [makeProfile('ok1'), makeProfile('bad'), makeProfile('ok2')];
    const results: Array<PromiseSettledResult<ProfileProbe>> = [
      fulfilled({ metrics: makeMetrics() }),
      rejected('timed out'),
      fulfilled({
        metrics: makeMetrics(),
        docker: { containersTotal: 1, containersRunning: 1 },
      }),
    ];
    const entries = profiles.map((p, i) => toOverviewEntry(p, results[i]));
    expect(entries.map((e) => e.ok)).toEqual([true, false, true]);
    expect(entries[1].error).toBe('timed out');
    expect(entries[2].docker?.containersRunning).toBe(1);
  });

  it('all profiles down: every entry is ok:false, no throw', () => {
    const profiles = [makeProfile('x1'), makeProfile('x2')];
    const entries = profiles.map((p) =>
      toOverviewEntry(p, rejected('Сервер недоступен')),
    );
    expect(entries.every((e) => !e.ok && e.error === 'Сервер недоступен')).toBe(true);
  });
});
