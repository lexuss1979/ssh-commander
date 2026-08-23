import { describe, expect, it } from 'vitest';
import {
  NICE_MAX,
  NICE_MIN,
  PROCESS_SIGNALS,
  ProcessActionError,
  classifyProcessActionFailure,
  killCommand,
  parsePid,
  reniceCommand,
  runProcessRenice,
  runProcessSignal,
  sudoKillCommand,
  sudoReniceCommand,
  type ExecFn,
} from '../src/services/processes.js';
import { reniceSchema, signalSchema } from '../src/routes/processes.js';
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

function result(code: number | null, message: string): ExecResult {
  return { code, stdout: '', stderr: message };
}

// ---------------------------------------------------------------------------
// parsePid
// ---------------------------------------------------------------------------

describe('parsePid', () => {
  it('валидные pid: 2..4194304', () => {
    expect(parsePid('2')).toBe(2);
    expect(parsePid('1234')).toBe(1234);
    expect(parsePid('4194304')).toBe(4194304);
  });

  it('запрещены 0, 1 (kill -0/-1 — группы/широковещание)', () => {
    expect(parsePid('0')).toBeNull();
    expect(parsePid('1')).toBeNull();
  });

  it('отрицательные, дробные, экспонента — мимо', () => {
    expect(parsePid('-1')).toBeNull();
    expect(parsePid('1.5')).toBeNull();
    expect(parsePid('1e3')).toBeNull();
  });

  it('ведущие нули и пробелы — мимо (каноничность)', () => {
    expect(parsePid('007')).toBeNull();
    expect(parsePid(' 12')).toBeNull();
  });

  it('нечисловое, пустое, мусор сверх pid_max — мимо', () => {
    expect(parsePid('abc')).toBeNull();
    expect(parsePid('')).toBeNull();
    expect(parsePid('4194305')).toBeNull();
    expect(parsePid('12345678901234567890')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Whitelist сигналов и диапазон nice (zod-схемы роута)
// ---------------------------------------------------------------------------

describe('валидация сигнала (signalSchema)', () => {
  it('TERM/KILL/HUP принимаются', () => {
    for (const signal of PROCESS_SIGNALS) {
      expect(signalSchema.safeParse({ signal }).success).toBe(true);
    }
  });

  it('SIGKILL, 9, kill, пустое — мимо', () => {
    for (const signal of ['SIGKILL', '9', 'kill', '']) {
      expect(signalSchema.safeParse({ signal }).success).toBe(false);
    }
  });

  it('константа — ровно whitelist', () => {
    expect(PROCESS_SIGNALS).toEqual(['TERM', 'KILL', 'HUP']);
  });
});

describe('валидация nice (reniceSchema)', () => {
  it('−20 и 19 принимаются', () => {
    expect(reniceSchema.safeParse({ nice: NICE_MIN }).success).toBe(true);
    expect(reniceSchema.safeParse({ nice: NICE_MAX }).success).toBe(true);
  });

  it('−21, 20, дробное, NaN — мимо', () => {
    expect(reniceSchema.safeParse({ nice: NICE_MIN - 1 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: NICE_MAX + 1 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: 1.5 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: NaN }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Сборка команд
// ---------------------------------------------------------------------------

describe('сборка команд', () => {
  it('kill: `kill -<sig> <pid>` без -- (builtin login-shell)', () => {
    expect(killCommand('TERM', 1234)).toBe('kill -TERM 1234');
    expect(killCommand('KILL', 2)).toBe('kill -KILL 2');
  });

  it('sudo-форма kill: sudo -S -p \'\' -- kill -<sig> <pid> без sh -c', () => {
    expect(sudoKillCommand('TERM', 1234)).toBe("sudo -S -p '' -- kill -TERM 1234");
  });

  it('renice: отрицательный nice — законное значение опции -n', () => {
    expect(reniceCommand(5, 1234)).toBe('renice -n 5 -p 1234');
    expect(reniceCommand(-5, 1234)).toBe('renice -n -5 -p 1234');
    expect(reniceCommand(-20, 2)).toBe('renice -n -20 -p 2');
  });

  it('sudo-форма renice', () => {
    expect(sudoReniceCommand(-5, 1234)).toBe("sudo -S -p '' -- renice -n -5 -p 1234");
  });
});

// ---------------------------------------------------------------------------
// classifyProcessActionFailure
// ---------------------------------------------------------------------------

describe('classifyProcessActionFailure', () => {
  it('код 0 → ok', () => {
    expect(classifyProcessActionFailure(result(0, ''))).toBe('ok');
  });

  it('EPERM (util-linux и builtin bash) → sudo-needed', () => {
    expect(classifyProcessActionFailure(result(1, 'kill: (1234) - Operation not permitted'))).toBe('sudo-needed');
    expect(
      classifyProcessActionFailure(result(1, 'bash: line 1: kill: (1234) - Operation not permitted')),
    ).toBe('sudo-needed');
  });

  it('renice Permission denied → sudo-needed', () => {
    expect(
      classifyProcessActionFailure(result(1, 'renice: failed to set niceness for process 1234: Permission denied')),
    ).toBe('sudo-needed');
  });

  it('No such process (kill и renice) → gone', () => {
    expect(classifyProcessActionFailure(result(1, 'kill: (1234) - No such process'))).toBe('gone');
    expect(
      classifyProcessActionFailure(result(1, 'renice: failed to set niceness for process 1234: No such process')),
    ).toBe('gone');
  });

  it('утилиты нет (sh и sudo) → no-tool', () => {
    expect(classifyProcessActionFailure(result(127, 'sh: renice: command not found'))).toBe('no-tool');
    expect(classifyProcessActionFailure(result(127, 'sudo: renice: command not found'))).toBe('no-tool');
  });

  it('мусор → transport', () => {
    expect(classifyProcessActionFailure(result(255, 'connection reset'))).toBe('transport');
  });
});

// ---------------------------------------------------------------------------
// runProcessSignal / runProcessRenice: поток с sudo-ретраем
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  stdin?: string;
}

/** Мок exec: настраиваемое поведение по команде (паттерн systemd.test.ts). */
function fakeExec(router: (command: string, stdin?: string) => ExecResult) {
  const calls: ExecCall[] = [];
  const execFn: ExecFn = async (_p, command, opts) => {
    calls.push({ command, stdin: opts?.stdin });
    return router(command, opts?.stdin);
  };
  return { calls, execFn };
}

const PROBE = "sudo -S -p '' -- true";

describe('runProcessSignal', () => {
  it('успех без sudo: kill -TERM, output пустой', async () => {
    const { calls, execFn } = fakeExec(() => result(0, ''));
    const out = await runProcessSignal(profile, 1234, 'TERM', undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '' });
    expect(calls.map((c) => c.command)).toEqual(['kill -TERM 1234']);
  });

  it('gone → 400 «больше не существует», без retry', async () => {
    const { calls, execFn } = fakeExec(() => result(1, 'kill: (1234) - No such process'));
    try {
      await runProcessSignal(profile, 1234, 'KILL', 's3cret', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('больше не существует');
    }
    expect(calls).toHaveLength(1);
  });

  it('no-tool → 400 «Команда `kill` недоступна»', async () => {
    const { execFn } = fakeExec(() => result(127, 'sudo: kill: command not found'));
    try {
      await runProcessSignal(profile, 1234, 'TERM', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('недоступна на этом сервере');
    }
  });

  it('EPERM без пароля → 400 «укажите sudo-пароль», действие не выполняется', async () => {
    const { calls, execFn } = fakeExec(() => result(1, 'kill: (1234) - Operation not permitted'));
    try {
      await runProcessSignal(profile, 1234, 'TERM', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('укажите sudo-пароль');
    }
    expect(calls).toHaveLength(1);
  });

  it('EPERM + пароль → зонд ok → sudo-ретрай ok; пароль только в stdin', async () => {
    const { calls, execFn } = fakeExec((command, stdin) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(0, '');
      return result(1, 'kill: (1234) - Operation not permitted');
    });
    const out = await runProcessSignal(profile, 1234, 'TERM', 's3cret', { execFn });
    expect(out).toEqual({ ok: true, output: '' });
    expect(calls.map((c) => c.command)).toEqual([
      'kill -TERM 1234',
      PROBE,
      "sudo -S -p '' -- kill -TERM 1234",
    ]);
    expect(calls[1].stdin).toBe('s3cret\n');
    expect(calls[2].stdin).toBe('s3cret\n');
    expect(calls.every((c) => !c.command.includes('s3cret'))).toBe(true);
  });

  it('зонд «Sorry, try again» → 400 «Неверный sudo-пароль»', async () => {
    const { calls, execFn } = fakeExec((command) =>
      command === PROBE ? result(1, 'Sorry, try again.') : result(1, 'kill: (1234) - Operation not permitted'),
    );
    try {
      await runProcessSignal(profile, 1234, 'TERM', 'bad', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toBe('Неверный sudo-пароль');
    }
    expect(calls).toHaveLength(2);
  });

  it('зонд «not in the sudoers» → 400 «нет прав sudo»', async () => {
    const { execFn } = fakeExec((command) =>
      command === PROBE
        ? result(1, 'test is not in the sudoers file. This incident will be reported.')
        : result(1, 'kill: (1234) - Operation not permitted'),
    );
    try {
      await runProcessSignal(profile, 1234, 'TERM', 'x', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('нет прав sudo');
    }
  });

  it('зонд-мусор → 502', async () => {
    const { execFn } = fakeExec((command) =>
      command === PROBE ? result(1, 'some odd error') : result(1, 'kill: (1234) - Operation not permitted'),
    );
    try {
      await runProcessSignal(profile, 1234, 'TERM', 'x', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(502);
    }
  });

  it('sudo-ретрай с ненулевым кодом → 502', async () => {
    const { calls, execFn } = fakeExec((command) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(1, 'sudo: kill: command not found');
      return result(1, 'kill: (1234) - Operation not permitted');
    });
    try {
      await runProcessSignal(profile, 1234, 'TERM', 's3cret', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(502);
    }
    expect(calls).toHaveLength(3);
  });
});

describe('runProcessRenice', () => {
  it('успех своего процесса (+5, без sudo): вывод renice в output', async () => {
    const { calls, execFn } = fakeExec(() => result(0, '1234: old priority 0, new priority 5'));
    const out = await runProcessRenice(profile, 1234, 5, undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '1234: old priority 0, new priority 5' });
    expect(calls.map((c) => c.command)).toEqual(['renice -n 5 -p 1234']);
  });

  it('понижение (−5) → EPERM → sudo-ветка с паролем', async () => {
    const { calls, execFn } = fakeExec((command) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(0, '1234: old priority 0, new priority -5');
      return result(1, 'renice: failed to set niceness for process 1234: Permission denied');
    });
    const out = await runProcessRenice(profile, 1234, -5, 's3cret', { execFn });
    expect(out).toEqual({ ok: true, output: '1234: old priority 0, new priority -5' });
    expect(calls.map((c) => c.command)).toEqual([
      'renice -n -5 -p 1234',
      PROBE,
      "sudo -S -p '' -- renice -n -5 -p 1234",
    ]);
    expect(calls.every((c) => !c.command.includes('s3cret'))).toBe(true);
  });

  it('EPERM без пароля → 400 «укажите sudo-пароль»', async () => {
    const { execFn } = fakeExec(() => result(1, 'renice: failed to set niceness for process 1234: Permission denied'));
    try {
      await runProcessRenice(profile, 1234, -5, undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('укажите sudo-пароль');
    }
  });

  it('нет renice (BusyBox) → 400, а не 502', async () => {
    const { execFn } = fakeExec(() => result(127, 'sh: renice: command not found'));
    try {
      await runProcessRenice(profile, 1234, 5, undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toBe('Команда `renice` недоступна на этом сервере');
    }
  });
});
