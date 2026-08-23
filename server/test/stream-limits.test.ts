import { describe, expect, it } from 'vitest';
import { createFollowLimiter } from '../src/services/stream-limits.js';

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
