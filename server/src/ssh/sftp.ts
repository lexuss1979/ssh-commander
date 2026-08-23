import type { SFTPWrapper, Stats } from 'ssh2';

export interface SftpEntry {
  filename: string;
  longname: string;
  attrs: Stats;
}

function toError(err: Error | undefined, fallback: string): Error {
  return err ?? new Error(fallback);
}

export function readdir(sftp: SFTPWrapper, location: string): Promise<SftpEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(location, (err, list) => {
      if (err) reject(toError(err, 'readdir failed'));
      else resolve(list ?? []);
    });
  });
}

export function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(toError(err, 'stat failed'));
      else resolve(stats);
    });
  });
}

export function readFile(sftp: SFTPWrapper, path: string, encoding: 'utf8'): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, encoding, (err, data) => {
      if (err) reject(toError(err, 'read failed'));
      else resolve(String(data));
    });
  });
}

/**
 * Читает диапазон байт [start, end] (включительно) через read stream —
 * сниф заголовка файла без вытаскивания всего содержимого.
 */
export function readRange(sftp: SFTPWrapper, path: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path, { start, end });
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('error', (err: Error | undefined) => reject(toError(err, 'read failed')));
    stream.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

export function writeFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => {
      if (err) reject(toError(err, 'write failed'));
      else resolve();
    });
  });
}

export function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) reject(toError(err, 'mkdir failed'));
      else resolve();
    });
  });
}

export function rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => {
      if (err) reject(toError(err, 'rmdir failed'));
      else resolve();
    });
  });
}

export function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) reject(toError(err, 'unlink failed'));
      else resolve();
    });
  });
}

export function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) reject(toError(err, 'rename failed'));
      else resolve();
    });
  });
}

export function chmod(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, (err) => {
      if (err) reject(toError(err, 'chmod failed'));
      else resolve();
    });
  });
}

