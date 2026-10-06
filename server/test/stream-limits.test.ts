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
// stream-limits: the shared per-profile follow-stream limiter
// ---------------------------------------------------------------------------

describe('stream-limits', () => {
  it('acquire/release change the profile counter', () => {
    const pid = 'sl-acquire';
    expect(followStreamCount(pid)).toBe(0);
    expect(acquireFollowSlot(pid)).toBe(true);
    expect(followStreamCount(pid)).toBe(1);
    releaseFollowSlot(pid);
    expect(followStreamCount(pid)).toBe(0);
  });

  it('the cutoff at the limit boundary: beyond it — false', () => {
    const pid = 'sl-limit';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) {
      expect(acquireFollowSlot(pid)).toBe(true);
    }
    expect(followStreamCount(pid)).toBe(FOLLOW_STREAM_LIMIT);
    expect(acquireFollowSlot(pid)).toBe(false);
    expect(followStreamCount(pid)).toBe(FOLLOW_STREAM_LIMIT);
  });

  it('release is idempotent: a double release does not push the counter negative', () => {
    const pid = 'sl-idempotent';
    acquireFollowSlot(pid);
    releaseFollowSlot(pid);
    releaseFollowSlot(pid);
    releaseFollowSlot(pid);
    expect(followStreamCount(pid)).toBe(0);
  });

  it('release for an unknown profile — a no-op', () => {
    expect(() => releaseFollowSlot('sl-unknown')).not.toThrow();
    expect(followStreamCount('sl-unknown')).toBe(0);
  });

  it('after a full release the slots are available again', () => {
    const pid = 'sl-reuse';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) acquireFollowSlot(pid);
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) releaseFollowSlot(pid);
    expect(acquireFollowSlot(pid)).toBe(true);
  });

  it('the key is the profile: the slots of different profiles do not overlap', () => {
    const a = 'sl-pa';
    const b = 'sl-pb';
    for (let i = 0; i < FOLLOW_STREAM_LIMIT; i++) acquireFollowSlot(a);
    expect(acquireFollowSlot(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chunk-gate: dropping chunks on socket overflow + the "skipped N bytes" marker
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
  it('passes chunks normally', () => {
    const res = fakeRes(1024);
    const write = gate(res);
    write('line1\n');
    write('line2\n');
    expect(res.writes).toEqual(['line1\n', 'line2\n']);
  });

  it('drops chunks at writableLength > 1 MB, on recovery writes a marker with the total', () => {
    const res = fakeRes(2 * 1024 * 1024); // overflowed
    const write = gate(res);
    write('a'.repeat(100)); // dropped: 100 bytes
    write('b'.repeat(250)); // dropped: 250 more (350 accumulated)
    expect(res.writes).toEqual([]);
    res.writableLength = 0; // the socket drained
    write('ok\n');
    expect(res.writes[0]).toContain('пропущено 350 байт');
    expect(res.writes[1]).toBe('ok\n');
    // The marker is one-shot: the next chunk without a drop goes directly.
    write('again\n');
    expect(res.writes).toHaveLength(3);
    expect(res.writes[2]).toBe('again\n');
  });

  it('does not write into a destroyed response', () => {
    const res = fakeRes(0);
    res.destroyed = true;
    const write = gate(res);
    write('x');
    expect(res.writes).toEqual([]);
  });

  it('the drop counter resets after the marker', () => {
    const res = fakeRes(2 * 1024 * 1024);
    const write = gate(res);
    write('a'.repeat(10));
    res.writableLength = 0;
    write('ok');
    res.writableLength = 2 * 1024 * 1024;
    write('b'.repeat(5));
    res.writableLength = 0;
    write('ok2');
    // The second marker counts only the second drop cycle (5 bytes), not 10+5.
    expect(res.writes[2]).toContain('пропущено 5 байт');
  });
});

describe('createChunkGate.finish', () => {
  it('a marker for the bytes dropped before the end of the stream', () => {
    const res = fakeRes(2 * 1024 * 1024);
    const write = gate(res);
    write('a'.repeat(100));
    write('b'.repeat(50));
    expect(res.writes).toEqual([]);
    write.finish();
    expect(res.writes[0]).toContain('пропущено 150 байт');
    // finish resets the counter — a repeated call writes nothing.
    expect(res.writes).toHaveLength(1);
    write.finish();
    expect(res.writes).toHaveLength(1);
  });

  it('without drops finish writes nothing', () => {
    const res = fakeRes(0);
    const write = gate(res);
    write('ok\n');
    write.finish();
    expect(res.writes).toEqual(['ok\n']);
  });
});
