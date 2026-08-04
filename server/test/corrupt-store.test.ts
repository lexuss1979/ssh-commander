import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-corrupt-'));
process.env.DATA_DIR = dataDir;

const profiles = await import('../src/profiles.js');
const dialogues = await import('../src/ai/dialogues.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('corrupt store handling', () => {
  it('moves a broken profiles.json aside and refuses to persist', () => {
    writeFileSync(path.join(dataDir, 'profiles.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(profiles.listProfiles()).toEqual([]);

    const backups = readdirSync(dataDir).filter((f) => f.startsWith('profiles.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('{not json');
    expect(warn).toHaveBeenCalled();

    expect(() =>
      profiles.createProfile({
        name: 'x',
        host: 'h',
        username: 'u',
        authType: 'password',
        password: 'p',
      }),
    ).toThrow(/corrupt/);
    // The store file must not be recreated/overwritten while corrupt.
    expect(readdirSync(dataDir).filter((f) => f === 'profiles.json')).toHaveLength(0);
    warn.mockRestore();
  });

  it('moves a broken ai-dialogues.json aside and refuses to persist', () => {
    writeFileSync(path.join(dataDir, 'ai-dialogues.json'), '[broken');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(dialogues.listDialogues('p1')).toEqual([]);

    const backups = readdirSync(dataDir).filter((f) => f.startsWith('ai-dialogues.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe('[broken');
    expect(warn).toHaveBeenCalled();

    expect(() => dialogues.createDialogue('p1')).toThrow(/corrupt/);
    expect(readdirSync(dataDir).filter((f) => f === 'ai-dialogues.json')).toHaveLength(0);
    warn.mockRestore();
  });
});
