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
  it('экранирует путь и ставит -- перед ним', () => {
    expect(buildTailOnceCommand('/var/log/app.log', 500)).toBe(`tail -n 500 -- ${shq('/var/log/app.log')}`);
    expect(buildTailFollowCommand('/var/log/app.log', 500)).toBe(
      `tail -n 500 -F -- ${shq('/var/log/app.log')}`,
    );
  });

  it('путь с пробелами, кавычками и ведущим дефисом — один экранированный аргумент', () => {
    const weird = "/tmp/my logs/'quoted'/-weird.log";
    expect(buildTailOnceCommand(weird, 10)).toBe(`tail -n 10 -- ${shq(weird)}`);
    expect(buildTailFollowCommand(weird, 10)).not.toContain('-- -weird.log\'');
  });

  it('-F есть только у follow-варианта', () => {
    expect(buildTailOnceCommand('/a', 5)).not.toContain('-F');
    expect(buildTailFollowCommand('/a', 5)).toContain(' -F ');
  });

  it('clampTailLines применяется внутри сборки команды', () => {
    expect(buildTailOnceCommand('/a', 999999)).toBe(`tail -n ${TAIL_MAX_LINES} -- ${shq('/a')}`);
  });
});

describe('clampTailLines', () => {
  it('0 и отрицательные — 1', () => {
    expect(clampTailLines(0)).toBe(1);
    expect(clampTailLines(-5)).toBe(1);
  });

  it('дробные — округляются вниз', () => {
    expect(clampTailLines(10.9)).toBe(10);
  });

  it('сверх максимума — обрезается', () => {
    expect(clampTailLines(5001)).toBe(5000);
    expect(clampTailLines(1e9)).toBe(5000);
  });

  it('NaN/Infinity — дефолт', () => {
    expect(clampTailLines(Number.NaN)).toBe(500);
    expect(clampTailLines(Number.POSITIVE_INFINITY)).toBe(500);
  });
});

describe('assertNotDirectory', () => {
  it('режим директории — ошибка', () => {
    expect(() => assertNotDirectory(0o040755)).toThrow('Это директория');
    expect(() => assertNotDirectory(0o40000)).toThrow('Это директория');
  });

  it('файл и симлинк проходят', () => {
    expect(() => assertNotDirectory(0o100644)).not.toThrow();
    expect(() => assertNotDirectory(0o120777)).not.toThrow();
  });
});

describe('looksBinary', () => {
  it('NUL-байт в начале и в середине — бинарный', () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from([0x61, 0x62, 0x00, 0x63]))).toBe(true);
  });

  it('текст без NUL — не бинарный', () => {
    expect(looksBinary(Buffer.from('2026-08-23 hello\n'))).toBe(false);
  });

  it('пустой и короткий буфер — не бинарный', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
    expect(looksBinary(Buffer.from('a'))).toBe(false);
  });
});
