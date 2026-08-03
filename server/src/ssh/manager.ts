import fs from 'node:fs';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import type { ExecResult, Profile } from '../types.js';

interface Connection {
  client: Client;
  profileId: string;
  sftpPromise: Promise<SFTPWrapper> | null;
}

const connections = new Map<string, Connection>();

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

  const client = new Client();
  const conn: Connection = { client, profileId: profile.id, sftpPromise: null };
  connections.set(key, conn);

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', (err) => reject(new Error(`SSH error: ${err.message}`)));
    client.connect(connectOptions(profile));
  });

  client.on('close', () => {
    if (connections.get(key) === conn) {
      connections.delete(key);
    }
  });
  client.on('error', () => {
    // The close event follows; just clean up quietly.
  });

  return client;
}

export async function exec(
  profile: Profile,
  command: string,
  opts: { timeoutMs?: number; maxOutput?: number } = {},
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
  const handle: ExecStreamHandle = {
    code: Promise.resolve(null),
    close: () => undefined,
  };

  getClient(profile)
    .then((client) => {
      client.exec(command, (err, channel) => {
        if (err) {
          onChunk(`SSH exec error: ${err.message}\n`, true);
          return;
        }
        handle.close = () => {
          try {
            channel.close();
          } catch {
            /* noop */
          }
        };
        channel.on('data', (d: Buffer) => onChunk(d.toString(), false));
        channel.stderr.on('data', (d: Buffer) => onChunk(d.toString(), true));
        handle.code = new Promise<number | null>((resolve) => {
          channel.on('close', (exitCode: number | null) => resolve(exitCode));
        });
        channel.on('error', () => {
          /* handled by close */
        });
      });
    })
    .catch((e) => onChunk(`${String(e.message ?? e)}\n`, true));

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
          resize: (c, r) => channel.setWindow(r, c, r, c),
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
