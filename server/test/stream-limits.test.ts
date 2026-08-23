import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createChunkGate } from '../src/services/chunk-gate.js';
import {
  FOLLOW_STREAM_LIMIT,
  acquireFollowSlot,
  followStreamCount,
  releaseFollowSlot,
} from '../src/services/stream-limits.js';

// ---------------------------------------------------------------------------
// stream-limits: общий лимитер follow-стримов на профиль
// ---------------------------------------------------------------------------

describe('stream-limits', () => {
  it('acquire/release меняют счётчик профиля', () => {
    const pid = 'sl-acquire';
    expect(followStreamCount(pid)).toBe(0);
    expect(acquireFollowSlot(pid)).toBe(true);
    expect(followStreamCount(pid)).toBe(1);
    releaseFollowSlot(pid);
    expect(followStreamCount(pid)).toBe(0);
  });

  it('отсечка на границе лимита: сверх — false', () => {
    const pid = 'sl-limit';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) {
      expect(acquireFollowSlot(pid)).toBe(true);
    }
    expect(followStreamCount(pid)).toBe(FOLLOW_STREAM_LIMIT);
    expect(acquireFollowSlot(pid)).toBe(false);
    expect(followStreamCount(pid)).toBe(FOLLOW_STREAM_LIMIT);
  });

  it('release идемпотентен: двойной release не уводит счётчик в минус', () => {
    const pid = 'sl-idempotent';
    acquireFollowSlot(pid);
    releaseFollowSlot(pid);
    releaseFollowSlot(pid);
    releaseFollowSlot(pid);
    expect(followStreamCount(pid)).toBe(0);
  });

  it('release для неизвестного профиля — no-op', () => {
    expect(() => releaseFollowSlot('sl-unknown')).not.toThrow();
    expect(followStreamCount('sl-unknown')).toBe(0);
  });

  it('после полного освобождения слоты снова доступны', () => {
    const pid = 'sl-reuse';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) acquireFollowSlot(pid);
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) releaseFollowSlot(pid);
    expect(acquireFollowSlot(pid)).toBe(true);
  });

  it('ключ — профиль: слоты разных профилей не пересекаются', () => {
    const a = 'sl-pa';
    const b = 'sl-pb';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) acquireFollowSlot(a);
    expect(acquireFollowSlot(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chunk-gate: дроп чанков при переполнении сокета + маркер «пропущено N байт»
// ---------------------------------------------------------------------------

interface FakeRes {
  writes: string[];
  destroyed: boolean;
  writableLength: number;
  write: (chunk: string) => boolean;
}

function fakeRes(writableLength = 0): FakeRes {
  return {
    writes: [],
    destroyed: false,
    writableLength,
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
  };
}

function gate(res: FakeRes): (chunk: string) => void {
  return createChunkGate(res as unknown as ServerResponse);
}

describe('createChunkGate', () => {
  it('пропускает чанки в норме', () => {
    const res = fakeRes(1024);
    const write = gate(res);
    write('line1\n');
    write('line2\n');
    expect(res.writes).toEqual(['line1\n', 'line2\n']);
  });

  it('дропает чанки при writableLength > 1 МБ, при возврате в норму пишет маркер с суммой', () => {
    const res = fakeRes(2 * 1024 * 1024); // переполнено
    const write = gate(res);
    write('a'.repeat(100)); // дроп: 100 байт
    write('b'.repeat(250)); // дроп: ещё 250 (накоплено 350)
    expect(res.writes).toEqual([]);
    res.writableLength = 0; // сокет освободился
    write('ok\n');
    expect(res.writes[0]).toContain('пропущено 350 байт');
    expect(res.writes[1]).toBe('ok\n');
    // Маркер одноразовый: следующий чанк без дропа идёт напрямую.
    write('again\n');
    expect(res.writes).toHaveLength(3);
    expect(res.writes[2]).toBe('again\n');
  });

  it('не пишет в уничтоженный response', () => {
    const res = fakeRes(0);
    res.destroyed = true;
    const write = gate(res);
    write('x');
    expect(res.writes).toEqual([]);
  });

  it('счётчик дропа сбрасывается после маркера', () => {
    const res = fakeRes(2 * 1024 * 1024);
    const write = gate(res);
    write('a'.repeat(10));
    res.writableLength = 0;
    write('ok');
    res.writableLength = 2 * 1024 * 1024;
    write('b'.repeat(5));
    res.writableLength = 0;
    write('ok2');
    // Второй маркер считает только второй цикл дропа (5 байт), не 10+5.
    expect(res.writes[2]).toContain('пропущено 5 байт');
  });
});
