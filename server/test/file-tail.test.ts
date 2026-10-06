import { describe, expect, it } from 'vitest';
import {
  assertNotDirectory,
  buildTailFollowCommand,
  buildTailOnceCommand,
  clampTailLines,
  looksBinary,
  TAIL_MAX_LINES,
} from '../src/services/file-tail.js';
import { shq } from '../src/util/shell.js';

describe('buildTailOnceCommand / buildTailFollowCommand', () => {
  it('escapes the path and puts -- before it', () => {
    expect(buildTailOnceCommand('/var/log/app.log', 500)).toBe(`tail -n 500 -- ${shq('/var/log/app.log')}`);
    expect(buildTailFollowCommand('/var/log/app.log', 500)).toBe(
      `tail -n 500 -F -- ${shq('/var/log/app.log')}`,
    );
  });

  it('a path with spaces, quotes and a leading dash — one escaped argument', () => {
    const weird = "/tmp/my logs/'quoted'/-weird.log";
    expect(buildTailOnceCommand(weird, 10)).toBe(`tail -n 10 -- ${shq(weird)}`);
    expect(buildTailFollowCommand(weird, 10)).not.toContain('-- -weird.log\'');
  });

  it('-F exists only in the follow variant', () => {
    expect(buildTailOnceCommand('/a', 5)).not.toContain('-F');
    expect(buildTailFollowCommand('/a', 5)).toContain(' -F ');
  });

  it('clampTailLines is applied inside the command build', () => {
    expect(buildTailOnceCommand('/a', 999999)).toBe(`tail -n ${TAIL_MAX_LINES} -- ${shq('/a')}`);
  });
});

describe('clampTailLines', () => {
  it('0 and negatives — 1', () => {
    expect(clampTailLines(0)).toBe(1);
    expect(clampTailLines(-5)).toBe(1);
  });

  it('fractions — rounded down', () => {
    expect(clampTailLines(10.9)).toBe(10);
  });

  it('beyond the maximum — truncated', () => {
    expect(clampTailLines(5001)).toBe(5000);
    expect(clampTailLines(1e9)).toBe(5000);
  });

  it('NaN/Infinity — the default', () => {
    expect(clampTailLines(Number.NaN)).toBe(500);
    expect(clampTailLines(Number.POSITIVE_INFINITY)).toBe(500);
  });
});

describe('assertNotDirectory', () => {
  it('a directory mode — an error', () => {
    expect(() => assertNotDirectory(0o040755)).toThrow('Это директория');
    expect(() => assertNotDirectory(0o40000)).toThrow('Это директория');
  });

  it('a file and a symlink pass', () => {
    expect(() => assertNotDirectory(0o100644)).not.toThrow();
    expect(() => assertNotDirectory(0o120777)).not.toThrow();
  });
});

describe('looksBinary', () => {
  it('a NUL byte at the start or in the middle — binary', () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from([0x61, 0x62, 0x00, 0x63]))).toBe(true);
  });

  it('text without NUL — not binary', () => {
    expect(looksBinary(Buffer.from('2026-08-23 hello\n'))).toBe(false);
  });

  it('an empty and a short buffer — not binary', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
    expect(looksBinary(Buffer.from('a'))).toBe(false);
  });
});
