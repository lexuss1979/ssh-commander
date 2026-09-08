import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  algoFromBlob,
  checkHostKey,
  fingerprintOf,
  forgetHostKey,
  hostKeyMismatchMessage,
  resetKnownHostsCache,
} from '../src/services/known-hosts.js';

/** Блоб публичного ключа в формате RFC 4253: длина + имя алгоритма + тело. */
function blob(algo: string, body: string): Buffer {
  const name = Buffer.from(algo, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length);
  return Buffer.concat([len, name, Buffer.from(body, 'utf8')]);
}

const KEY_A = blob('ssh-ed25519', 'key-material-a');
const KEY_B = blob('ssh-ed25519', 'key-material-b');

describe('known hosts (TOFU)', () => {
  const originalDataDir = config.dataDir;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-known-hosts-'));
    config.dataDir = dir;
    resetKnownHostsCache();
  });

  afterEach(() => {
    config.dataDir = originalDataDir;
    resetKnownHostsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('запоминает ключ при первой встрече и узнаёт его потом', () => {
    const first = checkHostKey('example.com', 22, KEY_A);
    expect(first.status).toBe('new');
    expect(first.algo).toBe('ssh-ed25519');
    expect(first.fingerprint).toMatch(/^SHA256:/);

    const second = checkHostKey('example.com', 22, KEY_A);
    expect(second.status).toBe('match');
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('ловит подмену ключа и отдаёт оба отпечатка', () => {
    const first = checkHostKey('example.com', 22, KEY_A);
    const changed = checkHostKey('example.com', 22, KEY_B);
    expect(changed.status).toBe('mismatch');
    expect(changed.knownFingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    const message = hostKeyMismatchMessage('example.com', 22, changed);
    expect(message).toContain(first.fingerprint);
    expect(message).toContain('ssh-keyscan');
  });

  it('хост и порт различаются, регистр имени — нет', () => {
    checkHostKey('example.com', 22, KEY_A);
    expect(checkHostKey('example.com', 2222, KEY_B).status).toBe('new');
    expect(checkHostKey('EXAMPLE.com', 22, KEY_A).status).toBe('match');
  });

  it('после forgetHostKey хост снова незнакомый', () => {
    checkHostKey('example.com', 22, KEY_A);
    forgetHostKey('example.com', 22);
    expect(checkHostKey('example.com', 22, KEY_B).status).toBe('new');
  });

  it('файл переживает перезапуск и пишется с правами 0600', () => {
    const first = checkHostKey('example.com', 22, KEY_A);
    resetKnownHostsCache();
    expect(checkHostKey('example.com', 22, KEY_A).status).toBe('match');

    const file = path.join(dir, 'known-hosts.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hosts['example.com:22'].fingerprint).toBe(
      first.fingerprint,
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    }
  });

  it('битый файл не ломает старт: отодвигается и заводится заново', () => {
    fs.writeFileSync(path.join(dir, 'known-hosts.json'), '{ не json');
    expect(checkHostKey('example.com', 22, KEY_A).status).toBe('new');
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('отпечаток — sha256 в формате ssh-keygen, алгоритм читается из блоба', () => {
    expect(fingerprintOf(KEY_A)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(algoFromBlob(KEY_A)).toBe('ssh-ed25519');
    expect(algoFromBlob(Buffer.from([0, 0]))).toBe('unknown');
  });
});
