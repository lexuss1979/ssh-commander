import express, { Router } from 'express';
import { exec, getSftp, withSftp } from '../ssh/manager.js';
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
