import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-profiles-'));
process.env.DATA_DIR = dataDir;
// Путь к ключу проверяется на принадлежность KEYS_DIR (services/keys.ts),
// поэтому у теста свой каталог ключей.
const keysDir = mkdtempSync(path.join(tmpdir(), 'sc-profiles-keys-'));
process.env.KEYS_DIR = keysDir;
const KEY_PATH = path.join(keysDir, 'id_rsa');

const profiles = await import('../src/profiles.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'srv',
    host: 'example.com',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret-1',
    ...overrides,
  };
}

describe('profiles store', () => {
  it('rejects a key path outside the keys directory', () => {
    expect(() =>
      profiles.createProfile(
        baseInput({ authType: 'key', keyPath: '/etc/ssl/private/other.key', password: undefined }),
      ),
    ).toThrow(/каталога ключей/);
  });

  it('hides secrets in the API shape (toSafeProfile)', () => {
    const created = profiles.createProfile(
      baseInput({ name: 'safe-shape', password: 'secret-1' }),
    );
    const safe = profiles.toSafeProfile(created) as Record<string, unknown>;
    expect(safe.password).toBeUndefined();
    expect(safe.keyPassphrase).toBeUndefined();
    expect(safe.hasPassword).toBe(true);
    expect(safe.hasKeyPassphrase).toBe(false);
    expect(safe.name).toBe('safe-shape');
    profiles.deleteProfile(created.id);
  });

  it('creates, reads, updates and deletes a profile', () => {
    const p = profiles.createProfile(baseInput());
    expect(p.id).toBeTruthy();
    expect(profiles.getProfile(p.id)?.name).toBe('srv');

    const updated = profiles.updateProfile(p.id, baseInput({ note: 'note' }));
    expect(updated.note).toBe('note');

    profiles.deleteProfile(p.id);
    expect(profiles.getProfile(p.id)).toBeUndefined();
  });

  it('keeps the stored secret when update omits it', () => {
    const p = profiles.createProfile(baseInput());
    const input = baseInput({ note: 'без пароля' }) as Record<string, unknown>;
    delete input.password;
    const updated = profiles.updateProfile(p.id, input);
    expect(updated.password).toBe('secret-1');
    expect(updated.note).toBe('без пароля');
    profiles.deleteProfile(p.id);
  });

  it('replaces the secret when update passes a new one', () => {
    const p = profiles.createProfile(baseInput());
    const updated = profiles.updateProfile(p.id, baseInput({ password: 'secret-2' }));
    expect(updated.password).toBe('secret-2');
    profiles.deleteProfile(p.id);
  });

  it('requires the matching secret when authType changes', () => {
    const p = profiles.createProfile(baseInput());
    expect(() =>
      profiles.updateProfile(p.id, baseInput({ authType: 'key', password: undefined })),
    ).toThrow(/keyPath is required/);
    const updated = profiles.updateProfile(
      p.id,
      baseInput({ authType: 'key', keyPath: KEY_PATH, password: undefined }),
    );
    expect(updated.authType).toBe('key');
    expect(updated.keyPath).toBe(KEY_PATH);
    // Old password is kept in storage but no longer required.
    profiles.deleteProfile(p.id);
  });

  it('rejects create without the required secret', () => {
    expect(() => profiles.createProfile(baseInput({ password: undefined }))).toThrow(
      /password is required/,
    );
    expect(() =>
      profiles.createProfile(baseInput({ authType: 'key', keyPath: undefined })),
    ).toThrow(/keyPath is required/);
  });

  it('stores key passphrase and keeps it on partial update', () => {
    const p = profiles.createProfile(
      baseInput({ authType: 'key', keyPath: KEY_PATH, keyPassphrase: 'phrase-1' }),
    );
    expect(p.keyPassphrase).toBe('phrase-1');

    // Update without the passphrase keeps the stored one.
    const input = baseInput({ authType: 'key', keyPath: KEY_PATH, note: 'n' }) as Record<
      string,
      unknown
    >;
    delete input.keyPassphrase;
    const kept = profiles.updateProfile(p.id, input);
    expect(kept.keyPassphrase).toBe('phrase-1');

    // Passing a new passphrase replaces it.
    const replaced = profiles.updateProfile(
      p.id,
      baseInput({ authType: 'key', keyPath: KEY_PATH, keyPassphrase: 'phrase-2' }),
    );
    expect(replaced.keyPassphrase).toBe('phrase-2');
    profiles.deleteProfile(p.id);
  });
});

describe('normalizeLogPaths', () => {
  it('принимает валидные абсолютные пути', () => {
    expect(profiles.normalizeLogPaths(['/var/log/syslog', '/var/log/nginx/error.log'])).toEqual([
      '/var/log/syslog',
      '/var/log/nginx/error.log',
    ]);
  });

  it('trim, пустые отбрасываются, дедуп с сохранением порядка', () => {
    expect(
      profiles.normalizeLogPaths(['  /var/log/a  ', '', '   ', '/var/log/a', '/var/log/b']),
    ).toEqual(['/var/log/a', '/var/log/b']);
  });

  it('не-абсолютный путь — исключение с перечнем плохих строк', () => {
    expect(() => profiles.normalizeLogPaths(['var/log/a'])).toThrow(/var\/log\/a/);
    expect(() => profiles.normalizeLogPaths(['/ok', 'relative/path'])).toThrow(/relative\/path/);
  });

  it('сегмент .. — исключение', () => {
    expect(() => profiles.normalizeLogPaths(['/var/log/../../etc/passwd'])).toThrow(/\.\./);
    expect(() => profiles.normalizeLogPaths(['/var/..'])).toThrow(/\.\./);
  });
});

describe('profile logPaths', () => {
  it('updateProfile без logPaths сохраняет существующие пины', () => {
    const p = profiles.createProfile(
      baseInput({ logPaths: ['/var/log/syslog', '/var/log/auth.log'] }),
    );
    const updated = profiles.updateProfile(p.id, baseInput({ note: 'edit in modal' }));
    expect(updated.logPaths).toEqual(['/var/log/syslog', '/var/log/auth.log']);
    profiles.deleteProfile(p.id);
  });

  it('updateProfileLogPaths заменяет список', () => {
    const p = profiles.createProfile(baseInput({ logPaths: ['/var/log/old.log'] }));
    const updated = profiles.updateProfileLogPaths(p.id, [
      '  /var/log/new.log  ',
      '/var/log/new.log',
      '/var/log/other.log',
    ]);
    expect(updated.logPaths).toEqual(['/var/log/new.log', '/var/log/other.log']);
    // замена, а не слияние
    expect(updated.logPaths).not.toContain('/var/log/old.log');
    profiles.deleteProfile(p.id);
  });

  it('updateProfileLogPaths отклоняет мусор и неизвестный профиль', () => {
    const p = profiles.createProfile(baseInput());
    expect(() => profiles.updateProfileLogPaths(p.id, ['not-absolute'])).toThrow(/Некорректные пути/);
    expect(() => profiles.updateProfileLogPaths('no-such-id', ['/a'])).toThrow(/not found/);
    profiles.deleteProfile(p.id);
  });

  it('createProfile прогоняет logPaths через normalizeLogPaths', () => {
    const p = profiles.createProfile(baseInput({ logPaths: ['  /var/log/a  ', '/var/log/a'] }));
    expect(p.logPaths).toEqual(['/var/log/a']);
    expect(() => profiles.createProfile(baseInput({ logPaths: ['relative/path'] }))).toThrow(
      /Некорректные пути/,
    );
  });

  it('updateProfile прогоняет logPaths через normalizeLogPaths', () => {
    const p = profiles.createProfile(baseInput());
    expect(() => profiles.updateProfile(p.id, baseInput({ logPaths: ['/ok', 'oops'] }))).toThrow(
      /Некорректные пути/,
    );
    profiles.deleteProfile(p.id);
  });
});
