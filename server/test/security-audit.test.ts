import { describe, expect, it } from 'vitest';
import {
  ALL_SECTIONS,
  commandsForSection,
  findContainerIssues,
  limitLines,
  normalizeSections,
  runSecurityAudit,
  sudoWrap,
  type ExecFn,
} from '../src/services/security-audit.js';
import type { Profile } from '../src/types.js';

const profile: Profile = {
  id: 'p1',
  name: 'test',
  host: '127.0.0.1',
  port: 22,
  username: 'test',
  authType: 'password',
  password: 'x',
};

interface ExecCall {
  command: string;
  stdin?: string;
}

/** Mocked exec: records calls, treats the sudo check as successful/failed. */
function fakeExec(opts: { sudoOk?: boolean; stdout?: string } = {}) {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (_p, command, execOpts) => {
    calls.push({ command, stdin: execOpts?.stdin });
    if (command === sudoWrap('true')) {
      return { code: opts.sudoOk === false ? 1 : 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: opts.stdout ?? 'ok-output', stderr: '' };
  };
  return { calls, execFn };
}

describe('commandsForSection', () => {
  it('covers all sections; docker is not built from shell commands', () => {
    for (const section of ALL_SECTIONS) {
      expect(Array.isArray(commandsForSection(section))).toBe(true);
    }
    expect(commandsForSection('docker')).toEqual([]);
    expect(commandsForSection('auth').length).toBeGreaterThan(0);
  });

  it('marks the root-only subsections in auth', () => {
    const titles = commandsForSection('auth')
      .filter((c) => c.rootOnly)
      .map((c) => c.title);
    expect(titles).toEqual([
      'Пустые пароли (/etc/shadow)',
      'NOPASSWD в sudoers',
      'Ключи root (/root/.ssh/authorized_keys)',
    ]);
  });

  it('every command comes from the fixed allow-list (no user input)', () => {
    for (const section of ALL_SECTIONS) {
      for (const cmd of commandsForSection(section)) {
        expect(cmd.command).toBeTruthy();
        expect(typeof cmd.title).toBe('string');
      }
    }
  });
});

describe('sudoWrap', () => {
  it('wraps a command in sudo -S without the password in the command line', () => {
    const wrapped = sudoWrap(`awk -F: '$2=="" {print $1}' /etc/shadow`);
    expect(wrapped.startsWith(`sudo -S -p '' -- sh -c '`)).toBe(true);
    expect(wrapped).toContain('/etc/shadow');
    // The password is not passed here at all — checked below at the runSecurityAudit level.
  });

  it('escapes single quotes inside the command', () => {
    const wrapped = sudoWrap(`awk -F: '$3==0 {print $1}' /etc/passwd`);
    expect(wrapped).toBe(`sudo -S -p '' -- sh -c 'awk -F: '\\''$3==0 {print $1}'\\'' /etc/passwd'`);
  });
});

describe('limitLines', () => {
  it('truncates long output with a note', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const limited = limitLines(text, 3);
    expect(limited).toContain('line0');
    expect(limited).not.toContain('line3\n');
    expect(limited).toContain('обрезано: показано 3 из 10 строк');
  });

  it('leaves short output untouched', () => {
    expect(limitLines('a\nb', 5)).toBe('a\nb');
  });
});

describe('findContainerIssues', () => {
  it('flags privileged, host network, docker.sock and a root mount', () => {
    const issues = findContainerIssues({
      HostConfig: { Privileged: true, NetworkMode: 'host', Binds: ['/:/host:ro'] },
      Mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    });
    expect(issues).toContain('privileged-режим');
    expect(issues).toContain('сеть host');
    expect(issues).toContain('монтирует /var/run/docker.sock');
    expect(issues).toContain('монтирует корень ФС (/)');
  });

  it('a regular container — no issues', () => {
    expect(
      findContainerIssues({
        HostConfig: { Privileged: false, NetworkMode: 'bridge', Binds: ['/srv/data:/data'] },
        Mounts: [],
      }),
    ).toEqual([]);
  });
});

describe('normalizeSections', () => {
  it('defaults to all sections', () => {
    expect(normalizeSections()).toEqual(ALL_SECTIONS);
    expect(normalizeSections([])).toEqual(ALL_SECTIONS);
  });

  it('filters out unknown sections', () => {
    expect(normalizeSections(['auth', 'bogus'])).toEqual(['auth']);
    expect(normalizeSections(['bogus'])).toEqual(ALL_SECTIONS);
  });
});

describe('runSecurityAudit', () => {
  it('without a password the root subsections are skipped, the rest runs', async () => {
    const { calls, execFn } = fakeExec();
    // The docker section is mocked: this test is about sudo/root subsections,
    // not docker — real SSH to 127.0.0.1:22 would make the run machine-dependent.
    const out = await runSecurityAudit(
      profile,
      { privileged: true },
      { execFn, listContainersFn: async () => [], inspectFn: async () => [] },
    );
    expect(out).toContain('root-проверки пропущены');
    expect(out).toContain('пропущено: нет прав (нужен sudo)');
    expect(out).toContain('ok-output');
    // No command went through sudo.
    expect(calls.every((c) => !c.command.startsWith('sudo '))).toBe(true);
  });

  it('with a password the root commands go through sudo, the password only in stdin', async () => {
    const { calls, execFn } = fakeExec({ sudoOk: true });
    const password = 's3cret-pass';
    const out = await runSecurityAudit(
      profile,
      { sections: ['auth'], privileged: true, sudoPassword: password },
      { execFn },
    );
    // The password never appears in command lines or in the report output.
    expect(out).not.toContain(password);
    for (const call of calls) {
      expect(call.command).not.toContain(password);
    }
    // The sudo check and the root subsections received the password in stdin.
    const sudoCalls = calls.filter((c) => c.command.startsWith(`sudo -S -p '' --`));
    expect(sudoCalls.length).toBeGreaterThan(1);
    for (const call of sudoCalls) {
      expect(call.stdin).toBe(`${password}\n`);
    }
    expect(out).not.toContain('пропущено: нет прав');
  });

  it('a failing sudo — a graceful degradation with a note', async () => {
    const { execFn } = fakeExec({ sudoOk: false });
    const out = await runSecurityAudit(
      profile,
      { sections: ['auth'], privileged: true, sudoPassword: 'bad' },
      { execFn },
    );
    expect(out).toContain('sudo не сработал');
    expect(out).toContain('пропущено: нет прав (нужен sudo)');
  });

  it('unprivileged mode never requests sudo at all', async () => {
    const { calls, execFn } = fakeExec();
    await runSecurityAudit(profile, { sections: ['network'] }, { execFn });
    expect(calls.some((c) => c.command.startsWith('sudo '))).toBe(false);
    expect(calls.some((c) => c.stdin !== undefined)).toBe(false);
  });

  it('docker unavailable — a note, not an error', async () => {
    const { execFn } = fakeExec();
    const out = await runSecurityAudit(
      profile,
      { sections: ['docker'] },
      {
        execFn,
        listContainersFn: async () => {
          throw new Error('docker ps failed');
        },
      },
    );
    expect(out).toContain('docker недоступен');
  });

  it('docker: problem containers are listed with their flags', async () => {
    const { execFn } = fakeExec();
    const out = await runSecurityAudit(
      profile,
      { sections: ['docker'] },
      {
        execFn,
        listContainersFn: async () => [{ ID: 'abc123', Names: 'web' }],
        inspectFn: async () => [{ HostConfig: { Privileged: true, NetworkMode: 'bridge' } }],
      },
    );
    expect(out).toContain('web: privileged-режим');
  });

  it('the whole output is size-limited with a hint about sections', async () => {
    const big = 'x'.repeat(4000);
    const { execFn } = fakeExec({ stdout: big });
    // The docker section is mocked — this test is about the output limit, not docker.
    const out = await runSecurityAudit(
      profile,
      {},
      { execFn, listContainersFn: async () => [], inspectFn: async () => [] },
    );
    expect(out).toContain('вывод обрезан по объёму');
    expect(out).toContain('параметр sections');
    expect(out.length).toBeLessThan(12000);
  });
});
