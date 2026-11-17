import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execRawChannel: vi.fn(),
  withSftp: vi.fn(),
}));

vi.mock('../src/profiles.js', () => ({ requireProfile: () => ({ id: 'upload-p1' }) }));
vi.mock('../src/ssh/manager.js', () => ({
  exec: vi.fn(),
  execRawChannel: mocks.execRawChannel,
  execStream: vi.fn(),
  getSftp: vi.fn(),
  withSftp: mocks.withSftp,
}));

const express = (await import('express')).default;
const { filesRouter } = await import('../src/routes/files.js');

let server: Server;
let base = '';
let sink: Writable;
let receivedBytes = 0;
let receivedChunks = 0;

class FakeUploadChannel extends Writable {
  stderr = new EventEmitter();
  archiveBytes = 0;

  constructor() {
    super({ autoDestroy: false });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.archiveBytes += chunk.length;
    callback();
  }

  override _final(callback: () => void): void {
    callback();
    queueMicrotask(() => this.emit('close', 0));
  }

  close(): void {
    this.destroy();
  }
}

beforeAll(async () => {
  const app = express();
  app.use('/api/files', filesRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/files`;
});

beforeEach(() => {
  receivedBytes = 0;
  receivedChunks = 0;
  sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      receivedChunks++;
      callback();
    },
  });
  mocks.withSftp.mockImplementation(async (_profile, fn) => fn({
    createWriteStream: () => sink,
    stat: (_path: string, cb: (err: null, stats: { mode: number }) => void) => {
      queueMicrotask(() => cb(null, { mode: 0o040755 }));
    },
  }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function sendChunks(path: string, totalBytes: number): Promise<{ status: number; body: string }> {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': totalBytes,
      },
    }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    void (async () => {
      for (let sent = 0; sent < totalBytes;) {
        const part = chunk.subarray(0, Math.min(chunk.length, totalBytes - sent));
        sent += part.length;
        if (!req.write(part)) await new Promise<void>((resolveDrain) => req.once('drain', resolveDrain));
      }
      req.end();
    })().catch(reject);
  });
}

describe('streaming file uploads', () => {
  it('uploads more than the former 200 MiB raw-body limit without buffering the request', async () => {
    const size = 200 * 1024 * 1024 + 1;
    const params = new URLSearchParams({ profileId: 'upload-p1', dir: '/tmp', name: 'large.zip' });
    const response = await sendChunks(`/upload?${params}`, size);
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, path: '/tmp/large.zip' });
    expect(receivedBytes).toBe(size);
    expect(receivedChunks).toBeGreaterThan(1);
  }, 30000);

  it('destroys the SFTP stream when the client aborts an upload', async () => {
    const params = new URLSearchParams({ profileId: 'upload-p1', dir: '/tmp', name: 'aborted.zip' });
    const req = http.request(`${base}/upload?${params}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': 3 * 1024 * 1024,
      },
    });
    req.on('error', () => {});
    req.end(Buffer.alloc(1024, 7));
    await vi.waitFor(() => expect(receivedBytes).toBeGreaterThan(0));
    req.destroy();
    await vi.waitFor(() => expect(sink.destroyed).toBe(true));
  });

  it('pipes a tar.gz request into the remote extraction channel', async () => {
    const channel = new FakeUploadChannel();
    mocks.execRawChannel.mockResolvedValue(channel);
    const params = new URLSearchParams({ profileId: 'upload-p1', path: '/tmp' });
    const response = await sendChunks(`/upload-dir?${params}`, 3 * 1024 * 1024);
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(channel.archiveBytes).toBe(3 * 1024 * 1024);
  });
});
