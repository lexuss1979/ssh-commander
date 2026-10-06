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
  it('valid pids: 2..4194304', () => {
    expect(parsePid('2')).toBe(2);
    expect(parsePid('1234')).toBe(1234);
    expect(parsePid('4194304')).toBe(4194304);
  });

  it('0 and 1 are rejected (kill -0/-1 — process groups/broadcast)', () => {
    expect(parsePid('0')).toBeNull();
    expect(parsePid('1')).toBeNull();
  });

  it('negatives, fractions, exponent — out', () => {
    expect(parsePid('-1')).toBeNull();
    expect(parsePid('1.5')).toBeNull();
    expect(parsePid('1e3')).toBeNull();
  });

  it('leading zeros and spaces — out (canonicity)', () => {
    expect(parsePid('007')).toBeNull();
    expect(parsePid(' 12')).toBeNull();
  });

  it('non-numeric, empty, garbage beyond pid_max — out', () => {
    expect(parsePid('abc')).toBeNull();
    expect(parsePid('')).toBeNull();
    expect(parsePid('4194305')).toBeNull();
    expect(parsePid('12345678901234567890')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The signal whitelist and the nice range (the route zod schemas)
// ---------------------------------------------------------------------------

describe('signal validation (signalSchema)', () => {
  it('TERM/KILL/HUP are accepted', () => {
    for (const signal of PROCESS_SIGNALS) {
      expect(signalSchema.safeParse({ signal }).success).toBe(true);
    }
  });

  it('SIGKILL, 9, kill, empty — out', () => {
    for (const signal of ['SIGKILL', '9', 'kill', '']) {
      expect(signalSchema.safeParse({ signal }).success).toBe(false);
    }
  });

  it('the constant is exactly the whitelist', () => {
    expect(PROCESS_SIGNALS).toEqual(['TERM', 'KILL', 'HUP']);
  });
});

describe('nice validation (reniceSchema)', () => {
  it('−20 and 19 are accepted', () => {
    expect(reniceSchema.safeParse({ nice: NICE_MIN }).success).toBe(true);
    expect(reniceSchema.safeParse({ nice: NICE_MAX }).success).toBe(true);
  });

  it('−21, 20, a fraction, NaN — out', () => {
    expect(reniceSchema.safeParse({ nice: NICE_MIN - 1 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: NICE_MAX + 1 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: 1.5 }).success).toBe(false);
    expect(reniceSchema.safeParse({ nice: NaN }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

describe('command builders', () => {
  it('kill: `kill -<sig> <pid>` without -- (the login-shell builtin)', () => {
    expect(killCommand('TERM', 1234)).toBe('kill -TERM 1234');
    expect(killCommand('KILL', 2)).toBe('kill -KILL 2');
  });

  it('the sudo form of kill: sudo -S -p \'\' -- kill -<sig> <pid> without sh -c', () => {
    expect(sudoKillCommand('TERM', 1234)).toBe("sudo -S -p '' -- kill -TERM 1234");
  });

  it('renice: a negative nice is a legitimate value of the -n option', () => {
    expect(reniceCommand(5, 1234)).toBe('renice -n 5 -p 1234');
    expect(reniceCommand(-5, 1234)).toBe('renice -n -5 -p 1234');
    expect(reniceCommand(-20, 2)).toBe('renice -n -20 -p 2');
  });

  it('the sudo form of renice', () => {
    expect(sudoReniceCommand(-5, 1234)).toBe("sudo -S -p '' -- renice -n -5 -p 1234");
  });
});

// ---------------------------------------------------------------------------
// classifyProcessActionFailure
// ---------------------------------------------------------------------------

describe('classifyProcessActionFailure', () => {
  it('code 0 → ok', () => {
    expect(classifyProcessActionFailure(result(0, ''))).toBe('ok');
  });

  it('EPERM (util-linux and the bash builtin) → sudo-needed', () => {
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

  it('No such process (kill and renice) → gone', () => {
    expect(classifyProcessActionFailure(result(1, 'kill: (1234) - No such process'))).toBe('gone');
    expect(
      classifyProcessActionFailure(result(1, 'renice: failed to set niceness for process 1234: No such process')),
    ).toBe('gone');
  });

  it('the utility is missing (sh and sudo) → no-tool', () => {
    expect(classifyProcessActionFailure(result(127, 'sh: renice: command not found'))).toBe('no-tool');
    expect(classifyProcessActionFailure(result(127, 'sudo: renice: command not found'))).toBe('no-tool');
  });

  it('garbage → transport', () => {
    expect(classifyProcessActionFailure(result(255, 'connection reset'))).toBe('transport');
  });
});

// ---------------------------------------------------------------------------
// runProcessSignal / runProcessRenice: the flow with a sudo retry
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  stdin?: string;
}

/** Mocked exec: per-command configurable behavior (the systemd.test.ts pattern). */
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
  it('success without sudo: kill -TERM, an empty output', async () => {
    const { calls, execFn } = fakeExec(() => result(0, ''));
    const out = await runProcessSignal(profile, 1234, 'TERM', undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '' });
    expect(calls.map((c) => c.command)).toEqual(['kill -TERM 1234']);
  });

  it('gone → 400 "no longer exists", no retry', async () => {
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

  it('no-tool → 400 "the `kill` command is unavailable"', async () => {
    const { execFn } = fakeExec(() => result(127, 'sudo: kill: command not found'));
    try {
      await runProcessSignal(profile, 1234, 'TERM', undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('недоступна на этом сервере');
    }
  });

  it('EPERM without a password → 400 "specify the sudo password", the action is not run', async () => {
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

  it('EPERM + a password → a green probe → a sudo retry ok; the password only in stdin', async () => {
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

  it('the probe "Sorry, try again" → 400 "wrong sudo password"', async () => {
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

  it('the probe "not in the sudoers" → 400 "no sudo rights"', async () => {
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

  it('probe garbage → 502', async () => {
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

  it('the sudo retry: the utility is missing (sudo: kill: command not found) → 400, not 502', async () => {
    // no-tool is impossible on the plain path (kill is a login-shell builtin);
    // the only path where a binary miss is real is the sudo retry,
    // and it must yield 400 "unavailable on this server", not 502.
    const { calls, execFn } = fakeExec((command) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(127, 'sudo: kill: command not found');
      return result(1, 'kill: (1234) - Operation not permitted');
    });
    try {
      await runProcessSignal(profile, 1234, 'TERM', 's3cret', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('недоступна на этом сервере');
    }
    expect(calls).toHaveLength(3);
  });

  it('the sudo retry: the process died during the probe → 400 "no longer exists"', async () => {
    const { execFn } = fakeExec((command) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(1, 'sudo: kill: (1234) - No such process');
      return result(1, 'kill: (1234) - Operation not permitted');
    });
    try {
      await runProcessSignal(profile, 1234, 'TERM', 's3cret', { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('больше не существует');
    }
  });

  it('the sudo retry with a non-zero code (transport) → 502', async () => {
    const { calls, execFn } = fakeExec((command) => {
      if (command === PROBE) return result(0, '');
      if (command.startsWith('sudo ')) return result(255, 'connection reset');
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
  it('success on an own process (+5, no sudo): the renice output lands in output', async () => {
    const { calls, execFn } = fakeExec(() => result(0, '1234: old priority 0, new priority 5'));
    const out = await runProcessRenice(profile, 1234, 5, undefined, { execFn });
    expect(out).toEqual({ ok: true, output: '1234: old priority 0, new priority 5' });
    expect(calls.map((c) => c.command)).toEqual(['renice -n 5 -p 1234']);
  });

  it('a decrease (−5) → EPERM → the sudo branch with the password', async () => {
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

  it('EPERM without a password → 400 "specify the sudo password"', async () => {
    const { execFn } = fakeExec(() => result(1, 'renice: failed to set niceness for process 1234: Permission denied'));
    try {
      await runProcessRenice(profile, 1234, -5, undefined, { execFn });
      expect.unreachable();
    } catch (err) {
      expect((err as ProcessActionError).status).toBe(400);
      expect((err as Error).message).toContain('укажите sudo-пароль');
    }
  });

  it('no renice (BusyBox) → 400, not 502', async () => {
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
