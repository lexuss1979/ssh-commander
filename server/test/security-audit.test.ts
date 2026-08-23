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

/** Мок exec: записывает вызовы, sudo-проверку считает успешной/неуспешной. */
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
  it('covers all sections; docker собирается не shell-командами', () => {
    for (const section of ALL_SECTIONS) {
      expect(Array.isArray(commandsForSection(section))).toBe(true);
    }
    expect(commandsForSection('docker')).toEqual([]);
    expect(commandsForSection('auth').length).toBeGreaterThan(0);
  });

  it('marks root-only подсекции в auth', () => {
    const titles = commandsForSection('auth')
      .filter((c) => c.rootOnly)
      .map((c) => c.title);
    expect(titles).toEqual([
      'Пустые пароли (/etc/shadow)',
      'NOPASSWD в sudoers',
      'Ключи root (/root/.ssh/authorized_keys)',
    ]);
  });

  it('все команды — из фиксированного белого списка (без пользовательского ввода)', () => {
    for (const section of ALL_SECTIONS) {
      for (const cmd of commandsForSection(section)) {
        expect(cmd.command).toBeTruthy();
        expect(typeof cmd.title).toBe('string');
      }
    }
  });
});

describe('sudoWrap', () => {
  it('оборачивает команду в sudo -S без пароля в строке команды', () => {
    const wrapped = sudoWrap(`awk -F: '$2=="" {print $1}' /etc/shadow`);
    expect(wrapped.startsWith(`sudo -S -p '' -- sh -c '`)).toBe(true);
    expect(wrapped).toContain('/etc/shadow');
    // Пароль сюда не передаётся вообще — проверка ниже на уровне runSecurityAudit.
  });

  it('экранирует одинарные кавычки внутри команды', () => {
    const wrapped = sudoWrap(`awk -F: '$3==0 {print $1}' /etc/passwd`);
    expect(wrapped).toBe(`sudo -S -p '' -- sh -c 'awk -F: '\\''$3==0 {print $1}'\\'' /etc/passwd'`);
  });
});

describe('limitLines', () => {
  it('обрезает длинный вывод с пометкой', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const limited = limitLines(text, 3);
    expect(limited).toContain('line0');
    expect(limited).not.toContain('line3\n');
    expect(limited).toContain('обрезано: показано 3 из 10 строк');
  });

  it('не трогает короткий вывод', () => {
    expect(limitLines('a\nb', 5)).toBe('a\nb');
  });
});

describe('findContainerIssues', () => {
  it('флагает privileged, host network, docker.sock и монтирование корня', () => {
    const issues = findContainerIssues({
      HostConfig: { Privileged: true, NetworkMode: 'host', Binds: ['/:/host:ro'] },
      Mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    });
    expect(issues).toContain('privileged-режим');
    expect(issues).toContain('сеть host');
    expect(issues).toContain('монтирует /var/run/docker.sock');
    expect(issues).toContain('монтирует корень ФС (/)');
  });

  it('обычный контейнер — без замечаний', () => {
    expect(
      findContainerIssues({
        HostConfig: { Privileged: false, NetworkMode: 'bridge', Binds: ['/srv/data:/data'] },
        Mounts: [],
      }),
    ).toEqual([]);
  });
});

describe('normalizeSections', () => {
  it('по умолчанию — все секции', () => {
    expect(normalizeSections()).toEqual(ALL_SECTIONS);
    expect(normalizeSections([])).toEqual(ALL_SECTIONS);
  });

  it('фильтрует неизвестные секции', () => {
    expect(normalizeSections(['auth', 'bogus'])).toEqual(['auth']);
    expect(normalizeSections(['bogus'])).toEqual(ALL_SECTIONS);
  });
});

describe('runSecurityAudit', () => {
  it('без пароля root-подсекции пропускаются, остальное выполняется', async () => {
    const { calls, execFn } = fakeExec();
    // listContainersFn обязателен: без него docker-секция ходит в реальный
    // SSH и зависит от того, слушает ли что-то локальный порт 22.
    const out = await runSecurityAudit(
      profile,
      { privileged: true },
      { execFn, listContainersFn: async () => [] },
    );
    expect(out).toContain('root-проверки пропущены');
    expect(out).toContain('пропущено: нет прав (нужен sudo)');
    expect(out).toContain('ok-output');
    // Ни одна команда не ушла через sudo.
    expect(calls.every((c) => !c.command.startsWith('sudo '))).toBe(true);
  });

  it('с паролем root-команды идут через sudo, пароль — только в stdin', async () => {
    const { calls, execFn } = fakeExec({ sudoOk: true });
    const password = 's3cret-pass';
    const out = await runSecurityAudit(
      profile,
      { sections: ['auth'], privileged: true, sudoPassword: password },
      { execFn },
    );
    // Пароль нигде не появляется в строках команд и в выводе отчёта.
    expect(out).not.toContain(password);
    for (const call of calls) {
      expect(call.command).not.toContain(password);
    }
    // sudo-проверка и root-подсекции получили пароль в stdin.
    const sudoCalls = calls.filter((c) => c.command.startsWith(`sudo -S -p '' --`));
    expect(sudoCalls.length).toBeGreaterThan(1);
    for (const call of sudoCalls) {
      expect(call.stdin).toBe(`${password}\n`);
    }
    expect(out).not.toContain('пропущено: нет прав');
  });

  it('нерабочий sudo — мягкая деградация с пометкой', async () => {
    const { execFn } = fakeExec({ sudoOk: false });
    const out = await runSecurityAudit(
      profile,
      { sections: ['auth'], privileged: true, sudoPassword: 'bad' },
      { execFn },
    );
    expect(out).toContain('sudo не сработал');
    expect(out).toContain('пропущено: нет прав (нужен sudo)');
  });

  it('непривилегированный режим не запрашивает sudo вообще', async () => {
    const { calls, execFn } = fakeExec();
    await runSecurityAudit(profile, { sections: ['network'] }, { execFn });
    expect(calls.some((c) => c.command.startsWith('sudo '))).toBe(false);
    expect(calls.some((c) => c.stdin !== undefined)).toBe(false);
  });

  it('docker недоступен — пометка, а не ошибка', async () => {
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

  it('docker: проблемные контейнеры перечисляются с флагами', async () => {
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

  it('общий вывод ограничен по объёму с подсказкой про sections', async () => {
    const big = 'x'.repeat(4000);
    const { execFn } = fakeExec({ stdout: big });
    const out = await runSecurityAudit(
      profile,
      {},
      { execFn, listContainersFn: async () => [] },
    );
    expect(out).toContain('вывод обрезан по объёму');
    expect(out).toContain('параметр sections');
    expect(out.length).toBeLessThan(12000);
  });
});
