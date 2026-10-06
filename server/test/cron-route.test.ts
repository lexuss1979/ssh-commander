import { describe, expect, it, vi, beforeEach } from 'vitest';
import { collectCron, fetchCronUsers } from '../src/services/cron.js';
import { exec } from '../src/ssh/manager.js';
import type { Profile } from '../src/types.js';

vi.mock('../src/ssh/manager.js', () => ({ exec: vi.fn() }));
const mockedExec = vi.mocked(exec);

const base: Profile = {
  id: 'p1',
  name: 'test',
  host: '127.0.0.1',
  port: 2222,
  username: 'test',
  authType: 'password',
  password: 'secret',
};

/** Each test takes its own id so the snapshot cache (2 s per profile) does not interfere. */
function profileOf(id: string): Profile {
  return { ...base, id };
}

type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * A fake exec: hands out answers by the command content. `root` decides
 * what `id -u` returns.
 */
function fakeExec(root: boolean) {
  mockedExec.mockImplementation(async (_profile: Profile, cmd: string): Promise<ExecResult> => {
    if (cmd.includes('id -u')) {
      return { code: 0, stdout: root ? '0 root' : '1000 test', stderr: '' };
    }
    // the spool list of users with a crontab
    if (cmd.includes('sort -u')) {
      return { code: 0, stdout: 'deploy\nwww-data\n', stderr: '' };
    }
    // reading someone else's crontab via -u
    if (cmd.includes('crontab -u')) {
      return { code: 0, stdout: '0 0 * * * /usr/bin/php /var/www/app/artisan queue:restart\n', stderr: '' };
    }
    // the own crontab
    if (cmd.includes('crontab -l')) {
      return { code: 0, stdout: '15 * * * * /usr/local/bin/healthcheck\n', stderr: '' };
    }
    // the system sources (empty — we return null/[])
    if (cmd.includes('/etc/crontab')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  });
}

beforeEach(() => {
  mockedExec.mockReset();
});

describe('fetchCronUsers', () => {
  it('returns [] when the SSH user is not root', async () => {
    fakeExec(false);
    expect(await fetchCronUsers(profileOf('a1'))).toEqual([]);
  });

  it('returns current user + users with crontab when root', async () => {
    fakeExec(true);
    const users = await fetchCronUsers(profileOf('a2'));
    expect(users).toContain('root');
    expect(users).toContain('www-data');
    expect(users).toContain('deploy');
  });
});

describe('collectCron with user', () => {
  it('current user snapshot is editable and shows currentUser', async () => {
    fakeExec(true);
    const s = await collectCron(profileOf('b1'));
    expect(s.currentUser).toBe('root');
    expect(s.username).toBe('root');
    expect(s.editable).toBe(true);
    expect(s.userCrontab?.entries).toHaveLength(1);
  });

  it('other user snapshot is read-only', async () => {
    fakeExec(true);
    const s = await collectCron(profileOf('b2'), 'www-data');
    expect(s.currentUser).toBe('root');
    expect(s.username).toBe('www-data');
    expect(s.editable).toBe(false);
    expect(s.userCrontab?.entries[0].command).toContain('artisan queue:restart');
  });

  it('falls back to current user when not root', async () => {
    fakeExec(false);
    const s = await collectCron(profileOf('b3'), 'www-data');
    expect(s.currentUser).toBe('test');
    expect(s.username).toBe('test');
    expect(s.editable).toBe(true);
  });

  it('falls back to current user for an unknown username', async () => {
    fakeExec(true);
    const s = await collectCron(profileOf('b4'), 'not-a-real-user');
    expect(s.username).toBe('root');
    expect(s.editable).toBe(true);
  });
});
