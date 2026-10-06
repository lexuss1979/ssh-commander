import { describe, expect, it } from 'vitest';
import {
  SERVICE_ACTIONS,
  ServiceActionError,
  assertValidUnitName,
  classifyActionFailure,
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
  sudoSystemctlCommand,
  systemctlCommand,
  unitNameValid,
  type ExecFn,
} from '../src/services/systemd.js';
import { classifySudoProbe, sudoProbeCommand } from '../src/services/sudo.js';
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
  it('parses a regular unit, an @-name, a description with spaces (everything after the 4th column)', () => {
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

  it('load=not-found stays a string', () => {
    const units = parseListUnits('foo.service not-found inactive dead foo failed to load');
    expect(units[0]).toMatchObject({ name: 'foo.service', load: 'not-found', active: 'inactive', sub: 'dead' });
  });

  it('`-` in columns → null', () => {
    const units = parseListUnits('cups.service - - - CUPS Scheduler');
    expect(units[0]).toMatchObject({
      name: 'cups.service',
      load: null,
      active: null,
      sub: null,
      description: 'CUPS Scheduler',
    });
  });

  it('empty output → []', () => {
    expect(parseListUnits('')).toEqual([]);
  });

  it('strips the ● bullet from failed units (old builds without --plain)', () => {
    const units = parseListUnits('● failedsvc.service loaded failed failed Some failed unit');
    expect(units[0]).toMatchObject({
      name: 'failedsvc.service',
      load: 'loaded',
      active: 'failed',
      sub: 'failed',
      description: 'Some failed unit',
    });
  });

  it('garbage lines are dropped', () => {
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
// parseListUnitFiles: both formats, STATE is always the second field
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

  it('three-column format (systemd ≥ 245): STATE is taken from fields[1], not the last field', () => {
    const files = parseListUnitFiles(THREE_COL);
    const byName = new Map(files.map((f) => [f.name, f.enabled]));
    expect(byName.get('nginx.service')).toBe('enabled');
    // preset (third column) = enabled while STATE (second) = disabled — a regression guard
    expect(byName.get('postgresql.service')).toBe('disabled');
    expect(byName.get('foo.service')).toBe('masked');
    expect(byName.get('bar.service')).toBe('static');
    expect(byName.get('baz.service')).toBe('indirect');
    expect(byName.get('gen.service')).toBe('generated');
    expect(byName.get('alias.service')).toBe('alias');
    expect(byName.get('bad.service')).toBe('bad');
  });

  it('two-column format (old systemd)', () => {
    const raw = ['nginx.service enabled', 'foo.service disabled', 'bar.service masked'].join('\n');
    const files = parseListUnitFiles(raw);
    expect(files).toEqual([
      { name: 'nginx.service', enabled: 'enabled' },
      { name: 'foo.service', enabled: 'disabled' },
      { name: 'bar.service', enabled: 'masked' },
    ]);
  });

  it('empty output → []', () => {
    expect(parseListUnitFiles('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeUnits
// ---------------------------------------------------------------------------

describe('mergeUnits', () => {
  it('unit in both lists: values from list-units + enabled from unit-files', () => {
    const merged = mergeUnits(
      [{ name: 'nginx.service', load: 'loaded', active: 'active', sub: 'running', description: 'nginx' }],
      [{ name: 'nginx.service', enabled: 'enabled' }],
    );
    expect(merged).toEqual([
      { name: 'nginx.service', description: 'nginx', load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled' },
    ]);
  });

  it('only in list-units (transient): enabled null', () => {
    const merged = mergeUnits(
      [{ name: 'transient.service', load: 'loaded', active: 'active', sub: 'running', description: 'x' }],
      [],
    );
    expect(merged[0]).toMatchObject({ name: 'transient.service', enabled: null });
  });

  it('only in unit-files: load/active/sub/description null', () => {
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

  it('sorted by name', () => {
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
  it('a systemd line → version', () => {
    expect(parseVersionLine('systemd 252 (252.26-1~deb12u2)')).toBe('systemd 252 (252.26-1~deb12u2)');
    expect(parseVersionLine('systemd 245 (245.4-4ubuntu3.20)')).toContain('245');
  });

  it('not found / empty string → null', () => {
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
  it('systemd available: snapshot merged with enabled from unit-files', () => {
    const snap = parseSnapshot(SNAPSHOT_RAW);
    expect(snap.available).toBe(true);
    expect(snap.reason).toBeUndefined();
    const byName = new Map(snap.units.map((u) => [u.name, u]));
    expect(byName.get('nginx.service')).toMatchObject({ load: 'loaded', active: 'active', sub: 'running', enabled: 'enabled' });
    expect(byName.get('ssh.service')?.enabled).toBe('enabled');
    expect(byName.get('failedsvc.service')).toMatchObject({ active: 'failed', enabled: 'disabled' });
    // static also comes from unit-files (STATE = fields[1])
    expect(byName.get('static-svc.service')?.enabled).toBe('static');
    // preset != state: STATE = fields[1] = disabled
    expect(byName.get('postgresql.service')?.enabled).toBe('disabled');
    // a template in unit-files does not match the instance in list-units → enabled null
    expect(byName.get('getty@tty1.service')?.enabled).toBeNull();
    // not loaded: values present, taken from list-units only
    expect(byName.get('unloaded.service')?.load).toBe('not-found');
  });

  it('systemctl not found → unavailable with a reason', () => {
    const snap = parseSnapshot('sh: systemctl: command not found\n@@UNITS@@\n@@UNITFILES@@\n');
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('systemctl не найден');
    expect(snap.units).toEqual([]);
  });

  it('rc noise before the version (~/.bashrc etc.) does not break detection', () => {
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

  it('systemd is not PID 1 → unavailable with a reason', () => {
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

  it('a flag error at the section start → unavailable with the error text', () => {
    const raw = ['systemd 252 (252.26-1~deb12u2)', '@@UNITS@@', "systemctl: Unknown option '--plain'", '@@UNITFILES@@'].join('\n');
    const snap = parseSnapshot(raw);
    expect(snap.available).toBe(false);
    expect(snap.reason).toContain('Unknown option');
  });

  it('an error at the UNITFILES section start is detected too', () => {
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
// Unit name and action validation
// ---------------------------------------------------------------------------

describe('unitNameValid', () => {
  it('accepts valid names', () => {
    for (const name of ['nginx.service', 'foo@bar.service', 'postgresql@14-main', 'a.b-c_d:e', 'getty@tty1.service']) {
      expect(unitNameValid(name)).toBe(true);
    }
  });

  it('rejects injections and garbage', () => {
    for (const name of ['nginx; rm -rf /', '..', '.', '/etc/passwd', ' ', '$(x)', '', 'nginx.service; rm -rf /', 'a b.service']) {
      expect(unitNameValid(name)).toBe(false);
    }
  });

  it('assertValidUnitName throws ServiceActionError(400)', () => {
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
  it('whitelist includes reset-failed', () => {
    expect((SERVICE_ACTIONS as readonly string[]).includes('reset-failed')).toBe(true);
    expect(isServiceAction('restart')).toBe(true);
  });

  it('rejects rm/exec/daemon-reload/empty', () => {
    expect(isServiceAction('rm')).toBe(false);
    expect(isServiceAction('exec')).toBe(false);
    expect(isServiceAction('daemon-reload')).toBe(false);
    expect(isServiceAction('')).toBe(false);
    expect(isServiceAction(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Action failure and sudo-probe classification
// ---------------------------------------------------------------------------

function result(code: number | null, stderr: string, stdout = ''): ExecResult {
  return { code, stderr, stdout };
}

describe('classifyActionFailure', () => {
  it('code 0 → ok', () => {
    expect(classifyActionFailure(result(0, ''))).toBe('ok');
  });

  it('polkit: Interactive authentication required → sudo-needed (primary fixture)', () => {
    expect(classifyActionFailure(result(1, 'Failed to restart nginx.service: Interactive authentication required.'))).toBe(
      'sudo-needed',
    );
  });

  it('secondary sudo-needed wordings', () => {
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

  it('masked → masked (no retry)', () => {
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

  it('everything else → transport', () => {
    expect(classifyActionFailure(result(255, 'connection reset'))).toBe('transport');
  });
});

describe('classifySudoProbe', () => {
  it('code 0 → ok', () => {
    expect(classifySudoProbe(result(0, ''))).toBe('ok');
  });

  it('Sorry, try again → wrong-password', () => {
    expect(classifySudoProbe(result(1, 'Sorry, try again.'))).toBe('wrong-password');
  });

  it('not in sudoers → not-in-sudoers (400, not 502)', () => {
    expect(classifySudoProbe(result(1, 'test is not in the sudoers file. This incident will be reported.'))).toBe(
      'not-in-sudoers',
    );
    expect(classifySudoProbe(result(1, 'user test not allowed to execute /usr/bin/true as root'))).toBe('not-in-sudoers');
  });

  it('sudo not installed → sudo-not-found', () => {
    expect(classifySudoProbe(result(127, 'sudo: not found'))).toBe('sudo-not-found');
  });

  it('anything else → other', () => {
    expect(classifySudoProbe(result(1, 'some odd error'))).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

describe('command builders', () => {
  it('without sudo: systemctl <action> -- <unit>', () => {
    expect(systemctlCommand('start', 'nginx.service')).toBe("systemctl start -- 'nginx.service'");
  });

  it('with sudo: the direct form sudo -S -p \'\' -- systemctl … without sh -c', () => {
    const cmd = sudoSystemctlCommand('restart', 'nginx.service');
    expect(cmd).toBe("sudo -S -p '' -- systemctl restart -- 'nginx.service'");
    expect(cmd).not.toContain('sh -c');
  });

  it('probe: sudo -S -p \'\' -- true', () => {
    expect(sudoProbeCommand()).toBe("sudo -S -p '' -- true");
  });

  it('journalctl: tail and follow', () => {
    expect(journalctlCommand('nginx.service', 500, false)).toBe("journalctl -u 'nginx.service' --no-pager -n 500");
    expect(journalctlCommand('nginx.service', 200, true)).toBe("journalctl -u 'nginx.service' --no-pager -n 200 -f");
  });

  it('detail: status -n 0 + show with selected fields behind a marker, `--` before the name', () => {
    const cmd = serviceDetailCommand('nginx.service');
    expect(cmd).toContain("systemctl status --no-pager -n 0 -- 'nginx.service' 2>&1");
    expect(cmd).toContain("systemctl show -p MainPID -p ActiveState -p SubState -p UnitFileState -p FragmentPath -p Restart -p NRestarts -p Result -p MemoryCurrent -p TasksCurrent -p ActiveEnterTimestamp -- 'nginx.service' 2>&1");
    expect(cmd).toContain('@@SHOW@@');
  });
});

describe('clampTail', () => {
  it('bounds 1..5000, default 500', () => {
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

  it('regular fields, a field with `=` inside the value, a missing one → null', () => {
    const show = parseShowOutput('MainPID=1234\nActiveState=active\nFragmentPath=/etc/systemd/system/foo=bar.service\n', fields);
    expect(show).toEqual({
      MainPID: '1234',
      ActiveState: 'active',
      FragmentPath: '/etc/systemd/system/foo=bar.service',
      NRestarts: null,
    });
  });

  it('repeated field — the first occurrence wins', () => {
    const show = parseShowOutput('MainPID=1\nMainPID=2\n', fields);
    expect(show.MainPID).toBe('1');
  });

  it('garbage lines are ignored', () => {
    const show = parseShowOutput('● nginx.service - A web server\nMainPID=5\n', fields);
    expect(show.MainPID).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// runServiceAction: flow with a sudo retry
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  stdin?: string;
}

/** Mock exec: per-command configurable behavior. */
function fakeExec(router: (command: string, stdin?: string) => ExecResult) {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (_p, command, opts) => {
    calls.push({ command, stdin: opts?.stdin });
    return router(command, opts?.stdin);
  };
  return { calls, execFn };
}

describe('runServiceAction', () => {
  it('success without sudo', async () => {
    const { execFn } = fakeExec(() => result(0, ''));
    const out = await runServiceAction(profile, 'nginx.service', 'restart', undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '' });
  });

  it('sudo-needed without a password → 400 "specify the sudo password", action not run', async () => {
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
    expect(calls).toHaveLength(1); // no probe — no password given
  });

  it('sudo-needed + wrong password → probe → 400 "wrong sudo password"', async () => {
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
    // The password never lands in command lines
    expect(calls.every((c) => !c.command.includes('bad-pass'))).toBe(true);
  });

  it('sudo-needed + user not in sudoers → 400, not 502', async () => {
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

  it('sudo needed + sudo not installed → 400', async () => {
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

  it('sudo-needed + correct password: retry via sudo, password only in stdin', async () => {
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
    expect(sudoCalls.length).toBe(2); // probe + retry
    for (const c of sudoCalls) {
      expect(c.stdin).toBe(`${password}\n`);
      expect(c.command).not.toContain(password);
    }
  });

  it('masked → 400 with the systemd text as is', async () => {
    const { execFn } = fakeExec(() => result(1, 'Unit nginx.service is masked.'));
    try {
      await runServiceAction(profile, 'nginx.service', 'start', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(400);
      expect((err as Error).message).toContain('is masked');
    }
  });

  it('unknown error → 502 (transport)', async () => {
    const { execFn } = fakeExec(() => result(255, 'connection reset'));
    try {
      await runServiceAction(profile, 'nginx.service', 'start', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceActionError).status).toBe(502);
    }
  });

  it('action exec timeout → 400 "check the status", not a generic 502', async () => {
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

  it('actions run with an explicit 120 s timeout (not the default 60 s)', async () => {
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
// getServiceDetail / readServiceLogs / collectServices via mocks
// ---------------------------------------------------------------------------

describe('getServiceDetail', () => {
  it('splits status and show by the marker', async () => {
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

  it('exit code 3 (inactive) is not an error, the status is still returned', async () => {
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
  it('one-shot logs: stdout+stderr, 30 s timeout', async () => {
    const execFn: ExecFn = async (_p, command, opts) => {
      expect(opts?.timeoutMs).toBe(30000);
      expect(command).toBe("journalctl -u 'nginx.service' --no-pager -n 200");
      return { code: 0, stdout: 'May 01 10:00:00 host nginx[1]: start\n', stderr: '' };
    };
    const out = await readServiceLogs(profile, 'nginx.service', 200, { execFn });
    expect(out).toContain('start');
  });

  it('output at the 2 MB limit → an honest truncation note', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const execFn: ExecFn = async () => ({ code: 0, stdout: big, stderr: '' });
    const out = await readServiceLogs(profile, 'nginx.service', 5000, { execFn });
    expect(out.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(out).toContain('вывод обрезан по лимиту 2 МБ');
  });
});

describe('collectServices', () => {
  it('2 s cache per profile: parallel calls share one exec (via deps)', async () => {
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

  it('a failed promise is evicted from the cache — the next call executes again', async () => {
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
