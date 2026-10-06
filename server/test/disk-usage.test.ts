import { describe, expect, it } from 'vitest';
import {
  AGENT_DEFAULT_LIMIT,
  AGENT_MAX_LIMIT,
  assertNavigablePath,
  buildDuCommand,
  buildTopFilesCommand,
  buildTopFilesStatCommand,
  clampAgentLimit,
  countUnreadable,
  DiskUsageError,
  diskUsageSnapshot,
  needsStatFallback,
  normalizeDiskPath,
  parseDuKb,
  parseFindOutput,
  toDuSnapshot,
  topFiles,
  type ExecFn,
} from '../src/services/disk-usage.js';
import type { ExecResult, Profile } from '../src/types.js';

describe('buildDuCommand', () => {
  it('builds du -x -d 1 -k with -- before the path', () => {
    expect(buildDuCommand('/var')).toBe("du -x -d 1 -k -- '/var'");
  });

  it('shq-escapes the path (spaces, quotes, leading dash)', () => {
    expect(buildDuCommand('/mnt/my data')).toBe("du -x -d 1 -k -- '/mnt/my data'");
    expect(buildDuCommand("/var/it's")).toBe("du -x -d 1 -k -- '/var/it'\\''s'");
    expect(buildDuCommand('/-weird')).toBe("du -x -d 1 -k -- '/-weird'");
  });
});

describe('buildTopFilesCommand / buildTopFilesStatCommand', () => {
  it('interpolates limit and builds the find|sort|head pipeline', () => {
    expect(buildTopFilesCommand('/var', 25)).toBe(
      "find '/var' -xdev -type f -printf '%s\\t%p\\n' | sort -rn | head -n 25",
    );
  });

  it('stat fallback uses -exec stat with a literal tab in the format', () => {
    const cmd = buildTopFilesStatCommand('/var', 10);
    expect(cmd).toBe(
      "find '/var' -xdev -type f -exec stat -c '%s\t%n' {} + | sort -rn | head -n 10",
    );
    // Inside single quotes — a real tab (0x09), not the two characters \t:
    // GNU stat expands escape sequences, BusyBox does not.
    expect(cmd).toContain("'%s\t%n'");
    expect(cmd).not.toContain("'%s\\t%n'");
  });
});

describe('normalizeDiskPath', () => {
  it('collapses // and strips the trailing /', () => {
    expect(normalizeDiskPath('  //var//lib/  ')).toBe('/var/lib');
    expect(normalizeDiskPath('/var///lib//')).toBe('/var/lib');
  });

  it('root stays root', () => {
    expect(normalizeDiskPath('/')).toBe('/');
    expect(normalizeDiskPath('///')).toBe('/');
  });

  it('a non-absolute path is returned as is (validated by assertNavigablePath)', () => {
    expect(normalizeDiskPath('var/lib')).toBe('var/lib');
  });
});

describe('assertNavigablePath', () => {
  it('accepts absolute paths, including the root', () => {
    expect(assertNavigablePath('/')).toBe('/');
    expect(assertNavigablePath('/var/log')).toBe('/var/log');
  });

  it('rejects non-absolute paths and .. segments', () => {
    expect(() => assertNavigablePath('var')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('../etc')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('/var/../etc')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('/var/..')).toThrow(DiskUsageError);
  });
});

describe('parseDuKb', () => {
  // GNU and BusyBox du print the directory itself as the last line (post-order),
  // after its children; the parser looks it up by path, not by position.
  const OUTPUT = [
    '4096\t/var/log',
    '3072\t/var/cache',
    '10240\t/var',
  ].join('\n');

  it('finds the total line by path and collects children', () => {
    const { totalKb, children } = parseDuKb(OUTPUT, '/var');
    expect(totalKb).toBe(10240);
    expect(children).toEqual([
      { path: '/var/log', kb: 4096 },
      { path: '/var/cache', kb: 3072 },
    ]);
  });

  it('tolerates paths with spaces (separator is the first tab)', () => {
    const { totalKb, children } = parseDuKb('512\t/var/log with spaces\n1024\t/var', '/var');
    expect(totalKb).toBe(1024);
    expect(children).toEqual([{ path: '/var/log with spaces', kb: 512 }]);
  });

  it('skips foreign paths (not starting with basePath + /)', () => {
    const { children } = parseDuKb('8\t/etc/passwd\n4\t/var/tmp\n9\t/var', '/var');
    expect(children).toEqual([{ path: '/var/tmp', kb: 4 }]);
  });

  it('for the root, children are all absolute paths except the root itself', () => {
    const { totalKb, children } = parseDuKb('4\t/etc\n6\t/var\n12\t/', '/');
    expect(totalKb).toBe(12);
    expect(children).toEqual([
      { path: '/etc', kb: 4 },
      { path: '/var', kb: 6 },
    ]);
  });

  it('drops garbage and a truncated tail without a tab', () => {
    const { totalKb, children } = parseDuKb(
      'du: cannot read directory\n4096\t/var/log\n10240',
      '/var',
    );
    expect(totalKb).toBeNull();
    expect(children).toEqual([{ path: '/var/log', kb: 4096 }]);
  });

  it('missing total line → totalKb null (a sign of truncated output)', () => {
    const { totalKb } = parseDuKb('4096\t/var/log\n3072\t/var/cache', '/var');
    expect(totalKb).toBeNull();
  });
});

describe('toDuSnapshot', () => {
  it('sorts descending, computes shares and directBytes = total − Σ children', () => {
    const snap = toDuSnapshot('/var', 10, [
      { path: '/var/cache', kb: 3 },
      { path: '/var/log', kb: 4 },
      { path: '/var/www', kb: 2 },
    ]);
    expect(snap.totalBytes).toBe(10 * 1024);
    expect(snap.directBytes).toBe(1 * 1024); // 10 − (3+4+2)
    expect(snap.truncated).toBe(false);
    expect(snap.children.map((c) => c.name)).toEqual(['log', 'cache', 'www']);
    expect(snap.children[0]).toMatchObject({ path: '/var/log', bytes: 4 * 1024, pctOfParent: 40 });
  });

  it('rounds pct to 1 decimal', () => {
    const snap = toDuSnapshot('/var', 3, [{ path: '/var/log', kb: 1 }]);
    expect(snap.children[0].pctOfParent).toBe(33.3);
  });

  it('clamps directBytes ≥ 0 on a mismatch (unclosed deleted files etc.)', () => {
    const snap = toDuSnapshot('/var', 5, [{ path: '/var/log', kb: 7 }]);
    expect(snap.directBytes).toBe(0);
  });

  it('empty children list — directBytes equals total', () => {
    const snap = toDuSnapshot('/var', 8, []);
    expect(snap.directBytes).toBe(8 * 1024);
    expect(snap.children).toEqual([]);
  });

  it('totalKb null with non-empty children — degradation: sum over children, truncated', () => {
    const snap = toDuSnapshot('/var', null, [
      { path: '/var/log', kb: 4 },
      { path: '/var/cache', kb: 6 },
    ]);
    expect(snap.totalBytes).toBe(10 * 1024);
    expect(snap.directBytes).toBe(0);
    expect(snap.truncated).toBe(true);
    // shares are computed from the sum over children — the total line was lost
    expect(snap.children[0]).toMatchObject({ path: '/var/cache', bytes: 6 * 1024, pctOfParent: 60 });
  });

  it('totalKb null without children — error', () => {
    expect(() => toDuSnapshot('/var', null, [])).toThrow(DiskUsageError);
  });
});

describe('parseFindOutput', () => {
  it('parses size\\tpath lines and sorts descending', () => {
    const files = parseFindOutput('2048\t/big file\n1024\t/a\n4096\t/zzz\n');
    expect(files).toEqual([
      { path: '/zzz', bytes: 4096 },
      { path: '/big file', bytes: 2048 },
      { path: '/a', bytes: 1024 },
    ]);
  });

  it('drops an incomplete tail line and garbage', () => {
    const files = parseFindOutput('1024\t/a\n512\nmусор\n');
    expect(files).toEqual([{ path: '/a', bytes: 1024 }]);
  });
});

describe('countUnreadable', () => {
  it('counts permission-denied lines and ignores unrelated stderr', () => {
    const stderr = [
      "du: cannot read directory '/root': Permission denied",
      "du: cannot access '/root/.cache': Operation not permitted",
      'normal message',
      'du: warning: something else',
    ].join('\n');
    expect(countUnreadable(stderr)).toBe(2);
  });

  it('empty stderr — 0', () => {
    expect(countUnreadable('')).toBe(0);
  });
});

describe('needsStatFallback', () => {
  it('catches find failure wordings of GNU, BusyBox and BSD', () => {
    expect(needsStatFallback('find: unrecognized: -printf')).toBe(true);
    expect(needsStatFallback("find: unknown predicate `-printf'")).toBe(true);
    expect(needsStatFallback('find: -printf: unknown primary or operator')).toBe(true);
    expect(needsStatFallback('find: invalid option -- x')).toBe(true);
    expect(needsStatFallback('find: option not supported')).toBe(true);
  });

  it('does not fire on empty or unrelated stderr', () => {
    expect(needsStatFallback('')).toBe(false);
    expect(needsStatFallback('Permission denied')).toBe(false);
    expect(needsStatFallback('find: bad option')).toBe(false);
  });
});

describe('clampAgentLimit', () => {
  it('default 10 for missing, garbage, zero and negative values', () => {
    expect(clampAgentLimit(undefined)).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit('abc')).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit(0)).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit(-5)).toBe(AGENT_DEFAULT_LIMIT);
  });

  it('passes integers in range and clamps above it', () => {
    expect(clampAgentLimit('5')).toBe(5);
    expect(clampAgentLimit(50)).toBe(50);
    expect(clampAgentLimit(51)).toBe(AGENT_MAX_LIMIT);
    expect(clampAgentLimit(500)).toBe(AGENT_MAX_LIMIT);
    expect(clampAgentLimit(12.6)).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Executor layer: deps injection (the systemd.test.ts pattern) — mocked exec
// and prechecks, no real SSH. The du cache is global per file — test paths
// are unique.
// ---------------------------------------------------------------------------

const profile = { id: 'p1' } as Profile;
const noopPrecheck = async (): Promise<void> => {};

const okExec = (stdout: string, stderr = ''): ExecFn =>
  async (): Promise<ExecResult> => ({ code: 0, stdout, stderr });

/** Hands out results in turn; repeats the last one when exhausted. */
function fakeExec(results: Array<() => Promise<ExecResult>>): { calls: string[]; execFn: ExecFn } {
  const calls: string[] = [];
  let i = 0;
  const execFn: ExecFn = async (_p, command) => {
    calls.push(command);
    const factory = results[Math.min(i, results.length - 1)];
    i += 1;
    return factory();
  };
  return { calls, execFn };
}

describe('diskUsageSnapshot — execution', () => {
  it('builds the snapshot from du output and counts incomplete from stderr', async () => {
    const snap = await diskUsageSnapshot(profile, '/snap-1', {
      precheckFn: noopPrecheck,
      execFn: okExec(
        '4096\t/snap-1/log\n10240\t/snap-1',
        "du: cannot read directory '/snap-1/secret': Permission denied",
      ),
    });
    expect(snap.totalBytes).toBe(10240 * 1024);
    expect(snap.children[0]).toMatchObject({ path: '/snap-1/log', bytes: 4096 * 1024 });
    expect(snap.incomplete).toEqual({ unreadable: 1 });
    expect(snap.truncated).toBe(false);
  });

  it('truncated output (no total line) → truncated degradation', async () => {
    const snap = await diskUsageSnapshot(profile, '/trunc-1', {
      precheckFn: noopPrecheck,
      execFn: okExec('4096\t/trunc-1/log\n3072\t/trunc-1/cache'),
    });
    expect(snap.truncated).toBe(true);
    expect(snap.totalBytes).toBe((4096 + 3072) * 1024);
    expect(snap.directBytes).toBe(0);
  });

  it('non-zero du exit code → DiskUsageError with stderr', async () => {
    await expect(
      diskUsageSnapshot(profile, '/err-1', {
        precheckFn: noopPrecheck,
        execFn: async () => ({ code: 1, stdout: '', stderr: 'du: cannot access /err-1: No such file' }),
      }),
    ).rejects.toThrow('No such file');
  });

  it('exec timeout → DiskUsageError with the Russian text (not a 502 "server unavailable")', async () => {
    await expect(
      diskUsageSnapshot(profile, '/timeout-1', {
        precheckFn: noopPrecheck,
        execFn: async () => {
          throw new Error('Command timed out after 60000ms');
        },
      }),
    ).rejects.toThrow('Превышено время ожидания (60 с)');
  });

  it('transport error is rethrown as is (not DiskUsageError → the route returns 502)', async () => {
    const err = await diskUsageSnapshot(profile, '/transport-1', {
      precheckFn: noopPrecheck,
      execFn: async () => {
        throw new Error('SSH error: connect ECONNREFUSED 1.2.3.4:22');
      },
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DiskUsageError);
    expect(String((err as Error).message)).toContain('SSH error');
  });

  it('precheck error is a user error (400)', async () => {
    await expect(
      diskUsageSnapshot(profile, '/notdir-1', {
        precheckFn: async () => {
          throw new DiskUsageError('Это не директория');
        },
        execFn: okExec(''),
      }),
    ).rejects.toThrow('Это не директория');
  });

  it('skipPrecheck skips the precheck (agent: one check for two calls)', async () => {
    let prechecked = 0;
    const deps = {
      precheckFn: async (): Promise<void> => {
        prechecked += 1;
      },
      execFn: okExec('10240\t/skip-1'),
    };
    await diskUsageSnapshot(profile, '/skip-1', { ...deps, skipPrecheck: true });
    expect(prechecked).toBe(0);
  });

  it('2 s cache: parallel calls for one path share a single exec', async () => {
    let calls = 0;
    const deps = {
      precheckFn: noopPrecheck,
      execFn: (async (): Promise<ExecResult> => {
        calls += 1;
        return { code: 0, stdout: '10240\t/cache-1', stderr: '' };
      }) as ExecFn,
    };
    const [a, b] = await Promise.all([
      diskUsageSnapshot(profile, '/cache-1', deps),
      diskUsageSnapshot(profile, '/cache-1', deps),
    ]);
    expect(calls).toBe(1);
    expect(a.totalBytes).toBe(b.totalBytes);
  });

  it('a failed promise is evicted from the cache — the next call retries', async () => {
    let calls = 0;
    const execFn: ExecFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('SSH error: connect ECONNREFUSED');
      return { code: 0, stdout: '10240\t/cache-2', stderr: '' };
    };
    await expect(
      diskUsageSnapshot(profile, '/cache-2', { precheckFn: noopPrecheck, execFn }),
    ).rejects.toThrow('SSH error');
    const snap = await diskUsageSnapshot(profile, '/cache-2', { precheckFn: noopPrecheck, execFn });
    expect(calls).toBe(2);
    expect(snap.totalBytes).toBe(10240 * 1024);
  });
});

describe('topFiles — fallback matrix', () => {
  it('unknown -printf option → retried with the stat variant, result from the second exec', async () => {
    const { calls, execFn } = fakeExec([
      async () => ({ code: 0, stdout: '', stderr: 'find: unrecognized: -printf' }),
      async () => ({ code: 0, stdout: '1048576\t/var/big.bin\n', stderr: '' }),
    ]);
    const out = await topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn });
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('-exec stat');
    expect(out.files).toEqual([{ path: '/var/big.bin', bytes: 1048576 }]);
    expect(out.incomplete).toBeNull();
  });

  it('empty stdout with permission denials — NOT a fallback (a normally empty directory, no extra traversal)', async () => {
    const { calls, execFn } = fakeExec([
      async () => ({
        code: 0,
        stdout: '',
        stderr: "find: cannot read directory '/var/secret': Permission denied",
      }),
    ]);
    const out = await topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn });
    expect(calls.length).toBe(1);
    expect(out.files).toEqual([]);
    expect(out.incomplete).toEqual({ unreadable: 1 });
  });

  it('empty stdout with unrelated stderr — fallback (the second sign of find failure)', async () => {
    const { calls, execFn } = fakeExec([
      async () => ({ code: 0, stdout: '', stderr: 'find: something weird happened' }),
      async () => ({ code: 0, stdout: '512\t/x\n', stderr: '' }),
    ]);
    const out = await topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn });
    expect(calls.length).toBe(2);
    expect(out.files).toEqual([{ path: '/x', bytes: 512 }]);
  });

  it('the stat fallback also does not know the option → a clear error about the "Files" mode', async () => {
    const execFn: ExecFn = async () => ({ code: 0, stdout: '', stderr: 'find: unrecognized: -printf' });
    await expect(topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn })).rejects.toThrow(
      'режим «Файлы» недоступен на этом сервере',
    );
  });

  it('non-zero find exit code → DiskUsageError with stderr', async () => {
    const execFn: ExecFn = async () => ({ code: 2, stdout: '', stderr: 'find: no such file' });
    await expect(topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn })).rejects.toThrow(
      'find: no such file',
    );
  });

  it('find timeout → DiskUsageError with the Russian text', async () => {
    const execFn: ExecFn = async () => {
      throw new Error('Command timed out after 60000ms');
    };
    await expect(topFiles(profile, '/var', 10, { precheckFn: noopPrecheck, execFn })).rejects.toThrow(
      'Превышено время ожидания (60 с)',
    );
  });
});
