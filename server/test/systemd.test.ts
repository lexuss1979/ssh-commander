import { describe, expect, it } from 'vitest';
import {
  SERVICE_ACTIONS,
  ServiceActionError,
  assertValidUnitName,
  classifyActionFailure,
  classifySudoProbe,
  clampTail,
  collectServices,
  getServiceDetail,
  isServiceAction,
  journalctlCommand,
  mergeUnits,
  parseListUnitFiles,
  parseListUnits,
  parseShowOutput,
  parseSnapshot,
  parseVersionLine,
  readServiceLogs,
  runServiceAction,
  serviceDetailCommand,
  sudoProbeCommand,
  sudoSystemctlCommand,
  systemctlCommand,
  unitNameValid,
  type ExecFn,
} from '../src/services/systemd.js';
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

// ---------------------------------------------------------------------------
// parseListUnits
// ---------------------------------------------------------------------------

describe('parseListUnits', () => {
  it('разбирает обычный unit, имя с @, описание с пробелами (всё после 4-й колонки)', () => {
    const raw = [
      'nginx.service loaded active running A high performance web server and a reverse proxy server',
      'getty@tty1.service loaded active running Getty on tty1',
    ].join('\n');
    const units = parseListUnits(raw);
    expect(units).toEqual([
      {
        name: 'nginx.service',
        load: 'loaded',
        active: 'active',
        sub: 'running',
        description: 'A high performance web server and a reverse proxy server',
      },
      {
        name: 'getty@tty1.service',
        load: 'loaded',
        active: 'active',
        sub: 'running',
        description: 'Getty on tty1',
      },
    ]);
  });

  it('load=not-found остаётся строкой', () => {
    const units = parseListUnits('foo.service not-found inactive dead foo failed to load');
    expect(units[0]).toMatchObject({ name: 'foo.service', load: 'not-found', active: 'inactive', sub: 'dead' });
  });

  it('`-` в колонках → null', () => {
    const units = parseListUnits('cups.service - - - CUPS Scheduler');
    expect(units[0]).toMatchObject({
      name: 'cups.service',
      load: null,
      active: null,
      sub: null,
      description: 'CUPS Scheduler',
    });
  });

  it('пустой вывод → []', () => {
    expect(parseListUnits('')).toEqual([]);
  });

  it('снимает bullet ● у failed-юнитов (старые сборки без --plain)', () => {
    const units = parseListUnits('● failedsvc.service loaded failed failed Some failed unit');
    expect(units[0]).toMatchObject({
      name: 'failedsvc.service',
      load: 'loaded',
      active: 'failed',
      sub: 'failed',
      description: 'Some failed unit',
    });
  });

  it('мусорные строки отбрасываются', () => {
    const raw = [
      'Warning: some warning printed by systemd',
      'Failed to connect to bus: Host is down',
      'nginx.service loaded active running nginx',
    ].join('\n');
    const units = parseListUnits(raw);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe('nginx.service');
  });
});

// ---------------------------------------------------------------------------
// parseListUnitFiles: оба формата, STATE — всегда второе поле
// ---------------------------------------------------------------------------

describe('parseListUnitFiles', () => {
  const THREE_COL = [
    'nginx.service enabled enabled',
    'postgresql.service disabled enabled',
    'foo.service masked -',
    'bar.service static -',
    'baz.service indirect -',
    'gen.service generated -',
    'alias.service alias -',
    'bad.service bad -',
  ].join('\n');

  it('трёхколоночный формат (systemd ≥ 245): STATE берётся из fields[1], а не из последнего поля', () => {
    const files = parseListUnitFiles(THREE_COL);
    const byName = new Map(files.map((f) => [f.name, f.enabled]));
    expect(byName.get('nginx.service')).toBe('enabled');
    // preset (третья колонка) = enabled, а STATE (вторая) = disabled — проверка против регрессии
    expect(byName.get('postgresql.service')).toBe('disabled');
    expect(byName.get('foo.service')).toBe('masked');
    expect(byName.get('bar.service')).toBe('static');
    expect(byName.get('baz.service')).toBe('indirect');
    expect(byName.get('gen.service')).toBe('generated');
    expect(byName.get('alias.service')).toBe('alias');
    expect(byName.get('bad.service')).toBe('bad');
  });

  it('двухколоночный формат (старый systemd)', () => {
    const raw = ['nginx.service enabled', 'foo.service disabled', 'bar.service masked'].join('\n');
    const files = parseListUnitFiles(raw);
    expect(files).toEqual([
      { name: 'nginx.service', enabled: 'enabled' },
      { name: 'foo.service', enabled: 'disabled' },
      { name: 'bar.service', enabled: 'masked' },
    ]);
  });

  it('пустой вывод → []', () => {
    expect(parseListUnitFiles('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeUnits
// ---------------------------------------------------------------------------

describe('mergeUnits', () => {
  it('unit в обоих списках: значения из list-units + enabled из unit-files', () => {
    const merged = mergeUnits(
      [{ name: 'nginx.service', load: 'loaded', active: 'active', sub: 'running', description: 'nginx' }],
      [{ name: 'nginx.service', enabled: 'enabled' }],
    );
    expect(merged).toEqual([
      { name: 'nginx.service', description: 'nginx', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled' },
    ]);
  });

  it('только в list-units (transient): enabled null', () => {
    const merged = mergeUnits(
      [{ name: 'transient.service', load: 'loaded', active: 'active', sub: 'running', description: 'x' }],
      [],
    );
    expect(merged[0]).toMatchObject({ name: 'transient.service', enabled: null });
  });

  it('только в unit-files: load/active/sub/description null', () => {
    const merged = mergeUnits([], [{ name: 'unused.service', enabled: 'disabled' }]);
    expect(merged[0]).toEqual({
      name: 'unused.service',
      description: null,
      load: null,
      active: null,
      sub: null,
      enabled: 'disabled',
    });
  });

  it('сортировка по имени', () => {
    const merged = mergeUnits(
      [
        { name: 'zzz.service', load: 'loaded', active: 'active', sub: 'running', description: null },
        { name: 'aaa.service', load: 'loaded', active: 'active', sub: 'running', description: null },
      ],
      [],
    );
    expect(merged.map((u) => u.name)).toEqual(['aaa.service', 'zzz.service']);
  });
});

// ---------------------------------------------------------------------------
// parseVersionLine / parseSnapshot
// ---------------------------------------------------------------------------

describe('parseVersionLine', () => {
  it('строка systemd → версия', () => {
    expect(parseVersionLine('systemd 252 (252.26-1~deb12u2)')).toBe('systemd 252 (252.26-1~deb12u2)');
    expect(parseVersionLine('systemd 245 (245.4-4ubuntu3.20)')).toContain('245');
  });

  it('not found / пустая строка → null', () => {
    expect(parseVersionLine('sh: systemctl: command not found')).toBeNull();
    expect(parseVersionLine('systemctl: applet not found')).toBeNull();
    expect(parseVersionLine('')).toBeNull();
  });
});

const SNAPSHOT_RAW = [
  'systemd 252 (252.26-1~deb12u2)',
  '@@UNITS@@',
  'nginx.service loaded active running A high performance web server',
  'ssh.service loaded active running OpenBSD Secure Shell server',
  'getty@tty1.service loaded active running Getty on tty1',
  'failedsvc.service loaded failed failed some failed unit',
  'unloaded.service not-found inactive dead unit that failed to load',
  '@@UNITFILES@@',
  'nginx.service enabled enabled',
  'ssh.service enabled enabled',
  'getty@.service enabled enabled',
  'failedsvc.service disabled disabled',
  'static-svc.service static -',
  'postgresql.service disabled enabled',
].join('\n');

describe('parseSnapshot', () => {
  it('systemd доступен: merge снимка с enabled из unit-files', () => {
    const snap = parseSnapshot(SNAPSHOT_RAW);
    expect(snap.available).toBe(true);
    expect(snap.reason).toBeUndefined();
    const byName = new Map(snap.units.map((u) => [u.name, u]));
    expect(byName.get('nginx.service')).toMatchObject({ load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled' });
    expect(byName.get('ssh.service')?.enabled).toBe('enabled');
    expect(byName.get('failedsvc.service')).toMatchObject({ active: 'failed', enabled: 'disabled' });
    // static — тоже из unit-files (STATE = fields[1])
    expect(byName.get('static-svc.service')?.enabled).toBe('static');
    // preset != state: STATE = fields[1] = disabled
    expect(byName.get('postgresql.service')?.enabled).toBe('disabled');
    // template в unit-files не совпадает с инстансом в list-units → enabled null
    expect(byName.get('getty@tty1.service')?.enabled).toBeNull();
    // не загружен: значения есть, только из list-units
    expect(byName.get('unloaded.service')?.load).toBe('not-found');
  });

  it('systemctl не найден → недоступно с причиной', () => {
    const snap = parseSnapshot('sh: systemctl: command not found\n@@UNITS@@\n@@UNITFILES@@\n');
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('systemctl не найден');
    expect(snap.units).toEqual([]);
  });

  it('шум rc перед версией (~/.bashrc и т.п.) не ломает детект', () => {
    const raw = [
      'Welcome to my-server',
      'export PATH=/opt/conda/bin:$PATH',
      'systemd 252 (252.26-1~deb12u2)',
      '@@UNITS@@',
      'nginx.service loaded active running nginx',
      '@@UNITFILES@@',
      'nginx.service enabled enabled',
    ].join('\n');
    const snap = parseSnapshot(raw);
    expect(snap.available).toBe(true);
    expect(snap.units[0].name).toBe('nginx.service');
  });

  it('systemd не PID 1 → недоступно с причиной', () => {
    const raw = [
      'systemd 252 (252.26-1~deb12u2)',
      '@@UNITS@@',
      "System has not been booted with systemd as init system (PID 1). Can't operate.",
      'Failed to connect to bus: Host is down',
      '@@UNITFILES@@',
      "System has not been booted with systemd as init system (PID 1). Can't operate.",
    ].join('\n');
    const snap = parseSnapshot(raw);
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('не является PID 1');
  });

  it('ошибка флага в начале секции → недоступно с текстом ошибки', () => {
    const raw = ['systemd 252 (252.26-1~deb12u2)', '@@UNITS@@', "systemctl: Unknown option '--plain'", '@@UNITFILES@@'].join('\n');
    const snap = parseSnapshot(raw);
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('Unknown option');
  });

  it('ошибка в начале UNITFILES-секции тоже детектится', () => {
    const raw = [
      'systemd 252 (252.26-1~deb12u2)',
      '@@UNITS@@',
      'nginx.service loaded active running nginx',
      '@@UNITFILES@@',
      'Failed to load unit files: no such file or directory',
    ].join('\n');
    const snap = parseSnapshot(raw);
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('Failed to load');
  });
});

// ---------------------------------------------------------------------------
// Валидация имени unit и действий
// ---------------------------------------------------------------------------

describe('unitNameValid', () => {
  it('принимает допустимые имена', () => {
    for (const name of ['nginx.service', 'foo@bar.service', 'postgresql@14-main', 'a.b-c_d:e', 'getty@tty1.service']) {
      expect(unitNameValid(name)).toBe(true);
    }
  });

  it('отклоняет инъекции и мусор', () => {
    for (const name of ['nginx; rm -rf /', '..', '.', '/etc/passwd', ' ', '$(x)', '', 'nginx.service; rm -rf /', 'a b.service']) {
      expect(unitNameValid(name)).toBe(false);
    }
  });

  it('assertValidUnitName бросает ServiceActionError(400)', () => {
    expect(() => assertValidUnitName('../x')).toThrow(ServiceActionError);
    try {
      assertValidUnitName('../x');
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
    }
    expect(assertValidUnitName('nginx.service')).toBe('nginx.service');
  });
});

describe('isServiceAction', () => {
  it('whitelist включает reset-failed', () => {
    expect((SERVICE_ACTIONS as readonly string[]).includes('reset-failed')).toBe(true);
    expect(isServiceAction('restart')).toBe(true);
  });

  it('отклоняет rm/exec/daemon-reload/пустое', () => {
    expect(isServiceAction('rm')).toBe(false);
    expect(isServiceAction('exec')).toBe(false);
    expect(isServiceAction('daemon-reload')).toBe(false);
    expect(isServiceAction('')).toBe(false);
    expect(isServiceAction(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Классификация ошибок действий и sudo-зонда
// ---------------------------------------------------------------------------

function result(code: number | null, stderr: string, stdout = ''): ExecResult {
  return { code, stderr, stdout };
}

describe('classifyActionFailure', () => {
  it('code 0 → ok', () => {
    expect(classifyActionFailure(result(0, ''))).toBe('ok');
  });

  it('polkit: Interactive authentication required → sudo-needed (основная фикстура)', () => {
    expect(classifyActionFailure(result(1, 'Failed to restart nginx.service: Interactive authentication required.'))).toBe(
      'sudo-needed',
    );
  });

  it('вторичные формулировки sudo-needed', () => {
    for (const msg of [
      'Access denied',
      'Operation refused',
      'Permission denied',
      'Authentication is required',
      'Failed to start foo.service: Authentication is required.',
    ]) {
      expect(classifyActionFailure(result(1, msg))).toBe('sudo-needed');
    }
  });

  it('masked → masked (ретрая нет)', () => {
    expect(classifyActionFailure(result(1, 'Unit nginx.service is masked.'))).toBe('masked');
  });

  it('not-found → not-found', () => {
    expect(classifyActionFailure(result(1, 'Unit foo.service not found.'))).toBe('not-found');
    expect(classifyActionFailure(result(1, 'could not be found'))).toBe('not-found');
  });

  it('job-failed → job-failed', () => {
    expect(
      classifyActionFailure(result(1, 'Job for nginx.service failed because the control process exited with error code.')),
    ).toBe('job-failed');
  });

  it('всё остальное → transport', () => {
    expect(classifyActionFailure(result(255, 'connection reset'))).toBe('transport');
  });
});

describe('classifySudoProbe', () => {
  it('код 0 → ok', () => {
    expect(classifySudoProbe(result(0, ''))).toBe('ok');
  });

  it('Sorry, try again → wrong-password', () => {
    expect(classifySudoProbe(result(1, 'Sorry, try again.'))).toBe('wrong-password');
  });

  it('не в sudoers → not-in-sudoers (400, не 502)', () => {
    expect(classifySudoProbe(result(1, 'test is not in the sudoers file. This incident will be reported.'))).toBe(
      'not-in-sudoers',
    );
    expect(classifySudoProbe(result(1, 'user test not allowed to execute /usr/bin/true as root'))).toBe('not-in-sudoers');
  });

  it('sudo не установлен → sudo-not-found', () => {
    expect(classifySudoProbe(result(127, 'sudo: not found'))).toBe('sudo-not-found');
  });

  it('прочее → other', () => {
    expect(classifySudoProbe(result(1, 'some odd error'))).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Сборка команд
// ---------------------------------------------------------------------------

describe('сборка команд', () => {
  it('без sudo: systemctl <action> -- <unit>', () => {
    expect(systemctlCommand('start', 'nginx.service')).toBe("systemctl start -- 'nginx.service'");
  });

  it('с sudo: прямая форма sudo -S -p \'\' -- systemctl … без sh -c', () => {
    const cmd = sudoSystemctlCommand('restart', 'nginx.service');
    expect(cmd).toBe("sudo -S -p '' -- systemctl restart -- 'nginx.service'");
    expect(cmd).not.toContain('sh -c');
  });

  it('зонд: sudo -S -p \'\' -- true', () => {
    expect(sudoProbeCommand()).toBe("sudo -S -p '' -- true");
  });

  it('journalctl: tail и follow', () => {
    expect(journalctlCommand('nginx.service', 500, false)).toBe("journalctl -u 'nginx.service' --no-pager -n 500");
    expect(journalctlCommand('nginx.service', 200, true)).toBe("journalctl -u 'nginx.service' --no-pager -n 200 -f");
  });

  it('деталь: status -n 0 + show с выбранными полями через маркер, `--` перед именем', () => {
    const cmd = serviceDetailCommand('nginx.service');
    expect(cmd).toContain("systemctl status --no-pager -n 0 -- 'nginx.service' 2>&1");
    expect(cmd).toContain("systemctl show -p MainPID -p ActiveState -p SubState -p UnitFileState -p FragmentPath -p Restart -p NRestarts -p Result -p MemoryCurrent -p TasksCurrent -p ActiveEnterTimestamp -- 'nginx.service' 2>&1");
    expect(cmd).toContain('@@SHOW@@');
  });
});

describe('clampTail', () => {
  it('границы 1..5000, дефолт 500', () => {
    expect(clampTail(undefined)).toBe(500);
    expect(clampTail('abc')).toBe(500);
    expect(clampTail(0)).toBe(1);
    expect(clampTail(99999)).toBe(5000);
    expect(clampTail(200)).toBe(200);
    expect(clampTail(200.9)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// parseShowOutput
// ---------------------------------------------------------------------------

describe('parseShowOutput', () => {
  const fields = ['MainPID', 'ActiveState', 'FragmentPath', 'NRestarts'];

  it('обычные поля, поле с `=` внутри значения, отсутствующее → null', () => {
    const show = parseShowOutput('MainPID=1234\nActiveState=active\nFragmentPath=/etc/systemd/system/foo=bar.service\n', fields);
    expect(show).toEqual({
      MainPID: '1234',
      ActiveState: 'active',
      FragmentPath: '/etc/systemd/system/foo=bar.service',
      NRestarts: null,
    });
  });

  it('повторяющееся поле — первое вхождение выигрывает', () => {
    const show = parseShowOutput('MainPID=1\nMainPID=2\n', fields);
    expect(show.MainPID).toBe('1');
  });

  it('мусорные строки игнорируются', () => {
    const show = parseShowOutput('● nginx.service - A web server\nMainPID=5\n', fields);
    expect(show.MainPID).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// runServiceAction: поток с sudo-ретраем
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  stdin?: string;
}

/** Мок exec: настраиваемое поведение по команде. */
function fakeExec(router: (command: string, stdin?: string) => ExecResult) {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (_p, command, opts) => {
    calls.push({ command, stdin: opts?.stdin });
    return router(command, opts?.stdin);
  };
  return { calls, execFn };
}

describe('runServiceAction', () => {
  it('успех без sudo', async () => {
    const { execFn } = fakeExec(() => result(0, ''));
    const out = await runServiceAction(profile, 'nginx.service', 'restart', undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '' });
  });

  it('sudo-needed без пароля → 400 «укажите sudo-пароль», действие не выполняется', async () => {
    const { calls, execFn } = fakeExec(() =>
      result(1, 'Failed to restart nginx.service: Interactive authentication required.'),
    );
    try {
      await runServiceAction(profile, 'nginx.service', 'restart', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('укажите sudo-пароль');
    }
    expect(calls).toHaveLength(1); // зонда нет — пароль не задан
  });

  it('sudo-needed + неверный пароль → зонд → 400 «Неверный sudo-пароль»', async () => {
    const { calls, execFn } = fakeExec((command, stdin) => {
      if (command === sudoProbeCommand()) return result(1, 'Sorry, try again.');
      return result(1, 'Failed to restart nginx.service: Interactive authentication required.');
    });
    try {
      await runServiceAction(profile, 'nginx.service', 'restart', 'bad-pass', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toBe('Неверный sudo-пароль');
    }
    expect(calls.some((c) => c.command === sudoProbeCommand())).toBe(true);
    // Пароль в командные строки не попадает
    expect(calls.every((c) => !c.command.includes('bad-pass'))).toBe(true);
  });

  it('sudo-needed + пользователь не в sudoers → 400, не 502', async () => {
    const { execFn } = fakeExec((command) => {
      if (command === sudoProbeCommand()) {
        return result(1, 'test is not in the sudoers file. This incident will be reported.');
      }
      return result(1, 'Interactive authentication required');
    });
    try {
      await runServiceAction(profile, 'nginx.service', 'start', 'x', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('нет прав sudo');
    }
  });

  it('sudo needed + sudo не установлен → 400', async () => {
    const { execFn } = fakeExec((command) => {
      if (command === sudoProbeCommand()) return result(127, 'sudo: not found');
      return result(1, 'Access denied');
    });
    try {
      await runServiceAction(profile, 'nginx.service', 'stop', 'x', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('sudo не установлен');
    }
  });

  it('sudo-needed + верный пароль: ретрай через sudo, пароль только в stdin', async () => {
    const password = 's3cret-pass';
    const { calls, execFn } = fakeExec((command, stdin) => {
      if (command === sudoProbeCommand()) return result(0, '');
      if (command === sudoSystemctlCommand('restart', 'nginx.service')) {
        return { code: 0, stdout: 'Restarting nginx.service...', stderr: '' };
      }
      return result(1, 'Failed to restart nginx.service: Interactive authentication required.');
    });
    const out = await runServiceAction(profile, 'nginx.service', 'restart', password, { execFn });
    expect(out).toEqual({ ok: true, output: 'Restarting nginx.service...' });
    const sudoCalls = calls.filter((c) => c.command.startsWith('sudo '));
    expect(sudoCalls.length).toBe(2); // зонд + ретрай
    for (const c of sudoCalls) {
      expect(c.stdin).toBe(`${password}\n`);
      expect(c.command).not.toContain(password);
    }
  });

  it('masked → 400 с текстом systemd как есть', async () => {
    const { execFn } = fakeExec(() => result(1, 'Unit nginx.service is masked.'));
    try {
      await runServiceAction(profile, 'nginx.service', 'start', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('is masked');
    }
  });

  it('неизвестная ошибка → 502 (транспорт)', async () => {
    const { execFn } = fakeExec(() => result(255, 'connection reset'));
    try {
      await runServiceAction(profile, 'nginx.service', 'start', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(502);
    }
  });

  it('таймаут exec действия → 400 «проверьте статус», а не общий 502', async () => {
    const execFn: ExecFn = async (_p, _c, opts) => {
      throw new Error(`Command timed out after ${opts?.timeoutMs ?? 60000}ms`);
    };
    try {
      await runServiceAction(profile, 'nginx.service', 'restart', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('выполняется дольше');
      expect((err as Error).message).toContain('проверьте статус');
    }
  });

  it('действия выполняются с явным таймаутом 120 с (а не 60 с по умолчанию)', async () => {
    let actionTimeout = 0;
    const execFn: ExecFn = async (_p, command, opts) => {
      if (command.startsWith('systemctl ')) actionTimeout = opts?.timeoutMs ?? 0;
      return result(0, '');
    };
    await runServiceAction(profile, 'nginx.service', 'restart', undefined, { execFn });
    expect(actionTimeout).toBe(120000);
  });
});

// ---------------------------------------------------------------------------
// getServiceDetail / readServiceLogs / collectServices через мок
// ---------------------------------------------------------------------------

describe('getServiceDetail', () => {
  it('разделяет status и show по маркеру', async () => {
    const execFn: ExecFn = async () => ({
      code: 0,
      stdout: '● nginx.service - A high performance web server\n     Loaded: loaded\n     Active: active (running)\n@@SHOW@@\nMainPID=1234\nActiveState=active\nFragmentPath=/lib/systemd/system/nginx.service\n',
      stderr: '',
    });
    const detail = await getServiceDetail(profile, 'nginx.service', { execFn });
    expect(detail.name).toBe('nginx.service');
    expect(detail.status).toContain('Active: active (running)');
    expect(detail.status).not.toContain('@@SHOW@@');
    expect(detail.show.MainPID).toBe('1234');
    expect(detail.show.ActiveState).toBe('active');
    expect(detail.show.Restart).toBeNull();
  });

  it('код 3 (inactive) — не ошибка, статус отдаётся', async () => {
    const execFn: ExecFn = async () => ({
      code: 3,
      stdout: '● nginx.service - A web server\n     Active: inactive (dead)\n@@SHOW@@\nActiveState=inactive\nMainPID=0\n',
      stderr: '',
    });
    const detail = await getServiceDetail(profile, 'nginx.service', { execFn });
    expect(detail.show.ActiveState).toBe('inactive');
  });
});

describe('readServiceLogs', () => {
  it('разовый журнал: stdout+stderr, таймаут 30 c', async () => {
    const execFn: ExecFn = async (_p, command, opts) => {
      expect(opts?.timeoutMs).toBe(30000);
      expect(command).toBe("journalctl -u 'nginx.service' --no-pager -n 200");
      return { code: 0, stdout: 'May 01 10:00:00 host nginx[1]: start\n', stderr: '' };
    };
    const out = await readServiceLogs(profile, 'nginx.service', 200, { execFn });
    expect(out).toContain('start');
  });

  it('вывод на пределе 2 МБ → честная пометка обрезки', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const execFn: ExecFn = async () => ({ code: 0, stdout: big, stderr: '' });
    const out = await readServiceLogs(profile, 'nginx.service', 5000, { execFn });
    expect(out.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(out).toContain('вывод обрезан по лимиту 2 МБ');
  });
});

describe('collectServices', () => {
  it('кэш 2 с на профиль: параллельные вызовы делят один exec (через deps)', async () => {
    const p1: Profile = { ...profile, id: 'cache-fake' };
    let execs = 0;
    const execFn: ExecFn = async () => {
      execs += 1;
      return { code: 0, stdout: SNAPSHOT_RAW, stderr: '' };
    };
    const a = collectServices(p1, { execFn });
    const b = collectServices(p1, { execFn });
    expect(a).toBe(b);
    const snap = await a;
    expect(execs).toBe(1);
    expect(snap.available).toBe(true);
    expect(snap.units.length).toBeGreaterThan(0);
  });

  it('ошибочный промис удаляется из кэша — следующий вызов исполняет заново', async () => {
    const p1: Profile = { ...profile, id: 'cache-err' };
    await expect(collectServices(p1, { execFn: async () => { throw new Error('ssh down'); } })).rejects.toThrow(
      'ssh down',
    );
    let execs = 0;
    const execFn: ExecFn = async () => {
      execs += 1;
      return { code: 0, stdout: SNAPSHOT_RAW, stderr: '' };
    };
    const snap = await collectServices(p1, { execFn });
    expect(execs).toBe(1);
    expect(snap.available).toBe(true);
  });
});
