import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-profiles-'));
process.env.DATA_DIR = dataDir;

const profiles = await import('../src/profiles.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
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
      baseInput({ authType: 'key', keyPath: '/keys/id_rsa', password: undefined }),
    );
    expect(updated.authType).toBe('key');
    expect(updated.keyPath).toBe('/keys/id_rsa');
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
});
