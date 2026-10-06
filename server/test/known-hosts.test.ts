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

/** A public key blob in the RFC 4253 format: the length + the algorithm name + the body. */
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

  it('remembers the key at the first encounter and recognizes it later', () => {
    const first = checkHostKey('example.com', 22, KEY_A);
    expect(first.status).toBe('new');
    expect(first.algo).toBe('ssh-ed25519');
    expect(first.fingerprint).toMatch(/^SHA256:/);

    const second = checkHostKey('example.com', 22, KEY_A);
    expect(second.status).toBe('match');
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('catches a key substitution and returns both fingerprints', () => {
    const first = checkHostKey('example.com', 22, KEY_A);
    const changed = checkHostKey('example.com', 22, KEY_B);
    expect(changed.status).toBe('mismatch');
    expect(changed.knownFingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    const message = hostKeyMismatchMessage('example.com', 22, changed);
    expect(message).toContain(first.fingerprint);
    expect(message).toContain('ssh-keyscan');
  });

  it('host and port differ, the name case does not', () => {
    checkHostKey('example.com', 22, KEY_A);
    expect(checkHostKey('example.com', 2222, KEY_B).status).toBe('new');
    expect(checkHostKey('EXAMPLE.com', 22, KEY_A).status).toBe('match');
  });

  it('after forgetHostKey the host is unknown again', () => {
    checkHostKey('example.com', 22, KEY_A);
    forgetHostKey('example.com', 22);
    expect(checkHostKey('example.com', 22, KEY_B).status).toBe('new');
  });

  it('the file survives a restart and is written with 0600', () => {
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

  it('a broken file does not break the start: it is moved aside and started anew', () => {
    fs.writeFileSync(path.join(dir, 'known-hosts.json'), '{ не json');
    expect(checkHostKey('example.com', 22, KEY_A).status).toBe('new');
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('the fingerprint is sha256 in the ssh-keygen format, the algorithm is read from the blob', () => {
    expect(fingerprintOf(KEY_A)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(algoFromBlob(KEY_A)).toBe('ssh-ed25519');
    expect(algoFromBlob(Buffer.from([0, 0]))).toBe('unknown');
  });
});
