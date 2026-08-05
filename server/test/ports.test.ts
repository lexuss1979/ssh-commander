import { describe, expect, it } from 'vitest';
import { parseListeners } from '../src/services/ports.js';

// ss -tulpn (root): tcp/udp, IPv4/IPv6, %iface, несколько процессов.
const SS_ROOT = `Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=123,fd=12))
udp   UNCONN 0      0              0.0.0.0:68        0.0.0.0:*    users:(("udhcpc",pid=456,fd=5))
tcp   LISTEN 0      128            0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1000,fd=3),("systemd",pid=1,fd=45))
tcp   LISTEN 0      511          127.0.0.1:8080      0.0.0.0:*    users:(("node",pid=2000,fd=20))
tcp   LISTEN 0      511                 [::]:80           [::]:*    users:(("nginx",pid=3000,fd=6))
`;

// ss -tulpn без root: колонки users нет вообще.
const SS_UNPRIV = `Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
tcp   LISTEN 0      128            0.0.0.0:22        0.0.0.0:*
tcp   ESTAB  0      0         10.0.0.2:22        10.0.0.5:51234
`;

// netstat -tulpn: у udp нет колонки состояния, `-` вместо pid/prog при нехватке прав.
const NETSTAT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1000/sshd
tcp        0      0 127.0.0.1:3306          0.0.0.0:*               LISTEN      -
tcp6       0      0 :::80                   :::*                    LISTEN      3000/nginx
udp        0      0 0.0.0.0:68              0.0.0.0:*                           456/udhcpc
udp6       0      0 :::546                  :::*                                -
`;

describe('parseListeners (ss)', () => {
  it('parses tcp/udp listeners with processes and scopes', () => {
    const ports = parseListeners(SS_ROOT);
    expect(ports).toHaveLength(5);

    const sshd = ports.find((p) => p.port === 22);
    expect(sshd).toMatchObject({
      proto: 'tcp',
      host: '0.0.0.0',
      pid: 1000,
      process: 'sshd, systemd',
      scope: 'public',
    });

    const dns = ports.find((p) => p.port === 53);
    expect(dns).toMatchObject({ proto: 'udp', host: '127.0.0.53%lo', scope: 'loopback' });

    const web = ports.find((p) => p.port === 80);
    expect(web).toMatchObject({ proto: 'tcp', host: '::', scope: 'public' });

    const local = ports.find((p) => p.port === 8080);
    expect(local).toMatchObject({ host: '127.0.0.1', scope: 'loopback', process: 'node' });
  });

  it('sorts by port ascending', () => {
    const ports = parseListeners(SS_ROOT);
    expect(ports.map((p) => p.port)).toEqual([22, 53, 68, 80, 8080]);
  });

  it('works without process column and skips non-listen tcp', () => {
    const ports = parseListeners(SS_UNPRIV);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ port: 22, pid: null, process: null });
  });
});

describe('parseListeners (netstat)', () => {
  it('parses tcp/udp lines with and without state/pid', () => {
    const ports = parseListeners(NETSTAT);
    expect(ports).toHaveLength(5);

    const sshd = ports.find((p) => p.port === 22);
    expect(sshd).toMatchObject({ proto: 'tcp', pid: 1000, process: 'sshd', scope: 'public' });

    const mysql = ports.find((p) => p.port === 3306);
    expect(mysql).toMatchObject({ scope: 'loopback', pid: null, process: null });

    const web = ports.find((p) => p.port === 80);
    expect(web).toMatchObject({ proto: 'tcp', host: '::', scope: 'public' });

    const dhcp = ports.find((p) => p.port === 68);
    expect(dhcp).toMatchObject({ proto: 'udp', process: 'udhcpc' });
  });

  it('returns empty list on garbage', () => {
    expect(parseListeners('')).toEqual([]);
    expect(parseListeners('command not found\n')).toEqual([]);
  });
});
