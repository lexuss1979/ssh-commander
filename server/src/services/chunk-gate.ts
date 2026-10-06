import type { ServerResponse } from 'node:http';

/**
 * Backpressure chunk gate for follow-streams (epic 13, per the epic 14
 * plan).
 *
 * The epic 14 plan considered pausing the SSH channel on
 * `res.write() === false` with resumption on `drain` and **rejected** it:
 * that would require exposing the channel through the `execStream` API.
 * The accepted mechanism is a gate on the route side: when
 * `res.writableLength > 1 MB`, chunks are dropped with a running count,
 * and once back to normal a «пропущено N байт» marker is written to the
 * body. For a viewer with a ring buffer, losing the middle is an honest
 * price (without the gate a chatty unit/container inflates Node memory
 * without bound).
 */
const GATE_LIMIT_BYTES = 1024 * 1024;

export interface ChunkWriter {
  (chunk: string): void;
  /**
   * Marker for bytes dropped all the way to the end of the stream (new
   * chunks will not bring them back). The route calls it on settle of
   * `handle.code`, otherwise the user never learns about the loss.
   */
  finish(): void;
}

/**
 * Returns a chunk-writing function for the response that drops on socket
 * overflow and writes a «пропущено N байт» marker once back to normal.
 * The `finish()` method closes with the marker a stream that ended in the
 * dropped state.
 */
export function createChunkGate(res: ServerResponse): ChunkWriter {
  let dropped = 0;
  const writeMarker = (): void => {
    if (dropped > 0 && !res.destroyed) {
      res.write(`\n… (пропущено ${dropped} байт: сервер занят)\n`);
      dropped = 0;
    }
  };
  const write = (chunk: string): void => {
    if (res.destroyed) return;
    if (res.writableLength > GATE_LIMIT_BYTES) {
      dropped += chunk.length;
      return;
    }
    writeMarker();
    res.write(chunk);
  };
  (write as ChunkWriter).finish = writeMarker;
  return write as ChunkWriter;
}
