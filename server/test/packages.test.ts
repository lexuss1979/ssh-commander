import { describe, expect, it } from 'vitest';
import {
  buildApplyCommand,
  collectPackagesSnapshot,
  dedupeByName,
  detectPackageManager,
  detectPmCommand,
  invalidatePackagesCache,
  isUpdatesExitCode,
  listUpdatesCommand,
  parseApkVersionLt,
  parseAptList,
  parseDnfCheckUpdate,
  parseListCode,
  parsePmDetection,
  parseRebootSection,
  rebootCheckSuffix,
  snapshotCommand,
  splitListSection,
  type ExecFn,
  type PackageManager,
} from '../src/services/packages.js';
import type { ExecResult, Profile } from '../src/types.js';

const profile: Profile = {
  id: 'p1',
  name: 'test',
  host: '127.0.0.1',
  port: 22,
  username: 'test',
  authType: 'password',
  password: 'x',
};

function result(code: number | null, stdout: string, stderr = ''): ExecResult {
  return { code, stdout, stderr };
}

/** Мок exec: настраиваемое поведение по команде. */
function fakeExec(router: (command: string) => ExecResult) {
  const calls: string[] = [];
  const execFn: ExecFn = async (_p, command) => {
    calls.push(command);
    return router(command);
  };
  return { calls, execFn };
}

// ---------------------------------------------------------------------------
// parseAptList
// ---------------------------------------------------------------------------

describe('parseAptList', () => {
  it('обычные строки: имя с +/-, suite с дефисом, i386, upgradable from', () => {
    const raw = [
      'base-files/stable-security 12.4+deb12u7 amd64 [upgradable from: 12.4+deb12u5]',
      'libgcc-s1/stable 12.2.0-14+deb12u7 amd64 [upgradable from: 12.2.0-14+deb12u5]',
      'linux-libc-dev/stable 6.1.99-1 i386 [upgradable from: 6.1.76-1]',
    ].join('\n');
    const out = parseAptList(raw);
    expect(out).toEqual([
      { name: 'base-files', current: '12.4+deb12u5', available: '12.4+deb12u7', source: 'stable-security' },
      { name: 'libgcc-s1', current: '12.2.0-14+deb12u5', available: '12.2.0-14+deb12u7', source: 'stable' },
      { name: 'linux-libc-dev', current: '6.1.76-1', available: '6.1.99-1', source: 'stable' },
    ]);
  });

  it('без скобки [upgradable from:] → current null', () => {
    const out = parseAptList('nginx/stable,stable-security 1.22.1-9+deb12u3 amd64');
    expect(out[0]).toMatchObject({ name: 'nginx', current: null, available: '1.22.1-9+deb12u3', source: 'stable,stable-security' });
  });

  it('заголовок Listing… и строки без / пропускаются; пустой вывод → []', () => {
    expect(parseAptList('Listing... Done\nbash/stable 5.2.15-2+b7 amd64 [upgradable from: 5.2.15-2+b2]')).toHaveLength(1);
    expect(parseAptList('Listing... Done')).toEqual([]);
    expect(parseAptList('')).toEqual([]);
  });

  it('WARNING apt про нестабильный CLI приходит в stderr — stdout-парсер его не видит', () => {
    const stdout = 'bash/stable 5.2.15-2+b7 amd64 [upgradable from: 5.2.15-2+b2]';
    const stderr =
      "WARNING: apt does not have a stable CLI interface. Use with caution in scripts.";
    const out = parseAptList(`${stdout}`);
    expect(out).toHaveLength(1);
    // stderr не влияет на парсер stdout (на уровне сервиса он игнорируется).
    expect(stderr).toContain('WARNING');
    expect(out[0].name).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// parseDnfCheckUpdate
// ---------------------------------------------------------------------------

describe('parseDnfCheckUpdate', () => {
  it('обычные строки: name.arch version repo', () => {
    const raw = ['bash.x86_64 5.2.15-2.fc39 updates', 'kernel.x86_64 6.5.6-200.fc39 updates'].join('\n');
    const out = parseDnfCheckUpdate(raw);
    expect(out).toEqual([
      { name: 'bash.x86_64', current: null, available: '5.2.15-2.fc39', source: 'updates' },
      { name: 'kernel.x86_64', current: null, available: '6.5.6-200.fc39', source: 'updates' },
    ]);
  });

  it('имена с точками сохраняются как есть; пустой вывод → []', () => {
    const out = parseDnfCheckUpdate('libstdc++.x86_64 13.2.1-7.fc39 updates');
    expect(out[0].name).toBe('libstdc++.x86_64');
    expect(parseDnfCheckUpdate('')).toEqual([]);
  });

  it('строки короче 3 токенов пропускаются', () => {
    const raw = ['bash.x86_64 5.2.15-2.fc39 updates', 'garbage line', 'single'].join('\n');
    expect(parseDnfCheckUpdate(raw)).toHaveLength(1);
  });

  it('блок «Obsoleting Packages» не засчитывается в список обновлений', () => {
    const raw = [
      'bash.x86_64 5.2.15-2.fc39 updates',
      'kernel.x86_64 6.5.6-200.fc39 updates',
      '',
      'Obsoleting Packages',
      'oldpkg.x86_64 1.0-1 fedora',
    ].join('\n');
    expect(parseDnfCheckUpdate(raw)).toHaveLength(2);
  });

  it('заголовок «Obsoleting Packages» останавливает парсинг и без обычных обновлений', () => {
    const raw = ['Obsoleting Packages', 'oldpkg.x86_64 1.0-1 fedora'].join('\n');
    expect(parseDnfCheckUpdate(raw)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseApkVersionLt
// ---------------------------------------------------------------------------

describe('parseApkVersionLt', () => {
  it('однострочные: name-version < version (справа только версия)', () => {
    const out = parseApkVersionLt('musl-1.2.4-r2 < 1.2.5-r0');
    expect(out).toEqual([{ name: 'musl', current: '1.2.4-r2', available: '1.2.5-r0', source: null }]);
  });

  it('имя с дефисами: alpine-baselayout-3.4.3-r1 → alpine-baselayout / 3.4.3-r1', () => {
    const out = parseApkVersionLt('alpine-baselayout-3.4.3-r1 < 3.6.5-r0');
    expect(out[0]).toMatchObject({ name: 'alpine-baselayout', current: '3.4.3-r1', available: '3.6.5-r0' });
  });

  it('версия без -r-суффикса', () => {
    const out = parseApkVersionLt('zlib-1.3 < 1.3.1');
    expect(out[0]).toMatchObject({ name: 'zlib', current: '1.3', available: '1.3.1' });
  });

  it('многострочный перенос: строка без < — продолжение available предыдущей записи', () => {
    const raw = ['alpine-baselayout-3.4.3-r1 <', '  3.6.5-r0'].join('\n');
    const out = parseApkVersionLt(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'alpine-baselayout', current: '3.4.3-r1', available: '3.6.5-r0' });
  });

  it('мусор до первой записи (WARNING про APKINDEX) пропускается', () => {
    const raw = ['WARNING: Ignoring APKINDEX.xyz.tar.gz: No such file or directory', 'musl-1.2.4-r2 < 1.2.5-r0'].join('\n');
    const out = parseApkVersionLt(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('musl');
  });
});

// ---------------------------------------------------------------------------
// Детект менеджера
// ---------------------------------------------------------------------------

describe('parsePmDetection', () => {
  it('basename пути → менеджер', () => {
    expect(parsePmDetection('/usr/bin/apt-get\n')).toBe('apt');
    expect(parsePmDetection('/usr/bin/dnf')).toBe('dnf');
    expect(parsePmDetection('/sbin/apk')).toBe('apk');
    expect(parsePmDetection('/usr/bin/yum')).toBe('yum');
  });

  it('пустой вывод / незнакомая первая строка → null', () => {
    expect(parsePmDetection('')).toBeNull();
    expect(parsePmDetection('command not found')).toBeNull();
  });

  it('detectPmCommand — статическая строка ||-цепочки', () => {
    expect(detectPmCommand()).toBe('command -v apt-get || command -v dnf || command -v yum || command -v apk');
  });
});

// ---------------------------------------------------------------------------
// Команды снимка и коды
// ---------------------------------------------------------------------------

describe('listUpdatesCommand / isUpdatesExitCode / parseListCode', () => {
  it('команды по менеджеру', () => {
    expect(listUpdatesCommand('apt')).toBe('apt list --upgradable');
    expect(listUpdatesCommand('dnf')).toBe('dnf -q check-update');
    expect(listUpdatesCommand('yum')).toBe('yum -q check-update');
    expect(listUpdatesCommand('apk')).toBe("apk version -l '<'");
  });

  it('dnf/yum: 100 и 0 — ок (100 = есть обновления), 1 — нет; apt/apk: только 0', () => {
    expect(isUpdatesExitCode('dnf', 100)).toBe(true);
    expect(isUpdatesExitCode('dnf', 0)).toBe(true);
    expect(isUpdatesExitCode('dnf', 1)).toBe(false);
    expect(isUpdatesExitCode('yum', 100)).toBe(true);
    expect(isUpdatesExitCode('apt', 0)).toBe(true);
    expect(isUpdatesExitCode('apt', 100)).toBe(false);
    expect(isUpdatesExitCode('apk', 1)).toBe(false);
    expect(isUpdatesExitCode('apt', null)).toBe(false);
  });

  it('parseListCode: маркер → число; маркера нет → null', () => {
    expect(parseListCode('bash/stable 5.2 amd64\n@@LIST_CODE@@0\n')).toBe(0);
    expect(parseListCode('bash.x86_64 5.2 updates\n@@LIST_CODE@@100\n')).toBe(100);
    expect(parseListCode('bash/stable 5.2 amd64\n')).toBeNull();
  });

  it('splitListSection отрезает текст по маркеру — код и reboot-секция не попадают в парсер', () => {
    const raw = ['bash/stable 5.2 amd64 [upgradable from: 5.1]', '@@LIST_CODE@@0', '@@REBOOT@@', 'linux-image'].join('\n');
    expect(splitListSection(raw)).toBe('bash/stable 5.2 amd64 [upgradable from: 5.1]\n');
    expect(parseAptList(splitListSection(raw))).toHaveLength(1);
  });
});

describe('rebootCheckSuffix / snapshotCommand / parseRebootSection', () => {
  it('apt-суффикс печатает маркер только при существующем reboot-required и читает .pkgs', () => {
    const suffix = rebootCheckSuffix('apt');
    expect(suffix).toContain('-f /var/run/reboot-required');
    expect(suffix).toContain('@@REBOOT@@');
    expect(suffix).toContain('cat /var/run/reboot-required.pkgs 2>/dev/null');
    expect(suffix.startsWith('; ')).toBe(true);
  });

  it('dnf-суффикс: needs-restarting -r с маркером кода', () => {
    const suffix = rebootCheckSuffix('dnf');
    expect(suffix).toContain('needs-restarting -r');
    expect(suffix).toContain('@@RESTART_CODE@@$?');
  });

  it('apk — без суффикса', () => {
    expect(rebootCheckSuffix('apk')).toBe('');
  });

  it('snapshotCommand склеивает список, маркер кода и reboot-суффикс встык', () => {
    const cmd = snapshotCommand('apt');
    expect(cmd).toBe(
      'apt list --upgradable; echo "@@LIST_CODE@@$?"; if [ -f /var/run/reboot-required ]; then echo \'@@REBOOT@@\'; cat /var/run/reboot-required.pkgs 2>/dev/null; fi',
    );
    // Без разделителя между списком и echo получилась бы «…upgradableecho» — стык проверяется.
    expect(cmd).not.toContain('upgradableecho');
    expect(cmd.startsWith('apt list --upgradable; echo')).toBe(true);
  });

  it('parseRebootSection: маркера нет → {code: null, packages: []}', () => {
    expect(parseRebootSection('bash/stable 5.2 amd64\n@@LIST_CODE@@0\n')).toEqual({ code: null, packages: [] });
  });

  it('apt-секция: пакеты из .pkgs, кода нет', () => {
    const raw = '@@REBOOT@@\nlinux-image-amd64\nopenssh-server\n';
    expect(parseRebootSection(raw)).toEqual({ code: null, packages: ['linux-image-amd64', 'openssh-server'] });
  });

  it('dnf-секция: код @@RESTART_CODE@@1 и информационный вывод', () => {
    const raw = '@@REBOOT@@\nCore libraries have been updated\n@@RESTART_CODE@@1\n';
    expect(parseRebootSection(raw)).toEqual({ code: 1, packages: ['Core libraries have been updated'] });
  });
});

// ---------------------------------------------------------------------------
// buildApplyCommand
// ---------------------------------------------------------------------------

describe('buildApplyCommand', () => {
  it('с sudo: прямая форма без sh -c для всех менеджеров', () => {
    expect(buildApplyCommand('apt', true)).toBe(
      "sudo -S -p '' -- env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade",
    );
    expect(buildApplyCommand('dnf', true)).toBe("sudo -S -p '' -- dnf -y upgrade");
    expect(buildApplyCommand('yum', true)).toBe("sudo -S -p '' -- yum -y upgrade");
    expect(buildApplyCommand('apk', true)).toBe("sudo -S -p '' -- apk upgrade");
    for (const pm of ['apt', 'dnf', 'yum', 'apk'] as PackageManager[]) {
      expect(buildApplyCommand(pm, true)).not.toContain('sh -c');
    }
  });

  it('без sudo — plain-команды; всё статично, пользовательский ввод не интерполируется', () => {
    expect(buildApplyCommand('apt', false)).toBe('env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade');
    expect(buildApplyCommand('dnf', false)).toBe('dnf -y upgrade');
    expect(buildApplyCommand('yum', false)).toBe('yum -y upgrade');
    expect(buildApplyCommand('apk', false)).toBe('apk upgrade');
  });
});

// ---------------------------------------------------------------------------
// dedupeByName
// ---------------------------------------------------------------------------

describe('dedupeByName', () => {
  it('первое вхождение выигрывает', () => {
    const out = dedupeByName([
      { name: 'bash', current: '5.1', available: '5.2', source: 'stable' },
      { name: 'bash', current: '5.1', available: '5.3', source: 'stable-security' },
      { name: 'nginx', current: null, available: '1.22', source: 'stable' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].available).toBe('5.2');
  });
});

// ---------------------------------------------------------------------------
// collectPackagesSnapshot: поток через мок exec, кэш 60 с
// ---------------------------------------------------------------------------

describe('collectPackagesSnapshot', () => {
  it('менеджер не найден → снимок-заглушка (не ошибка)', async () => {
    const p1: Profile = { ...profile, id: 'pkgs-none' };
    const { execFn } = fakeExec(() => result(0, 'command not found\n'));
    const snap = await collectPackagesSnapshot(p1, { execFn });
    expect(snap.pm).toBeNull();
    expect(snap.error).toContain('Менеджер пакетов не найден');
    expect(snap.updates).toEqual([]);
    expect(snap.rebootRequired).toBe(false);
  });

  it('apt: список + reboot по маркеру + возраст индекса (SFTP недоступен → тихий null)', async () => {
    const p1: Profile = { ...profile, id: 'pkgs-apt' };
    const { calls, execFn } = fakeExec((command) => {
      if (command === detectPmCommand()) return result(0, '/usr/bin/apt-get\n');
      return result(
        0,
        'base-files/stable-security 12.4+deb12u7 amd64 [upgradable from: 12.4+deb12u5]\n' +
          '@@LIST_CODE@@0\n' +
          '@@REBOOT@@\n' +
          'linux-image-amd64\n',
      );
    });
    const snap = await collectPackagesSnapshot(p1, { execFn });
    expect(snap.pm).toBe('apt');
    expect(snap.updates).toEqual([
      { name: 'base-files', current: '12.4+deb12u5', available: '12.4+deb12u7', source: 'stable-security' },
    ]);
    expect(snap.rebootRequired).toBe(true);
    expect(snap.rebootPackages).toEqual(['linux-image-amd64']);
    expect(snap.indexAgeMs).toBeNull(); // SFTP-stat в unit-окружении недоступен — тихий null
    expect(calls).toHaveLength(2);
  });

  it('dnf: код 100 не трактуется ошибкой, список парсится', async () => {
    const p1: Profile = { ...profile, id: 'pkgs-dnf' };
    const { execFn } = fakeExec((command) => {
      if (command === detectPmCommand()) return result(0, '/usr/bin/dnf\n');
      return result(100, 'bash.x86_64 5.2.15-2.fc39 updates\n@@LIST_CODE@@100\n');
    });
    const snap = await collectPackagesSnapshot(p1, { execFn });
    expect(snap.pm).toBe('dnf');
    expect(snap.updates).toHaveLength(1);
    expect(snap.updates[0]).toMatchObject({ name: 'bash.x86_64', current: null });
    expect(snap.rebootRequired).toBe(false);
  });

  it('dnf: needs-restarting с кодом 1 → rebootRequired true', async () => {
    const p1: Profile = { ...profile, id: 'pkgs-dnf-reboot' };
    const { execFn } = fakeExec((command) => {
      if (command === detectPmCommand()) return result(0, '/usr/bin/dnf\n');
      return result(0, 'bash.x86_64 5.2.15-2.fc39 updates\n@@LIST_CODE@@0\n@@REBOOT@@\nCore libs updated\n@@RESTART_CODE@@1\n');
    });
    const snap = await collectPackagesSnapshot(p1, { execFn });
    expect(snap.rebootRequired).toBe(true);
    expect(snap.rebootPackages).toEqual(['Core libs updated']);
  });

  it('код списка не проходит isUpdatesExitCode → ошибка со stderr', async () => {
    const p1: Profile = { ...profile, id: 'pkgs-err' };
    const { execFn } = fakeExec((command) => {
      if (command === detectPmCommand()) return result(0, '/usr/bin/apt-get\n');
      return result(2, 'E: The method driver /usr/lib/apt/methods/https could not be found.\n@@LIST_CODE@@2\n');
    });
    await expect(collectPackagesSnapshot(p1, { execFn })).rejects.toThrow(/could not be found/);
  });

  it('кэш 60 с: параллельные вызовы делят один exec; инвалидация сбрасывает', async () => {
    const p1: Profile = { ...profile, id: 'cache-pkgs' };
    let execs = 0;
    const execFn: ExecFn = async (_p, command) => {
      execs += 1;
      if (command === detectPmCommand()) return result(0, '/usr/bin/apk\n');
      return result(0, 'musl-1.2.4-r2 < 1.2.5-r0\n@@LIST_CODE@@0\n');
    };
    const a = collectPackagesSnapshot(p1, { execFn });
    const b = collectPackagesSnapshot(p1, { execFn });
    expect(a).toBe(b);
    const snap = await a;
    expect(execs).toBe(2); // детект + снимок, но без повторов между a и b
    expect(snap.pm).toBe('apk');
    expect(snap.updates[0].name).toBe('musl');
    invalidatePackagesCache(p1.id);
    const c = collectPackagesSnapshot(p1, { execFn });
    expect(c).not.toBe(a);
    await c;
  });

  it('ошибочный промис удаляется из кэша — следующий вызов исполняет заново', async () => {
    const p1: Profile = { ...profile, id: 'cache-err-pkgs' };
    await expect(collectPackagesSnapshot(p1, { execFn: async () => { throw new Error('ssh down'); } })).rejects.toThrow(
      'ssh down',
    );
    let execs = 0;
    const execFn: ExecFn = async (_p, command) => {
      execs += 1;
      if (command === detectPmCommand()) return result(0, '/usr/bin/apk\n');
      return result(0, 'musl-1.2.4-r2 < 1.2.5-r0\n@@LIST_CODE@@0\n');
    };
    const snap = await collectPackagesSnapshot(p1, { execFn });
    expect(execs).toBe(2);
    expect(snap.pm).toBe('apk');
  });
});

describe('detectPackageManager', () => {
  it('свежий детект (не из кэша снимка)', async () => {
    const { execFn, calls } = fakeExec(() => result(0, '/usr/bin/yum\n'));
    const pm = await detectPackageManager(profile, { execFn });
    expect(pm).toBe('yum');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(detectPmCommand());
  });
});
