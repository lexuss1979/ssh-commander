import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import type { ExecResult, Profile } from '../types.js';

interface Connection {
  client: Client;
  profileId: string;
  sftpPromise: Promise<SFTPWrapper> | null;
}

const connections = new Map<string, Connection>();
// In-flight connect() promises, so parallel getClient() calls share one
// connection attempt instead of racing into two clients.
const pending = new Map<string, Promise<Connection>>();

function connKey(profileId: string): string {
  return profileId;
}

function connectOptions(profile: Profile) {
  const opts: Record<string, unknown> = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  };
  if (profile.authType === 'key' && profile.keyPath) {
    opts.privateKey = fs.readFileSync(profile.keyPath);
    if (profile.keyPassphrase) {
      opts.passphrase = profile.keyPassphrase;
    }
  } else {
    opts.password = profile.password ?? '';
  }
  return opts;
}

export async function getClient(profile: Profile): Promise<Client> {
  const key = connKey(profile.id);
  const existing = connections.get(key);
  if (existing) {
    return existing.client;
  }

  let promise = pending.get(key);
  if (!promise) {
    promise = connect(key, profile).finally(() => {
      if (pending.get(key) === promise) {
        pending.delete(key);
      }
    });
    pending.set(key, promise);
  }
  return (await promise).client;
}

function connect(key: string, profile: Profile): Promise<Connection> {
  const client = new Client();
  const conn: Connection = { client, profileId: profile.id, sftpPromise: null };

  // Handlers are attached before connect(): on failure the client is closed
  // and never lands in `connections`; on success `close` drops the cached
  // entry so the next call reconnects (existing auto-reconnect behaviour).
  client.on('close', () => {
    if (connections.get(key) === conn) {
      connections.delete(key);
    }
  });
  client.on('error', () => {
    // The close event follows; just clean up quietly.
  });

  return new Promise<Connection>((resolve, reject) => {
    client.once('ready', () => {
      connections.set(key, conn);
      resolve(conn);
    });
    client.once('error', (err) => {
      try {
        client.end();
      } catch {
        /* noop */
      }
      reject(new Error(`SSH error: ${err.message}`));
    });
    client.connect(connectOptions(profile));
  });
}

export async function exec(
  profile: Profile,
  command: string,
  opts: { timeoutMs?: number; maxOutput?: number; stdin?: string } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const maxOutput = opts.maxOutput ?? 2 * 1024 * 1024;
  const client = await getClient(profile);

  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        reject(new Error(`SSH exec error: ${err.message}`));
        return;
      }
      // stdin (например пароль для `sudo -S`): пишем в канал и шлём EOF.
      // Пароль в строку команды не попадает — не виден в ps и логах.
      if (opts.stdin !== undefined) {
        channel.write(opts.stdin);
        channel.end();
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      let code: number | null = null;

      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          channel.close();
        } catch {
          /* noop */
        }
        if (error) {
          reject(error);
        } else {
          resolve({ code, stdout, stderr });
        }
      };

      const timer = setTimeout(() => {
        finish(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      channel.on('data', (d: Buffer) => {
        if (stdout.length < maxOutput) stdout += d.toString();
      });
      channel.stderr.on('data', (d: Buffer) => {
        if (stderr.length < maxOutput) stderr += d.toString();
      });
      channel.on('close', (exitCode: number | null) => {
        code = exitCode;
        finish();
      });
      channel.on('error', (e: Error) => finish(e));
    });
  });
}

export interface ExecStreamHandle {
  code: Promise<number | null>;
  close(): void;
}

/**
 * Run a command and stream stdout chunks. Useful for `docker logs -f`.
 */
export function execStream(
  profile: Profile,
  command: string,
  onChunk: (chunk: string, isStderr: boolean) => void,
): ExecStreamHandle {
  let channel: ClientChannel | null = null;
  let closed = false;
  // Промис создаётся сразу и resolve-функция зовётся на всех терминальных
  // путях: потребитель читает handle.code синхронно после вызова, и присвоение
  // свойства позже (внутри асинхронного колбэка exec) он бы уже не увидел —
  // оставался бы навсегда зарезолвленный заглушкой промис.
  let resolveCode!: (code: number | null) => void;
  const handle: ExecStreamHandle = {
    code: new Promise<number | null>((resolve) => {
      resolveCode = resolve;
    }),
    close: () => {
      closed = true;
      if (channel) {
        try {
          channel.close();
        } catch {
          /* noop */
        }
      }
    },
  };

  getClient(profile)
    .then((client) => {
      client.exec(command, (err, ch) => {
        if (err) {
          onChunk(`SSH exec error: ${err.message}\n`, true);
          resolveCode(null);
          return;
        }
        // close() may have been called while exec() was in flight; kill the
        // channel right away instead of leaking the remote process.
        if (closed) {
          try {
            ch.close();
          } catch {
            /* noop */
          }
          resolveCode(null);
          return;
        }
        channel = ch;
        // StringDecoder, не toString() по буферу: многобайтовый UTF-8 символ,
        // разрезанный границей чанков, иначе превращается в � (замена).
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        channel.on('data', (d: Buffer) => onChunk(outDecoder.write(d), false));
        channel.stderr.on('data', (d: Buffer) => onChunk(errDecoder.write(d), true));
        ch.on('close', (exitCode: number | null) => resolveCode(exitCode));
        channel.on('error', () => {
          // close обычно следует за error, но не полагаемся на это.
          resolveCode(null);
        });
      });
    })
    .catch((e) => {
      onChunk(`${String(e.message ?? e)}\n`, true);
      resolveCode(null);
    });

  return handle;
}

export interface ShellSession {
  channel: ClientChannel;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  destroy(): void;
}

export async function openShell(
  profile: Profile,
  cols: number,
  rows: number,
): Promise<ShellSession> {
  const client = await getClient(profile);
  return new Promise<ShellSession>((resolve, reject) => {
    client.shell(
      { cols, rows, term: 'xterm-256color' },
      (err, channel) => {
        if (err) {
          reject(new Error(`SSH shell error: ${err.message}`));
          return;
        }
        resolve({
          channel,
          write: (data) => channel.write(data),
          resize: (c, r) => channel.setWindow(r, c, 0, 0),
          destroy: () => {
            try {
              channel.close();
            } catch {
              /* noop */
            }
          },
        });
      },
    );
  });
}

export async function getSftp(profile: Profile): Promise<SFTPWrapper> {
  const client = await getClient(profile);
  const key = connKey(profile.id);
  const conn = connections.get(key);
  if (!conn) {
    throw new Error('Connection lost');
  }
  if (!conn.sftpPromise) {
    conn.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP error: ${err.message}`));
          return;
        }
        resolve(sftp);
      });
    });
  }
  return conn.sftpPromise;
}

export async function withSftp<T>(
  profile: Profile,
  fn: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  const sf = await getSftp(profile);
  return fn(sf);
}

/**
 * Open a raw exec channel: the caller reads stdout via 'data', writes to
 * stdin, collects `channel.stderr` and gets the exit code from 'close'.
 * Used for streaming tar archives (download-dir / upload-dir). The caller
 * owns the channel and must close it on abort.
 */
export async function execRawChannel(profile: Profile, command: string): Promise<ClientChannel> {
  const client = await getClient(profile);
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        reject(new Error(`SSH exec error: ${err.message}`));
        return;
      }
      resolve(channel);
    });
  });
}

export function closeProfileConnection(profileId: string): void {
  const key = connKey(profileId);
  const conn = connections.get(key);
  if (conn) {
    connections.delete(key);
    try {
      conn.client.end();
    } catch {
      /* noop */
    }
  }
}

/**
 * One-shot connectivity check for the profile form ("Test connection").
 * Opens a fresh connection — never cached, never registered in `connections` —
 * and closes it right away. Resolves with the server banner (may be empty),
 * rejects with the ssh2 error (auth failure, timeout, unreadable key, ...).
 */
export function testConnection(profile: Profile): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    let banner = '';
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(banner);
    };
    client.on('banner', (msg: string) => {
      banner = msg;
    });
    client.once('ready', () => done());
    client.once('error', (err) => done(err));
    try {
      // Shorter timeout than for cached connections: the user is waiting.
      client.connect({ ...connectOptions(profile), readyTimeout: 10000 });
    } catch (err) {
      // connectOptions throws synchronously, e.g. unreadable key file.
      done(err as Error);
    }
  });
}
