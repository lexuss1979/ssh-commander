import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  MAX_MEMORY_BYTES,
  memoryPath,
  memoryPromptBlock,
  readMemory,
  writeMemory,
} from '../src/ai/memory.js';

const originalDataDir = config.dataDir;

describe('agent memory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-memory-'));
    config.dataDir = dir;
  });

  afterEach(() => {
    config.dataDir = originalDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no memory yet', () => {
    expect(readMemory('abc123')).toBeNull();
    expect(memoryPromptBlock('abc123')).toBeNull();
  });

  it('writes and reads MEMORY.md for a profile', () => {
    const result = writeMemory('abc123', '# Заметки\n\n- факт 1\n');
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
    expect(readMemory('abc123')).toBe('# Заметки\n\n- факт 1\n');
  });

  it('overwrites the whole file on next write', () => {
    writeMemory('abc123', 'old');
    writeMemory('abc123', 'new');
    expect(readMemory('abc123')).toBe('new');
  });

  it('builds a prompt block from the stored memory', () => {
    writeMemory('abc123', 'факт');
    expect(memoryPromptBlock('abc123')).toBe('Память профиля (MEMORY.md — заметки из прошлых сессий):\nфакт');
  });

  it('keeps paths inside DATA_DIR/memory regardless of profile id', () => {
    for (const id of ['abc', 'a/b', '../secret', '..', '', 'a b$c', 'a\\b']) {
      const file = memoryPath(id);
      expect(path.resolve(file).startsWith(path.resolve(dir, 'memory') + path.sep), id).toBe(true);
      expect(file.endsWith('MEMORY.md'), id).toBe(true);
    }
  });

  it('truncates oversized memory files with a note', () => {
    const big = 'x'.repeat(MAX_MEMORY_BYTES + 1000);
    const file = memoryPath('abc123');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, big, 'utf8');
    const content = readMemory('abc123');
    expect(content).not.toBeNull();
    expect(content!.length).toBeLessThan(big.length);
    expect(content).toContain('MEMORY.md больше');
  });

  it('rejects writes above the read limit', () => {
    expect(() => writeMemory('abc123', 'y'.repeat(MAX_MEMORY_BYTES + 1))).toThrow(/слишком большой/);
    expect(readMemory('abc123')).toBeNull();
  });
});
