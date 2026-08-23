import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OverviewResponse } from '../src/services/overview.js';

// Фикстура: сервер 'a' — диск 93% (порог 90 по умолчанию), память 60%,
// load 3.6 при 2 ядрах = 1.8/ядро (порог 2); сервер 'b' — память 88%,
// которая включается порогом 85, но не дефолтным 90.
const overviewFixture: OverviewResponse = {
  timestamp: 123456,
  servers: [
    {
      id: 'a',
      name: 'a',
      host: 'h',
      port: 22,
      username: 'u',
      ok: true,
      metrics: {
        timestamp: 1,
        cpu: { percent: 5, cores: 2 },
        memory: { totalBytes: 1000, availableBytes: 400, usedBytes: 600, usedPercent: 60 },
        disks: [{ filesystem: '/dev/sda1', mount: '/', totalBytes: 100, usedBytes: 93, availableBytes: 7, usedPercent: 93 }],
        uptimeSeconds: 100,
        loadAverage: [3.6, 3, 2],
        processes: [],
      },
    },
    {
      id: 'b',
      name: 'b',
      host: 'h',
      port: 22,
      username: 'u',
      ok: true,
      metrics: {
        timestamp: 1,
        cpu: { percent: 5, cores: 4 },
        memory: { totalBytes: 1000, availableBytes: 120, usedBytes: 880, usedPercent: 88 },
        disks: [],
        uptimeSeconds: 100,
        loadAverage: [1, 1, 1],
        processes: [],
      },
    },
  ],
};

vi.mock('../src/services/overview.js', () => ({
  collectOverview: vi.fn(async () => overviewFixture),
}));

const express = (await import('express')).default;
const { alertsRouter } = await import('../src/routes/alerts.js');

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/alerts', alertsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alerts`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Rule {
  profileId: string;
  kind: string;
  subject?: string;
  active: boolean;
}

function ruleBy(rules: Rule[], profileId: string, kind: string, subject?: string): Rule {
  const found = rules.find(
    (r) => r.profileId === profileId && r.kind === kind && (subject === undefined || r.subject === subject),
  );
  if (!found) throw new Error(`правило не найдено: ${profileId}/${kind}/${subject ?? ''}`);
  return found;
}

describe('GET /api/alerts', () => {
  it('без параметров — дефолты в thresholds (echo), правила формы фикстуры', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timestamp: number;
      thresholds: { diskPercent: number; memPercent: number; loadPerCore: number };
      rules: Rule[];
    };
    expect(body.timestamp).toBe(123456);
    expect(body.thresholds).toEqual({ diskPercent: 90, memPercent: 90, loadPerCore: 2 });
    expect(ruleBy(body.rules, 'a', 'disk', '/').active).toBe(true);
    expect(ruleBy(body.rules, 'a', 'memory').active).toBe(false);
    expect(ruleBy(body.rules, 'a', 'load').active).toBe(false);
    expect(ruleBy(body.rules, 'b', 'memory').active).toBe(false);
  });

  it('?disk=95&mem=85&load=1.5 — параметры применены к active фикстуры', async () => {
    const res = await fetch(`${base}?disk=95&mem=85&load=1.5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thresholds: { diskPercent: number; memPercent: number; loadPerCore: number };
      rules: Rule[];
    };
    expect(body.thresholds).toEqual({ diskPercent: 95, memPercent: 85, loadPerCore: 1.5 });
    expect(ruleBy(body.rules, 'a', 'disk', '/').active).toBe(false); // 93 < 95
    expect(ruleBy(body.rules, 'a', 'load').active).toBe(true); // 1.8 >= 1.5
    expect(ruleBy(body.rules, 'b', 'memory').active).toBe(true); // 88 >= 85
  });

  it('disk=abc → 400', async () => {
    const res = await fetch(`${base}?disk=abc`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });

  it('disk=10 (ниже диапазона) → 400', async () => {
    const res = await fetch(`${base}?disk=10`);
    expect(res.status).toBe(400);
  });

  it('load=0 (ниже диапазона) → 400', async () => {
    const res = await fetch(`${base}?load=0`);
    expect(res.status).toBe(400);
  });
});
