import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-transfer-data-'));
const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-transfer-keys-'));
process.env.DATA_DIR = dataDir;
process.env.KEYS_DIR = keysDir;

const profiles = await import('../src/profiles.js');
const { ProfileTransferError, buildExport, importBackup } = await import(
  '../src/services/profile-transfer.js'
);

const OPENSSH_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n';

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

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(keysDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const p of profiles.listProfiles()) profiles.deleteProfile(p.id);
  for (const name of fs.readdirSync(keysDir)) fs.rmSync(path.join(keysDir, name));
});

describe('profile transfer', () => {
  it('round-trips profiles through an encrypted backup', () => {
    profiles.createProfile(baseInput());
    const backup = buildExport({ includeSecrets: true, passphrase: 'pw-123' });

    const envelope = JSON.parse(backup);
    expect(envelope.encrypted).toBe(true);
    expect(backup).not.toContain('secret-1');

    const summary = importBackup(backup, 'pw-123');
    expect(summary.imported).toBe(1);
    expect(summary.renamed).toEqual([{ from: 'srv', to: 'srv (2)' }]);
    const imported = profiles.listProfiles().find((p) => p.name === 'srv (2)');
    expect(imported?.password).toBe('secret-1');
    expect(imported?.host).toBe('example.com');
  });

  it('round-trips through a plaintext backup', () => {
    profiles.createProfile(baseInput());
    const backup = buildExport({ includeSecrets: true });
    expect(JSON.parse(backup).encrypted).toBe(false);
    const summary = importBackup(backup);
    expect(summary.imported).toBe(1);
  });

  it('round-trips logPaths through a plaintext backup', () => {
    profiles.createProfile(baseInput({ logPaths: ['/var/log/syslog', '/var/log/nginx/error.log'] }));
    const backup = buildExport({ includeSecrets: true });
    const summary = importBackup(backup);
    expect(summary.imported).toBe(1);
    const imported = profiles.listProfiles().find((p) => p.name === 'srv (2)');
    expect(imported?.logPaths).toEqual(['/var/log/syslog', '/var/log/nginx/error.log']);
  });

  it('rejects a backup with an invalid logPaths without writing anything', () => {
    const backup = JSON.stringify({
      app: 'ssh-commander-profiles',
      version: 1,
      encrypted: false,
      profiles: [baseInput({ logPaths: ['relative/path'] })],
      keys: [],
    });
    expect(() => importBackup(backup)).toThrow(/Некорректные пути/);
    expect(profiles.listProfiles()).toHaveLength(0);
  });

  it('rejects a wrong passphrase', () => {
    profiles.createProfile(baseInput());
    const backup = buildExport({ includeSecrets: true, passphrase: 'pw-123' });
    expect(() => importBackup(backup, 'pw-456')).toThrow(ProfileTransferError);
    expect(() => importBackup(backup, 'pw-456')).toThrow(/пароль|поврежд/);
  });

  it('requires a passphrase for encrypted backups', () => {
    profiles.createProfile(baseInput());
    const backup = buildExport({ includeSecrets: true, passphrase: 'pw-123' });
    expect(() => importBackup(backup)).toThrow(/зашифрован/);
  });

  it('detects tampered ciphertext', () => {
    profiles.createProfile(baseInput());
    const envelope = JSON.parse(buildExport({ includeSecrets: true, passphrase: 'pw-123' }));
    const raw = Buffer.from(envelope.data, 'base64');
    raw[0] ^= 0xff;
    envelope.data = raw.toString('base64');
    expect(() => importBackup(JSON.stringify(envelope), 'pw-123')).toThrow(/пароль|поврежд/);
  });

  it('strips secrets when includeSecrets=false and flags them on import', () => {
    profiles.createProfile(baseInput());
    const backup = buildExport({ includeSecrets: false, passphrase: 'pw-123' });
    expect(backup).not.toContain('secret-1');

    const summary = importBackup(backup, 'pw-123');
    expect(summary.needSecrets).toEqual(['srv (2)']);
    const imported = profiles.listProfiles().find((p) => p.name === 'srv (2)');
    expect(imported?.password).toBeUndefined();
  });

  it('bundles referenced keys and remaps keyPath on import', () => {
    const keyPath = path.join(keysDir, 'id_test');
    fs.writeFileSync(keyPath, OPENSSH_KEY);
    profiles.createProfile(
      baseInput({ authType: 'key', keyPath, password: undefined }),
    );

    const backup = buildExport({ includeSecrets: true, passphrase: 'pw-123' });
    // Удаляем ключ и профили: импорт должен восстановить ключ и перепривязать путь.
    fs.rmSync(keyPath);
    for (const p of profiles.listProfiles()) profiles.deleteProfile(p.id);

    const summary = importBackup(backup, 'pw-123');
    expect(summary.keysSaved).toBe(1);
    expect(summary.needSecrets).toEqual([]);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(OPENSSH_KEY);
    const imported = profiles.listProfiles()[0];
    expect(imported.keyPath).toBe(keyPath);
  });

  it('does not overwrite an existing key on import', () => {
    const keyPath = path.join(keysDir, 'id_test');
    fs.writeFileSync(keyPath, OPENSSH_KEY);
    profiles.createProfile(baseInput({ authType: 'key', keyPath, password: undefined }));
    const backup = buildExport({ includeSecrets: true, passphrase: 'pw-123' });

    const other = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3RoZXI=\n-----END OPENSSH PRIVATE KEY-----\n';
    fs.writeFileSync(keyPath, other);
    const summary = importBackup(backup, 'pw-123');
    expect(summary.keysSkipped).toEqual(['id_test']);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(other);
  });

  it('does not embed keys outside the keys directory', () => {
    const outside = path.join(dataDir, 'outside-key');
    fs.writeFileSync(outside, OPENSSH_KEY);
    profiles.createProfile(baseInput({ authType: 'key', keyPath: outside, password: undefined }));
    const backup = JSON.parse(buildExport({ includeSecrets: true }));
    expect(backup.keys).toEqual([]);
  });

  it('rejects garbage and foreign files', () => {
    expect(() => importBackup('not json')).toThrow(/JSON/);
    expect(() => importBackup('{"foo": 1}')).toThrow(ProfileTransferError);
    expect(() =>
      importBackup(JSON.stringify({ app: 'ssh-commander-profiles', version: 99, encrypted: false })),
    ).toThrow(/новее/);
  });

  it('rejects a backup with an invalid profile without writing anything', () => {
    const backup = JSON.stringify({
      app: 'ssh-commander-profiles',
      version: 1,
      encrypted: false,
      profiles: [{ name: 'broken' }],
      keys: [],
    });
    expect(() => importBackup(backup)).toThrow(/валидацию/);
    expect(profiles.listProfiles()).toEqual([]);
  });

  it('rejects a backup with a non-key file in keys', () => {
    const backup = JSON.stringify({
      app: 'ssh-commander-profiles',
      version: 1,
      encrypted: false,
      profiles: [],
      keys: [{ name: 'evil.sh', content: 'rm -rf /' }],
    });
    expect(() => importBackup(backup)).toThrow(/не похож/);
  });
});
