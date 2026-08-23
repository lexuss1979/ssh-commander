import { describe, expect, it } from 'vitest';
import { createChunkGate, createFollowLimiter } from '../src/services/stream-limits.js';

describe('createFollowLimiter', () => {
  it('разрешает acquire до максимума и отказывает сверх', () => {
    const limiter = createFollowLimiter(3);
    expect(limiter.acquire('p1')).toBe(true);
    expect(limiter.acquire('p1')).toBe(true);
    expect(limiter.acquire('p1')).toBe(true);
    expect(limiter.acquire('p1')).toBe(false);
    expect(limiter.count('p1')).toBe(3);
  });

  it('release освобождает слот', () => {
    const limiter = createFollowLimiter(2);
    limiter.acquire('p1');
    limiter.acquire('p1');
    expect(limiter.acquire('p1')).toBe(false);
    limiter.release('p1');
    expect(limiter.acquire('p1')).toBe(true);
  });

  it('release при нуле не уходит в минус', () => {
    const limiter = createFollowLimiter(2);
    limiter.release('p1');
    limiter.release('p1');
    expect(limiter.count('p1')).toBe(0);
    expect(limiter.acquire('p1')).toBe(true);
    expect(limiter.acquire('p1')).toBe(true);
  });

  it('ключи (профили) независимы', () => {
    const limiter = createFollowLimiter(1);
    expect(limiter.acquire('p1')).toBe(true);
    expect(limiter.acquire('p2')).toBe(true);
    expect(limiter.acquire('p1')).toBe(false);
    expect(limiter.count('p2')).toBe(1);
  });

  it('release удаляет ключ при нуле', () => {
    const limiter = createFollowLimiter(1);
    limiter.acquire('p1');
    limiter.release('p1');
    // повторный release по удалённому ключу — по-прежнему безопасен
    limiter.release('p1');
    expect(limiter.count('p1')).toBe(0);
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

  it('finish отдаёт маркер, если стрим закончился в состоянии дропа', () => {
    const gate = createChunkGate(1000);
    expect(gate.finish()).toBeNull();
    gate.push('aa\n', 2000); // 3 байта
    gate.push('bb\n', 2000); // 3 байта
    expect(gate.finish()).toBe('\n… [пропущено 6 байт — читатель не успевает] …\n');
    // finish сбрасывает счётчик — повторный вызов пуст
    expect(gate.finish()).toBeNull();
  });
});
