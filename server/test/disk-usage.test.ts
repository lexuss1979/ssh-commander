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
  needsStatFallback,
  normalizeDiskPath,
  parseDuKb,
  parseFindOutput,
  toDuSnapshot,
} from '../src/services/disk-usage.js';

describe('buildDuCommand', () => {
  it('собирает du -x -d 1 -k с -- перед путём', () => {
    expect(buildDuCommand('/var')).toBe("du -x -d 1 -k -- '/var'");
  });

  it('shq-экранирует путь (пробелы, кавычки, ведущий дефис)', () => {
    expect(buildDuCommand('/mnt/my data')).toBe("du -x -d 1 -k -- '/mnt/my data'");
    expect(buildDuCommand("/var/it's")).toBe("du -x -d 1 -k -- '/var/it'\\''s'");
    expect(buildDuCommand('/-weird')).toBe("du -x -d 1 -k -- '/-weird'");
  });
});

describe('buildTopFilesCommand / buildTopFilesStatCommand', () => {
  it('интерполирует limit и строит пайплайн find|sort|head', () => {
    expect(buildTopFilesCommand('/var', 25)).toBe(
      "find '/var' -xdev -type f -printf '%s\\t%p\\n' | sort -rn | head -n 25",
    );
  });

  it('фолбэк stat использует -exec stat с литеральным табом в формате', () => {
    const cmd = buildTopFilesStatCommand('/var', 10);
    expect(cmd).toBe(
      "find '/var' -xdev -type f -exec stat -c '%s\t%n' {} + | sort -rn | head -n 10",
    );
    // Внутри одинарных кавычек — настоящий таб (0x09), а не два символа \t:
    // GNU stat разворачивает escape-последовательность, BusyBox — нет.
    expect(cmd).toContain("'%s\t%n'");
    expect(cmd).not.toContain("'%s\\t%n'");
  });
});

describe('normalizeDiskPath', () => {
  it('схлопывает // и снимает хвостовой /', () => {
    expect(normalizeDiskPath('  //var//lib/  ')).toBe('/var/lib');
    expect(normalizeDiskPath('/var///lib//')).toBe('/var/lib');
  });

  it('корень остаётся корнем', () => {
    expect(normalizeDiskPath('/')).toBe('/');
    expect(normalizeDiskPath('///')).toBe('/');
  });

  it('не-абсолютный путь возвращается как есть (валидирует assertNavigablePath)', () => {
    expect(normalizeDiskPath('var/lib')).toBe('var/lib');
  });
});

describe('assertNavigablePath', () => {
  it('принимает абсолютные пути, включая корень', () => {
    expect(assertNavigablePath('/')).toBe('/');
    expect(assertNavigablePath('/var/log')).toBe('/var/log');
  });

  it('отвергает не-абсолютный путь и сегменты ..', () => {
    expect(() => assertNavigablePath('var')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('../etc')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('/var/../etc')).toThrow(DiskUsageError);
    expect(() => assertNavigablePath('/var/..')).toThrow(DiskUsageError);
  });
});

describe('parseDuKb', () => {
  // GNU и BusyBox du печатают сам каталог последней строкой (post-order),
  // после детей; парсер ищет его по пути, а не по позиции.
  const OUTPUT = [
    '4096\t/var/log',
    '3072\t/var/cache',
    '10240\t/var',
  ].join('\n');

  it('находит суммарную строку по пути и собирает детей', () => {
    const { totalKb, children } = parseDuKb(OUTPUT, '/var');
    expect(totalKb).toBe(10240);
    expect(children).toEqual([
      { path: '/var/log', kb: 4096 },
      { path: '/var/cache', kb: 3072 },
    ]);
  });

  it('терпим к путям с пробелами (разделитель — первый таб)', () => {
    const { totalKb, children } = parseDuKb('512\t/var/log with spaces\n1024\t/var', '/var');
    expect(totalKb).toBe(1024);
    expect(children).toEqual([{ path: '/var/log with spaces', kb: 512 }]);
  });

  it('пропускает чужие пути (не начинающиеся с basePath + /)', () => {
    const { children } = parseDuKb('8\t/etc/passwd\n4\t/var/tmp\n9\t/var', '/var');
    expect(children).toEqual([{ path: '/var/tmp', kb: 4 }]);
  });

  it('для корня детьми становятся все абсолютные пути, кроме самого корня', () => {
    const { totalKb, children } = parseDuKb('4\t/etc\n6\t/var\n12\t/', '/');
    expect(totalKb).toBe(12);
    expect(children).toEqual([
      { path: '/etc', kb: 4 },
      { path: '/var', kb: 6 },
    ]);
  });

  it('отбрасывает мусор и обрезанный хвост без таба', () => {
    const { totalKb, children } = parseDuKb(
      'du: cannot read directory\n4096\t/var/log\n10240',
      '/var',
    );
    expect(totalKb).toBeNull();
    expect(children).toEqual([{ path: '/var/log', kb: 4096 }]);
  });

  it('отсутствие суммарной строки → totalKb null (признак обрезанного вывода)', () => {
    const { totalKb } = parseDuKb('4096\t/var/log\n3072\t/var/cache', '/var');
    expect(totalKb).toBeNull();
  });
});

describe('toDuSnapshot', () => {
  it('сортирует по убыванию, считает доли и directBytes = total − Σ детей', () => {
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

  it('округляет pct до 1 знака', () => {
    const snap = toDuSnapshot('/var', 3, [{ path: '/var/log', kb: 1 }]);
    expect(snap.children[0].pctOfParent).toBe(33.3);
  });

  it('clamp directBytes ≥ 0 при расхождении (незакрытые удалённые файлы и т.п.)', () => {
    const snap = toDuSnapshot('/var', 5, [{ path: '/var/log', kb: 7 }]);
    expect(snap.directBytes).toBe(0);
  });

  it('пустой список детей — directBytes равен total', () => {
    const snap = toDuSnapshot('/var', 8, []);
    expect(snap.directBytes).toBe(8 * 1024);
    expect(snap.children).toEqual([]);
  });

  it('totalKb null при непустых детях — деградация: сумма по детям, truncated', () => {
    const snap = toDuSnapshot('/var', null, [
      { path: '/var/log', kb: 4 },
      { path: '/var/cache', kb: 6 },
    ]);
    expect(snap.totalBytes).toBe(10 * 1024);
    expect(snap.directBytes).toBe(0);
    expect(snap.truncated).toBe(true);
    // доли считаются от суммы по детям — суммарная строка потерялась
    expect(snap.children[0]).toMatchObject({ path: '/var/cache', bytes: 6 * 1024, pctOfParent: 60 });
  });

  it('totalKb null без детей — ошибка', () => {
    expect(() => toDuSnapshot('/var', null, [])).toThrow(DiskUsageError);
  });
});

describe('parseFindOutput', () => {
  it('парсит строки размер\\tпуть и сортирует по убыванию', () => {
    const files = parseFindOutput('2048\t/big file\n1024\t/a\n4096\t/zzz\n');
    expect(files).toEqual([
      { path: '/zzz', bytes: 4096 },
      { path: '/big file', bytes: 2048 },
      { path: '/a', bytes: 1024 },
    ]);
  });

  it('отбрасывает неполную хвостовую строку и мусор', () => {
    const files = parseFindOutput('1024\t/a\n512\nmусор\n');
    expect(files).toEqual([{ path: '/a', bytes: 1024 }]);
  });
});

describe('countUnreadable', () => {
  it('считает строки отказа доступа и игнорирует посторонний stderr', () => {
    const stderr = [
      "du: cannot read directory '/root': Permission denied",
      "du: cannot access '/root/.cache': Operation not permitted",
      'normal message',
      'du: warning: something else',
    ].join('\n');
    expect(countUnreadable(stderr)).toBe(2);
  });

  it('пустой stderr — 0', () => {
    expect(countUnreadable('')).toBe(0);
  });
});

describe('needsStatFallback', () => {
  it('ловит формулировки отказа find у GNU, BusyBox и BSD', () => {
    expect(needsStatFallback('find: unrecognized: -printf')).toBe(true);
    expect(needsStatFallback("find: unknown predicate `-printf'")).toBe(true);
    expect(needsStatFallback('find: -printf: unknown primary or operator')).toBe(true);
    expect(needsStatFallback('find: invalid option -- x')).toBe(true);
    expect(needsStatFallback('find: option not supported')).toBe(true);
  });

  it('не срабатывает на пустом и постороннем stderr', () => {
    expect(needsStatFallback('')).toBe(false);
    expect(needsStatFallback('Permission denied')).toBe(false);
    expect(needsStatFallback('find: bad option')).toBe(false);
  });
});

describe('clampAgentLimit', () => {
  it('дефолт 10 для отсутствующего, мусора, нуля и отрицательных', () => {
    expect(clampAgentLimit(undefined)).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit('abc')).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit(0)).toBe(AGENT_DEFAULT_LIMIT);
    expect(clampAgentLimit(-5)).toBe(AGENT_DEFAULT_LIMIT);
  });

  it('пропускает целые в диапазоне и клампит сверху', () => {
    expect(clampAgentLimit('5')).toBe(5);
    expect(clampAgentLimit(50)).toBe(50);
    expect(clampAgentLimit(51)).toBe(AGENT_MAX_LIMIT);
    expect(clampAgentLimit(500)).toBe(AGENT_MAX_LIMIT);
    expect(clampAgentLimit(12.6)).toBe(13);
  });
});
