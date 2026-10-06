import express, { Router } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { exec, execRawChannel, execStream, getSftp, withSftp } from '../ssh/manager.js';
import {
  chmod as sftpChmod,
  mkdir as sftpMkdir,
  readFile as sftpReadFile,
  readdir as sftpReaddir,
  rename as sftpRename,
  rmdir as sftpRmdir,
  stat as sftpStat,
  unlink as sftpUnlink,
  writeFile as sftpWriteFile,
} from '../ssh/sftp.js';
import { requireProfile } from '../profiles.js';
import {
  buildTailFollowCommand,
  buildTailOnceCommand,
  precheckTailable,
  TAIL_DEFAULT_LINES,
  TAIL_MAX_LINES,
  TAIL_ONCE_TIMEOUT_MS,
} from '../services/file-tail.js';
import { createChunkGate } from '../services/chunk-gate.js';
import { acquireFollowSlot, releaseFollowSlot } from '../services/stream-limits.js';
import { searchFiles, SEARCH_MAX_RESULTS } from '../services/file-search.js';
import { buildBatchDownloadCommand, buildTarDownloadCommand, buildTarUploadCommand, tarError } from '../services/transfer.js';
import { assertSafePath, basename, dirname, joinRemotePath, modeToString } from '../util/path.js';
import { shq } from '../util/shell.js';
import type { FileEntry } from '../types.js';

export const filesRouter = Router();

function profileId(req: { query: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const q = String(req.query.profileId ?? '');
  if (q) return q;
  const b = req.body as Record<string, unknown> | undefined;
  return String(b?.profileId ?? '');
}

function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) return '/';
  return trimmed.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

filesRouter.get('/list', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const dir = normalizePath(String(req.query.path ?? '/'));
    const entries = await withSftp(profile, (sftp) => sftpReaddir(sftp, dir));
    const result: FileEntry[] = entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const attrs = e.attrs;
        const isSymlink = (attrs.mode & 0o170000) === 0o120000;
        return {
          name: e.filename,
          path: joinRemotePath(dir, e.filename),
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          isSymlink,
          size: attrs.size ?? 0,
          mtime: attrs.mtime ? attrs.mtime * 1000 : 0,
          mode: modeToString(attrs.mode ?? 0),
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: dir, parent: dir === '/' ? null : dirname(dir), entries: result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.get('/read', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.query.path ?? ''));
    const stat = await withSftp(profile, (sftp) => sftpStat(sftp, path));
    if ((stat.mode & 0o170000) === 0o040000) {
      res.status(400).json({ error: 'Это директория' });
      return;
    }
    if ((stat.size ?? 0) > 1024 * 1024) {
      res.status(413).json({ error: 'Файл больше 1 МБ — скачайте его' });
      return;
    }
    const content = await withSftp(profile, (sftp) => sftpReadFile(sftp, path, 'utf8'));
    res.json({ path, content: String(content) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post('/write', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.body?.path ?? ''));
    const content = String(req.body?.content ?? '');
    const append = Boolean(req.body?.append);
    await withSftp(profile, (sftp) =>
      new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(path, { flags: append ? 'a' : 'w' });
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(content);
      }),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post('/mkdir', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.body?.path ?? ''));
    await withSftp(profile, (sftp) => sftpMkdir(sftp, path));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post('/rename', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const from = normalizePath(String(req.body?.from ?? ''));
    const to = normalizePath(String(req.body?.to ?? ''));
    await withSftp(profile, (sftp) => sftpRename(sftp, from, to));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post('/chmod', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.body?.path ?? ''));
    const mode = Number.parseInt(String(req.body?.mode ?? ''), 8);
    if (!Number.isFinite(mode)) {
      res.status(400).json({ error: 'Некорректный режим' });
      return;
    }
    await withSftp(profile, (sftp) => sftpChmod(sftp, path, mode));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post('/delete', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.body?.path ?? ''));
    const recursive = Boolean(req.body?.recursive);
    if (path === '/') {
      res.status(400).json({ error: 'Нельзя удалить корень' });
      return;
    }
    if (recursive) {
      assertSafePath(path);
      const result = await exec(profile, `rm -rf -- ${shq(path)}`, { timeoutMs: 60000 });
      if (result.code !== 0) {
        res.status(400).json({ error: result.stderr.trim() || 'rm failed' });
        return;
      }
      res.json({ ok: true });
      return;
    }
    await withSftp(profile, async (sftp) => {
      const stat = await sftpStat(sftp, path);
      if ((stat.mode & 0o170000) === 0o040000) {
        await sftpRmdir(sftp, path);
      } else {
        await sftpUnlink(sftp, path);
      }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.get('/download', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = normalizePath(String(req.query.path ?? ''));
    const stat = await withSftp(profile, (sftp) => sftpStat(sftp, path));
    if ((stat.mode & 0o170000) === 0o040000) {
      res.status(400).json({ error: 'Это директория' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size ?? 0));
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(basename(path))}"`);
    const sftp = await getSftp(profile);
    const stream = sftp.createReadStream(path);
    stream.on('error', () => {
      if (!res.headersSent) res.status(400).json({ error: 'Ошибка чтения файла' });
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post(
  '/upload',
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const dir = normalizePath(String(req.query.dir ?? '/'));
    const name = String(req.query.name ?? '');
    if (!name || name.includes('/') || name.includes('\0') || name === '.' || name === '..') {
      res.status(400).json({ error: 'Некорректное имя файла' });
      return;
    }
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: 'Тело запроса должно быть файлом' });
      return;
    }
    const target = joinRemotePath(dir, name);
    await withSftp(profile, (sftp) =>
      new Promise<void>((resolve, reject) => {
        const ws = sftp.createWriteStream(target);
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(body);
      }),
    );
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
  },
);

const searchQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  path: z.string().min(1).default('/'),
  pattern: z.string().min(1, 'Укажите строку поиска'),
  mode: z.enum(['name', 'content']).default('name'),
  glob: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_RESULTS).default(200),
});

filesRouter.get('/search', async (req, res) => {
  try {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры поиска' });
      return;
    }
    const q = parsed.data;
    const profile = requireProfile(q.profileId);
    const results = await searchFiles(profile, {
      path: normalizePath(q.path),
      pattern: q.pattern,
      mode: q.mode,
      glob: q.glob,
      limit: q.limit,
    });
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Output limit of a one-shot tail (matches the exec default — needed to
// detect truncation and mark it honestly in the response body).
const TAIL_OUTPUT_LIMIT = 2 * 1024 * 1024;

const tailQuerySchema = z.object({
  profileId: z.string().min(1, 'Укажите профиль'),
  path: z.string().min(1),
  lines: z.coerce.number().int().min(1).max(TAIL_MAX_LINES).default(TAIL_DEFAULT_LINES),
  follow: z.enum(['0', '1']).default('0'),
});

// Live log viewing: follow=0 — a one-shot tail -n snapshot, follow=1 — a
// chunked tail -F stream (switching the UI tab aborts the request → req close → close()).
filesRouter.get('/tail', async (req, res) => {
  try {
    const parsed = tailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' });
      return;
    }
    const q = parsed.data;
    const profile = requireProfile(q.profileId);
    const path = assertSafePath(normalizePath(q.path));
    // Precheck before flushHeaders: a rejection (missing file, directory,
    // binary) is a regular JSON error — no channel is opened for the tail.
    await precheckTailable(profile, path);

    if (q.follow === '0') {
      const result = await exec(profile, buildTailOnceCommand(path, q.lines), {
        timeoutMs: TAIL_ONCE_TIMEOUT_MS,
        maxOutput: TAIL_OUTPUT_LIMIT,
      });
      if (result.code !== 0) {
        // no permissions, or the path vanished between stat and tail
        res.status(400).json({ error: result.stderr.trim() || `tail завершился с кодом ${result.code}` });
        return;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      let body = result.stdout || '(логов нет)';
      if (result.stdout.length >= TAIL_OUTPUT_LIMIT) {
        body += '\n… (вывод обрезан по лимиту 2 МБ)';
      }
      res.send(body);
      return;
    }

    if (!acquireFollowSlot(profile.id)) {
      res.status(429).json({
        error: 'Достигнут лимит одновременных журналов на сервер — закройте часть просмотрщиков и повторите',
      });
      return;
    }
    // The slot is released on every completion path — req close and settled
    // code (the step-0 guarantee: the promise resolves even on a failure
    // before the channel opens). Idempotent via a flag: otherwise 3 failed
    // connections would lock the streams until a process restart.
    let slotReleased = false;
    const releaseSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        releaseFollowSlot(profile.id);
      }
    };
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    // Backpressure — the shared chunk-gate.ts gate: when the socket
    // overflows, chunks are dropped with a counter and marker (pausing the
    // SSH channel would require exposing the channel through the execStream
    // API — rejected by the plan).
    const write = createChunkGate(res);
    // A synchronous throw while assembling the handle (between acquire and
    // req.on('close')) would keep the slot occupied until a restart — headers
    // are already sent, so the failure goes out in the body and the slot is
    // released by the catch.
    try {
      const handle = execStream(profile, buildTailFollowCommand(path, q.lines), (chunk) => {
        write(chunk);
      });
      void handle.code.then(() => {
        // The stream ended in the drop state — emit the loss marker, otherwise
        // the user never learns about skipped bytes.
        write.finish();
        if (!res.writableEnded) res.end();
        releaseSlot();
      });
      req.on('close', () => {
        releaseSlot();
        handle.close();
      });
    } catch (err) {
      releaseSlot();
      res.end(`${String((err as Error).message ?? err)}\n`);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: (err as Error).message });
    } else {
      res.end();
    }
  }
});

filesRouter.get('/download-dir', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = assertSafePath(normalizePath(String(req.query.path ?? '')));
    // Check BEFORE the body starts streaming: the path exists and is a directory.
    const stat = await withSftp(profile, (sftp) => sftpStat(sftp, path));
    if ((stat.mode & 0o170000) !== 0o040000) {
      res.status(400).json({ error: 'Это не директория' });
      return;
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(basename(path))}.tar.gz"`,
    );
    const channel = await execRawChannel(profile, buildTarDownloadCommand(path));
    let stderr = '';
    channel.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString();
    });
    // end: false — we finish the response ourselves on 'close': if tar failed
    // before the first stdout byte (e.g. tar not installed), we still get to
    // return a JSON error.
    channel.pipe(res, { end: false });
    channel.on('close', (code: number | null) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: tarError(stderr, code) });
        return;
      }
      res.end();
    });
    channel.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка SSH-канала' });
      else res.end();
    });
    req.on('close', () => {
      try {
        channel.close();
      } catch {
        /* noop */
      }
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Batch-download several files/folders from the current directory as one tar.gz.
filesRouter.post('/download-batch', async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const dirPath = assertSafePath(normalizePath(String((req.body as Record<string, unknown>)?.path ?? '')));
    const names = (req.body as Record<string, unknown>)?.names;
    if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
      res.status(400).json({ error: 'names must be a non-empty array of strings' });
      return;
    }
    // Validate each name: a safe path without separators.
    for (const n of names) assertSafePath(n);
    const stat = await withSftp(profile, (sftp) => sftpStat(sftp, dirPath));
    if ((stat.mode & 0o170000) !== 0o040000) {
      res.status(400).json({ error: 'Это не директория' });
      return;
    }
    const archiveName = names.length === 1 ? `${names[0]}.tar.gz` : `selected-${names.length}.tar.gz`;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(archiveName)}"`,
    );
    const channel = await execRawChannel(profile, buildBatchDownloadCommand(dirPath, names));
    let stderr = '';
    channel.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString();
    });
    channel.pipe(res, { end: false });
    channel.on('close', (code: number | null) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: tarError(stderr, code) });
        return;
      }
      res.end();
    });
    channel.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка SSH-канала' });
      else res.end();
    });
    req.on('close', () => {
      try {
        channel.close();
      } catch {
        /* noop */
      }
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

filesRouter.post(
  '/upload-dir',
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req, res) => {
  try {
    const profile = requireProfile(profileId(req));
    const path = assertSafePath(normalizePath(String(req.query.path ?? '')));
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Тело запроса должно быть архивом tar.gz' });
      return;
    }
    const stat = await withSftp(profile, (sftp) => sftpStat(sftp, path));
    if ((stat.mode & 0o170000) !== 0o040000) {
      res.status(400).json({ error: 'Целевой путь — не директория' });
      return;
    }
    const channel = await execRawChannel(profile, buildTarUploadCommand(path));
    let stderr = '';
    channel.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString();
    });
    req.on('close', () => {
      try {
        channel.close();
      } catch {
        /* noop */
      }
    });
    const code = await new Promise<number | null>((resolve) => {
      channel.on('close', (c: number | null) => resolve(c));
      channel.on('error', () => resolve(null));
      // Readable.pipe provides backpressure and closes stdin when the body ends.
      Readable.from(body).pipe(channel);
    });
    if (code !== 0) {
      res.status(500).json({ error: tarError(stderr, code) });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
  },
);
