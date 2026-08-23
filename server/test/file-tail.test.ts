import { describe, expect, it } from 'vitest';
import {
  assertNotDirectory,
  buildTailFollowCommand,
  buildTailOnceCommand,
  clampTailLines,
  createChunkGate,
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

describe('createChunkGate', () => {
  it('в норме пропускает чанки как есть', () => {
    const gate = createChunkGate(1000);
    expect(gate.push('hello\n', 10)).toBe('hello\n');
    expect(gate.push('world\n', 999)).toBe('world\n');
  });

  it('за лимитом дропает чанки', () => {
    const gate = createChunkGate(1000);
    expect(gate.push('big\n', 1001)).toBeNull();
    expect(gate.push('bigger\n', 5000)).toBeNull();
  });

  it('при возврате в норму отдаёт маркер с суммой пропущенного', () => {
    const gate = createChunkGate(1000);
    gate.push('aa\n', 2000); // 3 байта
    gate.push('bbbb\n', 2000); // 5 байт
    const out = gate.push('ok\n', 0);
    expect(out).toBe('\n… [пропущено 8 байт — читатель не успевает] …\nok\n');
  });

  it('после маркера счётчик сброшен', () => {
    const gate = createChunkGate(1000);
    gate.push('aa\n', 2000);
    gate.push('ok\n', 0);
    expect(gate.push('next\n', 0)).toBe('next\n');
  });

  it('граница: bufferedBytes равен лимиту — ещё норма', () => {
    const gate = createChunkGate(1000);
    expect(gate.push('edge\n', 1000)).toBe('edge\n');
    expect(gate.push('over\n', 1001)).toBeNull();
  });
});
