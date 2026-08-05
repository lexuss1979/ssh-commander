import { describe, expect, it } from 'vitest';
import { validateTunnelParams, getPortRange, type Tunnel } from '../src/services/tunnels.js';

describe('validateTunnelParams', () => {
  const baseParams = {
    profileId: 'test-profile',
    localPort: 10000,
    targetHost: '172.17.0.2',
    targetPort: 8080,
  };

  describe('localPort', () => {
    it('accepts port 0 (auto-select)', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, localPort: 0 }),
      ).not.toThrow();
    });

    it('accepts valid port in range', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, localPort: 10025 }),
      ).not.toThrow();
    });

    it('rejects port below range', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, localPort: 9999 }),
      ).toThrow(/вне диапазона/);
    });

    it('rejects port above range', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, localPort: 10050 }),
      ).toThrow(/вне диапазона/);
    });

    it('rejects port 0 when used as target', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetPort: 0 }),
      ).toThrow(/Недопустимый целевой порт/);
    });

    it('rejects port above 65535', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, localPort: 65536 }),
      ).toThrow(/Недопустимый локальный порт/);
    });
  });

  describe('targetHost', () => {
    it('accepts valid IP', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: '192.168.1.100' }),
      ).not.toThrow();
    });

    it('accepts valid hostname', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: 'my-server.example.com' }),
      ).not.toThrow();
    });

    it('accepts localhost', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: 'localhost' }),
      ).not.toThrow();
    });

    it('rejects empty host', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: '' }),
      ).toThrow(/Недопустимый целевой хост/);
    });

    it('rejects host with spaces', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: 'my server' }),
      ).toThrow(/недопустимые символы/);
    });

    it('rejects host with special characters', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: 'server;rm -rf /' }),
      ).toThrow(/недопустимые символы/);
    });

    it('rejects host longer than 253 chars', () => {
      const longHost = 'a'.repeat(254);
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: longHost }),
      ).toThrow(/Недопустимый целевой хост/);
    });

    it('accepts host exactly 253 chars', () => {
      const maxHost = 'a'.repeat(253);
      expect(() =>
        validateTunnelParams({ ...baseParams, targetHost: maxHost }),
      ).not.toThrow();
    });
  });

  describe('targetPort', () => {
    it('accepts valid port', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetPort: 80 }),
      ).not.toThrow();
    });

    it('rejects port 0', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetPort: 0 }),
      ).toThrow(/Недопустимый целевой порт/);
    });

    it('rejects port above 65535', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetPort: 65536 }),
      ).toThrow(/Недопустимый целевой порт/);
    });

    it('accepts boundary port 65535', () => {
      expect(() =>
        validateTunnelParams({ ...baseParams, targetPort: 65535 }),
      ).not.toThrow();
    });
  });

  describe('duplicates and limits', () => {
    it('rejects duplicate (profileId, localPort) for active tunnel', () => {
      const existing: Tunnel[] = [
        {
          id: 'tun-1',
          profileId: 'test-profile',
          localHost: '127.0.0.1',
          localPort: 10000,
          targetHost: '172.17.0.2',
          targetPort: 8080,
          status: 'active',
          createdAt: Date.now(),
        },
      ];
      expect(() =>
        validateTunnelParams(baseParams, existing),
      ).toThrow(/уже существует/);
    });

    it('allows same localPort for different profile', () => {
      const existing: Tunnel[] = [
        {
          id: 'tun-1',
          profileId: 'other-profile',
          localHost: '127.0.0.1',
          localPort: 10000,
          targetHost: '172.17.0.2',
          targetPort: 8080,
          status: 'active',
          createdAt: Date.now(),
        },
      ];
      expect(() =>
        validateTunnelParams(baseParams, existing),
      ).not.toThrow();
    });

    it('allows same localPort for closed tunnel', () => {
      const existing: Tunnel[] = [
        {
          id: 'tun-1',
          profileId: 'test-profile',
          localHost: '127.0.0.1',
          localPort: 10000,
          targetHost: '172.17.0.2',
          targetPort: 8080,
          status: 'closed',
          createdAt: Date.now(),
        },
      ];
      expect(() =>
        validateTunnelParams(baseParams, existing),
      ).not.toThrow();
    });

    it('rejects when profile has 10 active tunnels', () => {
      const existing: Tunnel[] = Array.from({ length: 10 }, (_, i) => ({
        id: `tun-${i + 1}`,
        profileId: 'test-profile',
        localHost: '127.0.0.1' as const,
        localPort: 10001 + i,
        targetHost: '172.17.0.2',
        targetPort: 8080,
        status: 'active' as const,
        createdAt: Date.now(),
      }));
      expect(() =>
        validateTunnelParams(baseParams, existing),
      ).toThrow(/лимит туннелей/);
    });

    it('allows when profile has 9 active + some closed tunnels', () => {
      const active: Tunnel[] = Array.from({ length: 9 }, (_, i) => ({
        id: `tun-${i + 1}`,
        profileId: 'test-profile',
        localHost: '127.0.0.1' as const,
        localPort: 10001 + i,
        targetHost: '172.17.0.2',
        targetPort: 8080,
        status: 'active' as const,
        createdAt: Date.now(),
      }));
      const closed: Tunnel[] = Array.from({ length: 5 }, (_, i) => ({
        id: `tun-closed-${i + 1}`,
        profileId: 'test-profile',
        localHost: '127.0.0.1' as const,
        localPort: 10020 + i,
        targetHost: '172.17.0.2',
        targetPort: 8080,
        status: 'closed' as const,
        createdAt: Date.now(),
      }));
      // Closed не считаются в лимите — 9 active + 5 closed = можно создать ещё.
      expect(() =>
        validateTunnelParams(baseParams, [...active, ...closed]),
      ).not.toThrow();
    });
  });
});

describe('getPortRange', () => {
  it('returns default range', () => {
    const range = getPortRange();
    expect(range.min).toBe(10000);
    expect(range.max).toBe(10049);
  });
});
