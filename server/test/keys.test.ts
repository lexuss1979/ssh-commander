import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KeyImportError,
  MAX_KEY_BYTES,
  assertPrivateKeyContent,
  sanitizeKeyFileName,
  saveKey,
} from '../src/services/keys.js';

const OPENSSH_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n';

describe('key import', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-keys-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts plain safe names', () => {
    expect(sanitizeKeyFileName('id_rsa')).toBe('id_rsa');
    expect(sanitizeKeyFileName('my-key.ed25519')).toBe('my-key.ed25519');
    expect(sanitizeKeyFileName('  id_rsa  ')).toBe('id_rsa');
  });

  it('rejects paths, dotfiles and unsafe characters', () => {
    for (const bad of ['', '  ', '.', '..', '../id_rsa', 'a/b', 'a\\b', '.hidden', 'my key', 'key;rm', 'a\0b']) {
      expect(() => sanitizeKeyFileName(bad), JSON.stringify(bad)).toThrow(KeyImportError);
    }
  });

  it('accepts PEM/OpenSSH private key content', () => {
    expect(() => assertPrivateKeyContent(OPENSSH_KEY)).not.toThrow();
    expect(() =>
      assertPrivateKeyContent('-----BEGIN RSA PRIVATE KEY-----\nxxx\n-----END RSA PRIVATE KEY-----'),
    ).not.toThrow();
    expect(() =>
      assertPrivateKeyContent('-----BEGIN ENCRYPTED PRIVATE KEY-----\nxxx'),
    ).not.toThrow();
  });

  it('rejects empty, oversized and non-key content', () => {
    expect(() => assertPrivateKeyContent('')).toThrow(/пуст/);
    expect(() => assertPrivateKeyContent('ssh-rsa AAAA... public key')).toThrow(/не похож/);
    expect(() =>
      assertPrivateKeyContent('x'.repeat(MAX_KEY_BYTES + 1)),
    ).toThrow(/слишком большой/);
  });

  it('saves a key atomically with 0600 permissions', () => {
    const entry = saveKey(dir, 'id_rsa', OPENSSH_KEY, false);
    expect(entry.name).toBe('id_rsa');
    expect(entry.path).toBe(path.join(dir, 'id_rsa'));
    expect(fs.readFileSync(entry.path, 'utf8')).toBe(OPENSSH_KEY);
    expect(fs.statSync(entry.path).mode & 0o777).toBe(0o600);
    // Временных файлов после записи не остаётся.
    expect(fs.readdirSync(dir)).toEqual(['id_rsa']);
  });

  it('refuses to overwrite an existing key without confirmation', () => {
    saveKey(dir, 'id_rsa', OPENSSH_KEY, false);
    expect(() => saveKey(dir, 'id_rsa', OPENSSH_KEY, false)).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('overwrites an existing key when confirmed, keeping 0600', () => {
    saveKey(dir, 'id_rsa', OPENSSH_KEY, false);
    fs.chmodSync(path.join(dir, 'id_rsa'), 0o644);
    const updated = '-----BEGIN OPENSSH PRIVATE KEY-----\nbmV3\n-----END OPENSSH PRIVATE KEY-----\n';
    saveKey(dir, 'id_rsa', updated, true);
    expect(fs.readFileSync(path.join(dir, 'id_rsa'), 'utf8')).toBe(updated);
    expect(fs.statSync(path.join(dir, 'id_rsa')).mode & 0o777).toBe(0o600);
  });
});
