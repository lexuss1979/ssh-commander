import { describe, expect, it } from 'vitest';
import { getProfilePrivileges, parsePrivileges, PRIVILEGES_CMD } from '../src/services/privileges.js';
import type { ExecResult } from '../src/types.js';
import type { Profile } from '../src/types.js';

// The privileges probe (docs/agent-access-levels-plan.md): a pure parser over
// the marker output plus the exec-level service with deps {execFn} (the
// systemd.ts pattern). The probe influences only the strength of the UI
// warning for the 'never' access level, never the availability of the mode.

const profile = (id: string): Profile => ({
  id, name: id, host: 'test.local', port: 22,
  username: 'user', authType: 'password', dockerCommand: 'docker',
});

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

const PROBE_OUTPUT = 'uid=1000\ngroups=users docker\nsudo_np=no\n';

describe('parsePrivileges', () => {
  it('uid=0 → root', () => {
    expect(parsePrivileges('uid=0\ngroups=root\nsudo_np=yes\n')).toEqual({ isRoot: true, sudo: true });
  });

  it('uid=1000 with sudo_np=yes → sudo', () => {
    expect(parsePrivileges('uid=1000\ngroups=users\nsudo_np=yes\n')).toEqual({ isRoot: false, sudo: true });
  });

  it('uid=1000 in the wheel group → sudo (the sudo binary may be missing)', () => {
    expect(parsePrivileges('uid=1000\ngroups=users wheel\nsudo_np=no\n')).toEqual({ isRoot: false, sudo: true });
  });

  it('uid=1000 in the sudo group → sudo', () => {
    expect(parsePrivileges('uid=1000\ngroups=sudo\nsudo_np=no\n')).toEqual({ isRoot: false, sudo: true });
  });

  it('uid=1000 without groups and sudo_np=no → both false', () => {
    expect(parsePrivileges('uid=1000\ngroups=users\nsudo_np=no\n')).toEqual({ isRoot: false, sudo: false });
  });

  it('a group name containing "sudo" as a substring does not count', () => {
    expect(parsePrivileges('uid=1000\ngroups=sudouserz\nsudo_np=no\n')).toEqual({ isRoot: false, sudo: false });
  });

  it('missing lines are tolerated (empty output)', () => {
    expect(parsePrivileges('')).toEqual({ isRoot: false, sudo: false });
  });
});

describe('getProfilePrivileges', () => {
  it('runs one exec and parses the answer', async () => {
    const calls: string[] = [];
    const result = await getProfilePrivileges(profile('priv-1'), {
      execFn: async (_p, command) => {
        calls.push(command);
        return ok(PROBE_OUTPUT);
      },
    });
    expect(result).toEqual({ isRoot: false, sudo: false });
    expect(calls).toEqual([PRIVILEGES_CMD]);
  });

  it('caches per profile: the second call does not exec', async () => {
    let calls = 0;
    await getProfilePrivileges(profile('priv-cache'), {
      execFn: async () => {
        calls += 1;
        return ok('uid=0\ngroups=root\nsudo_np=yes\n');
      },
    });
    const second = await getProfilePrivileges(profile('priv-cache'), {
      execFn: async () => {
        calls += 1;
        return ok(PROBE_OUTPUT);
      },
    });
    expect(calls).toBe(1);
    expect(second).toEqual({ isRoot: true, sudo: true });
  });

  it('a transport error propagates and evicts the cache (the next call retries)', async () => {
    let calls = 0;
    const failing = getProfilePrivileges(profile('priv-err'), {
      execFn: async () => {
        calls += 1;
        throw new Error('connection refused');
      },
    });
    await expect(failing).rejects.toThrow('connection refused');
    const retried = await getProfilePrivileges(profile('priv-err'), {
      execFn: async () => {
        calls += 1;
        return ok('uid=0\ngroups=root\nsudo_np=yes\n');
      },
    });
    expect(calls).toBe(2);
    expect(retried).toEqual({ isRoot: true, sudo: true });
  });
});
