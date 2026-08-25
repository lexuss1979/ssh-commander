import { describe, expect, it } from 'vitest';
import {
  applyCrontabOp,
  CronConflictError,
  describeSchedule,
  isValidCronUser,
  parseCrontab,
  validateCronFields,
} from '../src/services/cron.js';

// Пользовательский crontab: задачи, @keyword, env, комментарии, выключенная задача.
const USER_CRONTAB = `# бэкап каждую ночь
0 3 * * * /home/user/backup.sh --full

MAILTO=admin@example.com
PATH=/usr/local/bin:/usr/bin

*/15 * * * * /usr/bin/curl -fsS https://hc-ping.com/abc
@reboot /home/user/start-agent.sh
# 30 4 * * 0 /opt/weekly-report.sh
SHELL=/bin/bash
`;

// /etc/crontab: системный формат с колонкой пользователя.
const SYSTEM_CRONTAB = `# /etc/crontab: system-wide crontab
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin

17 * * * * root cd / && run-parts --report /etc/cron.hourly
25 6 * * * root test -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )
47 6 * * 7 www-data /usr/bin/php /var/www/artisan schedule:run
`;

describe('parseCrontab (user)', () => {
  it('parses entries, env and comments', () => {
    const parsed = parseCrontab(USER_CRONTAB, { system: false });
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.env).toHaveLength(3);
    expect(parsed.comments).toEqual(['# бэкап каждую ночь']);

    expect(parsed.entries[0]).toMatchObject({
      index: 1,
      raw: '0 3 * * * /home/user/backup.sh --full',
      enabled: true,
      schedule: '0 3 * * *',
      command: '/home/user/backup.sh --full',
    });
    expect(parsed.entries[0].user).toBeUndefined();
  });

  it('parses @keyword entries', () => {
    const parsed = parseCrontab(USER_CRONTAB, { system: false });
    const reboot = parsed.entries.find((e) => e.schedule === '@reboot');
    expect(reboot).toMatchObject({ enabled: true, command: '/home/user/start-agent.sh' });
  });

  it('treats commented cron lines as disabled entries', () => {
    const parsed = parseCrontab(USER_CRONTAB, { system: false });
    const disabled = parsed.entries.find((e) => !e.enabled);
    expect(disabled).toMatchObject({
      raw: '# 30 4 * * 0 /opt/weekly-report.sh',
      schedule: '30 4 * * 0',
      command: '/opt/weekly-report.sh',
    });
  });

  it('does not treat plain comments or env as disabled entries', () => {
    const parsed = parseCrontab(USER_CRONTAB, { system: false });
    expect(parsed.entries.every((e) => e.command !== '' && !e.raw.startsWith('MAILTO'))).toBe(true);
    expect(parsed.comments).not.toContain('# 30 4 * * 0 /opt/weekly-report.sh');
  });
});

describe('parseCrontab (system)', () => {
  it('parses the user column', () => {
    const parsed = parseCrontab(SYSTEM_CRONTAB, { system: true });
    expect(parsed.entries).toHaveLength(3);

    expect(parsed.entries[0]).toMatchObject({
      schedule: '17 * * * *',
      user: 'root',
      command: 'cd / && run-parts --report /etc/cron.hourly',
    });

    const php = parsed.entries[2];
    expect(php).toMatchObject({
      schedule: '47 6 * * 7',
      user: 'www-data',
      command: '/usr/bin/php /var/www/artisan schedule:run',
    });
  });

  it('keeps env lines and comments separate', () => {
    const parsed = parseCrontab(SYSTEM_CRONTAB, { system: true });
    expect(parsed.env).toHaveLength(2);
    expect(parsed.comments).toEqual(['# /etc/crontab: system-wide crontab']);
  });

  it('returns empty lists on empty/garbage input', () => {
    expect(parseCrontab('', { system: false })).toEqual({ entries: [], env: [], comments: [] });
    expect(parseCrontab('hello world\n', { system: false }).entries).toEqual([]);
  });
});

describe('describeSchedule', () => {
  it('describes @keywords', () => {
    expect(describeSchedule('@reboot')).toBe('при загрузке системы');
    expect(describeSchedule('@daily')).toBe('ежедневно');
    expect(describeSchedule('@hourly')).toBe('ежечасно');
  });

  it('describes common five-field expressions', () => {
    expect(describeSchedule('* * * * *')).toBe('каждую минуту');
    expect(describeSchedule('*/15 * * * *')).toBe('каждые 15 мин');
    expect(describeSchedule('30 * * * *')).toBe('ежечасно в :30');
    expect(describeSchedule('0 */6 * * *')).toBe('каждые 6 ч');
    expect(describeSchedule('0 3 * * *')).toBe('ежедневно в 03:00');
    expect(describeSchedule('30 9 * * 1-5')).toBe('по будням в 09:30');
    expect(describeSchedule('0 10 * * 1')).toBe('еженедельно (пн) в 10:00');
    expect(describeSchedule('0 10 * * 0')).toBe('еженедельно (вс) в 10:00');
  });

  it('falls back to the raw expression', () => {
    expect(describeSchedule('0 3 1 * *')).toBe('0 3 1 * *');
    expect(describeSchedule('@sometimes')).toBe('@sometimes');
  });
});

describe('isValidCronUser', () => {
  it('accepts common Linux login names', () => {
    expect(isValidCronUser('root')).toBe(true);
    expect(isValidCronUser('www-data')).toBe(true);
    expect(isValidCronUser('deploy')).toBe(true);
    expect(isValidCronUser('web_1')).toBe(true);
    expect(isValidCronUser('a')).toBe(true);
  });

  it('rejects names that could break the shell', () => {
    expect(isValidCronUser('web; rm -rf /')).toBe(false);
    expect(isValidCronUser('a b')).toBe(false);
    expect(isValidCronUser('../etc/passwd')).toBe(false);
    expect(isValidCronUser('user/name')).toBe(false);
    expect(isValidCronUser('a$(id)')).toBe(false);
    expect(isValidCronUser('')).toBe(false);
    expect(isValidCronUser('a'.repeat(40))).toBe(false);
  });
});

describe('validateCronFields', () => {  it('accepts valid schedules', () => {
    expect(validateCronFields('0 3 * * *')).toBeNull();
    expect(validateCronFields('*/15 0-23/2 1,15 jan,Feb mon-fri')).toBeNull();
    expect(validateCronFields('@reboot')).toBeNull();
    expect(validateCronFields('  @daily  ')).toBeNull();
  });

  it('rejects invalid schedules with Russian messages', () => {
    expect(validateCronFields('')).toContain('не задано');
    expect(validateCronFields('0 3 * *')).toContain('5 полей');
    expect(validateCronFields('0 3 * * * extra')).toContain('5 полей');
    expect(validateCronFields('@nope')).toContain('Неизвестный пресет');
    expect(validateCronFields('abc * * * *')).toContain('Недопустимое поле');
    expect(validateCronFields('99 * * * *')).toContain('вне диапазона');
    expect(validateCronFields('0 25 * * *')).toContain('вне диапазона');
    expect(validateCronFields('0 0 0 * *')).toContain('вне диапазона');
  });
});

describe('applyCrontabOp', () => {
  it('adds an entry preserving comments and env', () => {
    const next = applyCrontabOp(USER_CRONTAB, { type: 'add', schedule: '0 5 * * *', command: '/bin/true' });
    expect(next).toContain('# бэкап каждую ночь');
    expect(next).toContain('MAILTO=admin@example.com');
    expect(next.trimEnd().endsWith('0 5 * * * /bin/true')).toBe(true);
    // исходные строки на месте
    const parsed = parseCrontab(next, { system: false });
    expect(parsed.entries).toHaveLength(5);
  });

  it('adds to an empty crontab', () => {
    expect(applyCrontabOp('', { type: 'add', schedule: '@daily', command: 'echo hi' })).toBe('@daily echo hi\n');
  });

  it('updates an entry by index', () => {
    const next = applyCrontabOp(USER_CRONTAB, {
      type: 'update',
      index: 1,
      expectedRaw: '0 3 * * * /home/user/backup.sh --full',
      schedule: '0 4 * * *',
      command: '/home/user/backup.sh',
    });
    expect(next.split('\n')[1]).toBe('0 4 * * * /home/user/backup.sh');
  });

  it('deletes an entry by index', () => {
    const next = applyCrontabOp(USER_CRONTAB, {
      type: 'delete',
      index: 1,
      expectedRaw: '0 3 * * * /home/user/backup.sh --full',
    });
    expect(next).not.toContain('backup.sh --full');
    expect(next).toContain('MAILTO=admin@example.com');
  });

  it('toggles entries off and on', () => {
    const off = applyCrontabOp(USER_CRONTAB, {
      type: 'toggle',
      index: 1,
      expectedRaw: '0 3 * * * /home/user/backup.sh --full',
    });
    expect(off.split('\n')[1]).toBe('# 0 3 * * * /home/user/backup.sh --full');

    const on = applyCrontabOp(off, {
      type: 'toggle',
      index: 1,
      expectedRaw: '# 0 3 * * * /home/user/backup.sh --full',
    });
    expect(on.split('\n')[1]).toBe('0 3 * * * /home/user/backup.sh --full');
  });

  it('throws CronConflictError on stale expectedRaw', () => {
    expect(() =>
      applyCrontabOp(USER_CRONTAB, { type: 'delete', index: 1, expectedRaw: '0 0 * * * /other.sh' }),
    ).toThrow(CronConflictError);
    expect(() =>
      applyCrontabOp(USER_CRONTAB, { type: 'toggle', index: 99, expectedRaw: 'x' }),
    ).toThrow(CronConflictError);
  });

  it('always ends with a newline', () => {
    const next = applyCrontabOp('0 1 * * * /bin/true', {
      type: 'add',
      schedule: '0 2 * * *',
      command: '/bin/false',
    });
    expect(next.endsWith('\n')).toBe(true);
  });
});
