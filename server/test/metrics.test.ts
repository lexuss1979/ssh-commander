import { describe, expect, it } from 'vitest';
import {
  parseCores,
  parseCpuPercent,
  parseDf,
  parseLoadavg,
  parseMeminfo,
  parseMetricsOutput,
  parseProcUptime,
  parsePsAux,
} from '../src/services/metrics.js';

// Дельта между снимками: total +150, idle (idle+iowait) +100 → 33.3%.
const STAT_BEFORE = 'cpu  2255 34 2290 25563 629 0 178 0 0 0\n';
const STAT_AFTER = 'cpu  2285 34 2310 25663 629 0 178 0 0 0\n';

const PROC_STAT = `${STAT_BEFORE}cpu0 1058 17 1130 6445 158 0 124 0 0 0
cpu1 599 9 608 6469 172 0 54 0 0 0
cpu2 338 3 296 6451 145 0 0 0 0 0
cpu3 258 4 254 6196 152 0 0 0 0 0
intr 12345678
ctxt 9876543
`;

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1024000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
SwapCached:            0 kB
Active:          5242880 kB
SwapTotal:       2097152 kB
SwapFree:        2097152 kB
`;

// df -P -k: tmpfs и overlay должны отфильтроваться (страховка к -x флагам),
// /dev/sdb1 — терабайтный диск (~1.8 ТиБ).
const DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1       511750488 120033024 365063436      25% /
tmpfs              819200         0    819200       0% /dev/shm
/dev/sdb1      1953514588 524288000 1329226588      29% /mnt/data
overlay         511750488 120033024 365063436      25% /var/lib/docker
`;

const PS_AUX = `USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root           1  0.1  0.4 169876 13245 ?        Ss   Jan01   4:12 /sbin/init
www-data    1243 25,4  3.2 512000 524288 ?      S    10:15   1:03 nginx: worker process
root         666  0.0  0.1  72344  4096 ?        Ss   09:00   0:00 /usr/sbin/sshd -D
`;

describe('parseCpuPercent', () => {
  it('computes usage between two aggregate cpu lines', () => {
    expect(parseCpuPercent(STAT_BEFORE, STAT_AFTER)).toBe(33.3);
  });

  it('finds the aggregate line inside full /proc/stat', () => {
    expect(parseCpuPercent(PROC_STAT, STAT_AFTER)).toBe(33.3);
  });

  it('returns null on zero delta or garbage', () => {
    expect(parseCpuPercent(STAT_BEFORE, STAT_BEFORE)).toBeNull();
    expect(parseCpuPercent('', STAT_AFTER)).toBeNull();
    expect(parseCpuPercent('nonsense', 'nonsense')).toBeNull();
  });
});

describe('parseCores', () => {
  it('parses grep -c output', () => {
    expect(parseCores('4\n')).toBe(4);
  });

  it('returns null on garbage', () => {
    expect(parseCores('')).toBeNull();
    expect(parseCores('0')).toBeNull();
    expect(parseCores('abc')).toBeNull();
  });
});

describe('parseMeminfo', () => {
  it('parses totals and derives used', () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.totalBytes).toBe(16384000 * 1024);
    expect(m.availableBytes).toBe(8192000 * 1024);
    expect(m.usedBytes).toBe(8192000 * 1024);
    expect(m.usedPercent).toBe(50);
  });

  it('falls back to free + buffers + cached without MemAvailable', () => {
    const text = 'MemTotal: 1000000 kB\nMemFree: 100000 kB\nBuffers: 100000 kB\nCached: 300000 kB\n';
    const m = parseMeminfo(text);
    expect(m.availableBytes).toBe(500000 * 1024);
    expect(m.usedPercent).toBe(50);
  });

  it('returns nulls on garbage', () => {
    const m = parseMeminfo('not meminfo');
    expect(m.totalBytes).toBeNull();
    expect(m.usedPercent).toBeNull();
  });
});

describe('parseDf', () => {
  it('parses disks, skips pseudo filesystems and the header', () => {
    const disks = parseDf(DF);
    expect(disks).toHaveLength(2);
    expect(disks[0]).toMatchObject({
      filesystem: '/dev/sda1',
      mount: '/',
      totalBytes: 511750488 * 1024,
      usedPercent: 25,
    });
    expect(disks[1].filesystem).toBe('/dev/sdb1');
    expect(disks[1].totalBytes).toBe(1953514588 * 1024);
  });

  it('skips a localized (russian) header line', () => {
    const text = DF.replace(
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      'Файловая система 1024-блоков Использовано Доступно Вместимость Cмонтирована в',
    );
    expect(parseDf(text)).toHaveLength(2);
  });

  it('keeps mount points with spaces', () => {
    const text = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sdc1 1000000 500000 500000 50% /mnt/my disk
`;
    const disks = parseDf(text);
    expect(disks).toHaveLength(1);
    expect(disks[0].mount).toBe('/mnt/my disk');
  });

  it('returns empty on garbage', () => {
    expect(parseDf('')).toEqual([]);
    expect(parseDf('df: /proc: No such file or directory')).toEqual([]);
  });
});

describe('parseProcUptime', () => {
  it('parses /proc/uptime', () => {
    expect(parseProcUptime('1193049.25 4720344.20\n')).toBe(1193049);
  });

  it('returns null on garbage', () => {
    expect(parseProcUptime('')).toBeNull();
  });
});

describe('parseLoadavg', () => {
  it('parses /proc/loadavg', () => {
    expect(parseLoadavg('0.42 0.36 0.30 2/345 12345\n')).toEqual([0.42, 0.36, 0.3]);
  });

  it('tolerates comma decimals', () => {
    expect(parseLoadavg('0,42 0,36 0,30 2/345 12345')).toEqual([0.42, 0.36, 0.3]);
  });

  it('returns null on garbage', () => {
    expect(parseLoadavg('')).toBeNull();
  });
});

describe('parsePsAux', () => {
  it('parses rows, skips the header, keeps multi-word commands', () => {
    const procs = parsePsAux(PS_AUX);
    expect(procs).toHaveLength(3);
    expect(procs[0]).toMatchObject({ user: 'root', pid: 1, cpuPercent: 0.1, command: '/sbin/init' });
    expect(procs[1].command).toBe('nginx: worker process');
  });

  it('tolerates comma decimals in %CPU/%MEM', () => {
    const procs = parsePsAux(PS_AUX);
    expect(procs[1].cpuPercent).toBe(25.4);
    expect(procs[1].memPercent).toBe(3.2);
  });

  it('limits to 10 processes', () => {
    const rows = ['USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND'];
    for (let i = 1; i <= 15; i++) {
      rows.push(`root ${i} 0.1 0.1 1000 100 ? Ss 00:00 0:00 cmd${i}`);
    }
    expect(parsePsAux(rows.join('\n'))).toHaveLength(10);
  });

  it('returns empty on garbage', () => {
    expect(parsePsAux('')).toEqual([]);
  });
});

describe('parseMetricsOutput', () => {
  it('assembles a full snapshot from sectioned output', () => {
    const raw = [
      '@@STAT1@@',
      STAT_BEFORE.trimEnd(),
      '@@STAT2@@',
      STAT_AFTER.trimEnd(),
      '@@CORES@@',
      '4',
      '@@MEM@@',
      MEMINFO.trimEnd(),
      '@@DF@@',
      DF.trimEnd(),
      '@@UPTIME@@',
      '1193049.25 4720344.20',
      '@@LOAD@@',
      '0.42 0.36 0.30 2/345 12345',
      '@@PS@@',
      PS_AUX.trimEnd(),
      '',
    ].join('\n');
    const m = parseMetricsOutput(raw);
    expect(m.cpu.percent).toBe(33.3);
    expect(m.cpu.cores).toBe(4);
    expect(m.memory.usedPercent).toBe(50);
    expect(m.disks).toHaveLength(2);
    expect(m.uptimeSeconds).toBe(1193049);
    expect(m.loadAverage).toEqual([0.42, 0.36, 0.3]);
    expect(m.processes).toHaveLength(3);
    expect(m.timestamp).toBeGreaterThan(0);
  });

  it('degrades to nulls when sections are missing', () => {
    const m = parseMetricsOutput('');
    expect(m.cpu.percent).toBeNull();
    expect(m.cpu.cores).toBeNull();
    expect(m.memory.totalBytes).toBeNull();
    expect(m.disks).toEqual([]);
    expect(m.uptimeSeconds).toBeNull();
    expect(m.loadAverage).toBeNull();
    expect(m.processes).toEqual([]);
  });
});
