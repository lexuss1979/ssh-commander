import { describe, expect, it } from 'vitest';
import {
  parseInspectPorts,
  toContainerPortEntry,
  type ContainerPortEntry,
} from '../src/services/container-ports.js';
import { annotateHostListeners } from '../src/routes/ports.js';
import type { PortListener } from '../src/services/ports.js';

// docker inspect — опубликованные порты IPv4 (0.0.0.0:8080 → 80/tcp).
const INSPECT_WEB = {
  Id: 'abc123',
  Name: '/web',
  HostConfig: { NetworkMode: 'bridge' },
  NetworkSettings: {
    Ports: {
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
      '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '8443' }],
    },
    Networks: {
      bridge: { IPAddress: '172.17.0.2' },
    },
  },
};

// docker inspect — exposed без публикации (5432/tcp: null).
const INSPECT_DB = {
  Id: 'def456',
  Name: '/postgres',
  HostConfig: { NetworkMode: 'bridge' },
  NetworkSettings: {
    Ports: {
      '5432/tcp': null,
    },
    Networks: {
      mynet: { IPAddress: '172.18.0.3' },
    },
  },
};

// docker inspect — host-network (порты уже в основной таблице ss).
const INSPECT_HOST = {
  Id: 'ghi789',
  Name: '/hostnet',
  HostConfig: { NetworkMode: 'host' },
  NetworkSettings: {
    Ports: {},
    Networks: {
      host: { IPAddress: '' },
    },
  },
};

// docker inspect — публикация на конкретный интерфейс.
const INSPECT_IFACE = {
  Id: 'jkl012',
  Name: '/iface-app',
  HostConfig: { NetworkMode: 'bridge' },
  NetworkSettings: {
    Ports: {
      '3000/tcp': [{ HostIp: '192.168.1.5', HostPort: '3000' }],
    },
    Networks: {
      bridge: { IPAddress: '172.17.0.5' },
    },
  },
};

// docker inspect — несколько портов, IPv6.
const INSPECT_MULTI = {
  Id: 'mno345',
  Name: '/multi',
  HostConfig: { NetworkMode: 'bridge' },
  NetworkSettings: {
    Ports: {
      '8080/tcp': [
        { HostIp: '0.0.0.0', HostPort: '8080' },
        { HostIp: '::', HostPort: '8080' },
      ],
      '9090/udp': [{ HostIp: '0.0.0.0', HostPort: '9090' }],
    },
    Networks: {
      bridge: { IPAddress: '172.17.0.10' },
    },
  },
};

describe('parseInspectPorts', () => {
  it('parses published IPv4 bindings', () => {
    const ports = parseInspectPorts(INSPECT_WEB as any);
    expect(ports).toEqual([
      { containerPort: 80, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 443, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
    ]);
  });

  it('parses exposed-but-not-published (null bindings)', () => {
    const ports = parseInspectPorts(INSPECT_DB as any);
    expect(ports).toEqual([
      { containerPort: 5432, proto: 'tcp', hostIp: null, hostPort: null },
    ]);
  });

  it('returns empty for host-network with no ports', () => {
    expect(parseInspectPorts(INSPECT_HOST as any)).toEqual([]);
  });

  it('parses interface-specific binding', () => {
    const ports = parseInspectPorts(INSPECT_IFACE as any);
    expect(ports).toEqual([
      { containerPort: 3000, proto: 'tcp', hostIp: '192.168.1.5', hostPort: 3000 },
    ]);
  });

  it('parses multiple bindings for same port (IPv4 + IPv6) and UDP', () => {
    const ports = parseInspectPorts(INSPECT_MULTI as any);
    expect(ports).toEqual([
      { containerPort: 8080, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 8080, proto: 'tcp', hostIp: '::', hostPort: 8080 },
      { containerPort: 9090, proto: 'udp', hostIp: '0.0.0.0', hostPort: 9090 },
    ]);
  });

  it('returns empty for missing NetworkSettings', () => {
    expect(parseInspectPorts({} as any)).toEqual([]);
    expect(parseInspectPorts({ NetworkSettings: {} } as any)).toEqual([]);
  });
});

describe('toContainerPortEntry', () => {
  it('maps bridge container with IP', () => {
    const entry = toContainerPortEntry(INSPECT_WEB as any);
    expect(entry).toEqual({
      containerId: 'abc123',
      name: 'web',
      networkMode: 'bridge',
      ip: '172.17.0.2',
      ports: [
        { containerPort: 80, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
        { containerPort: 443, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
      ],
    });
  });

  it('strips leading slash from name', () => {
    const entry = toContainerPortEntry(INSPECT_DB as any);
    expect(entry.name).toBe('postgres');
  });

  it('sets ip=null for host-network', () => {
    const entry = toContainerPortEntry(INSPECT_HOST as any);
    expect(entry.networkMode).toBe('host');
    expect(entry.ip).toBeNull();
  });

  it('handles missing Networks gracefully', () => {
    const entity = {
      Id: 'x',
      Name: 'no-net',
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Ports: {} },
    };
    const entry = toContainerPortEntry(entity as any);
    expect(entry.ip).toBeNull();
  });
});

describe('annotateHostListeners', () => {
  function makeListener(overrides: Partial<PortListener>): PortListener {
    return {
      proto: 'tcp',
      host: '0.0.0.0',
      port: 80,
      pid: null,
      process: null,
      scope: 'public',
      ...overrides,
    };
  }

  it('annotates matching host listeners with container info', () => {
    const listeners: PortListener[] = [
      makeListener({ port: 22, process: 'sshd' }),
      makeListener({ port: 8080, process: 'docker-proxy' }),
      makeListener({ port: 8443, process: 'docker-proxy' }),
    ];
    const containers: ContainerPortEntry[] = [
      {
        containerId: 'abc123',
        name: 'web',
        networkMode: 'bridge',
        ip: '172.17.0.2',
        ports: [
          { containerPort: 80, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
          { containerPort: 443, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
        ],
      },
    ];

    annotateHostListeners(listeners, containers);

    expect(listeners[0].container).toBeUndefined(); // sshd — не контейнер
    expect(listeners[1].container).toEqual({ id: 'abc123', name: 'web' });
    expect(listeners[2].container).toEqual({ id: 'abc123', name: 'web' });
  });

  it('does not annotate when no published ports match', () => {
    const listeners: PortListener[] = [
      makeListener({ port: 3000 }),
    ];
    const containers: ContainerPortEntry[] = [
      {
        containerId: 'x',
        name: 'db',
        networkMode: 'bridge',
        ip: '172.17.0.3',
        ports: [
          { containerPort: 5432, proto: 'tcp', hostIp: null, hostPort: null },
        ],
      },
    ];

    annotateHostListeners(listeners, containers);
    expect(listeners[0].container).toBeUndefined();
  });

  it('matches by proto and hostPort', () => {
    const listeners: PortListener[] = [
      makeListener({ proto: 'tcp', port: 9090 }),
      makeListener({ proto: 'udp', port: 9090 }),
    ];
    const containers: ContainerPortEntry[] = [
      {
        containerId: 'u',
        name: 'udp-svc',
        networkMode: 'bridge',
        ip: '172.17.0.4',
        ports: [
          { containerPort: 9090, proto: 'udp', hostIp: '0.0.0.0', hostPort: 9090 },
        ],
      },
    ];

    annotateHostListeners(listeners, containers);
    expect(listeners[0].container).toBeUndefined(); // tcp не матчится с udp
    expect(listeners[1].container).toEqual({ id: 'u', name: 'udp-svc' });
  });

  it('matches by hostIp with wildcard for 0.0.0.0', () => {
    const listeners: PortListener[] = [
      makeListener({ host: '127.0.0.1', port: 3000 }),
      makeListener({ host: '192.168.1.5', port: 3000 }),
    ];
    const containers: ContainerPortEntry[] = [
      {
        containerId: 'c1',
        name: 'iface-app',
        networkMode: 'bridge',
        ip: '172.17.0.5',
        ports: [
          { containerPort: 3000, proto: 'tcp', hostIp: '192.168.1.5', hostPort: 3000 },
        ],
      },
    ];

    annotateHostListeners(listeners, containers);
    expect(listeners[0].container).toBeUndefined(); // 127.0.0.1 не матчится с 192.168.1.5
    expect(listeners[1].container).toEqual({ id: 'c1', name: 'iface-app' });
  });

  it('wildcard 0.0.0.0 matches any host address', () => {
    const listeners: PortListener[] = [
      makeListener({ host: '127.0.0.1', port: 8080 }),
      makeListener({ host: '192.168.1.10', port: 8080 }),
    ];
    const containers: ContainerPortEntry[] = [
      {
        containerId: 'wild',
        name: 'wildcard-app',
        networkMode: 'bridge',
        ip: '172.17.0.6',
        ports: [
          { containerPort: 80, proto: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
        ],
      },
    ];

    annotateHostListeners(listeners, containers);
    expect(listeners[0].container).toEqual({ id: 'wild', name: 'wildcard-app' });
    expect(listeners[1].container).toEqual({ id: 'wild', name: 'wildcard-app' });
  });

  it('handles empty containers list', () => {
    const listeners: PortListener[] = [makeListener({ port: 80 })];
    annotateHostListeners(listeners, []);
    expect(listeners[0].container).toBeUndefined();
  });
});
