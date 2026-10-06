import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { checkHostKey, hostKeyMismatchMessage, type HostKeyCheck } from '../services/known-hosts.js';
import { assertKeyPathAllowed } from '../services/keys.js';
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

/**
 * Rejection reason set by the `hostVerifier` callback. The callback can only
 * return `false` — after that ssh2 reports a generic "handshake failed", so
 * the human-readable text is stored in this holder and swapped in for the
 * promise error.
 */
interface HostKeyRejection {
  message?: string;
  check?: HostKeyCheck;
}

function connectOptions(profile: Profile, rejection: HostKeyRejection = {}) {
  const opts: Record<string, unknown> = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    // Without this callback ssh2 accepts any host key: DNS or route spoofing
    // would silently hand the profile password to a foreign server (TOFU —
    // known fingerprints live in data/known-hosts.json).
    hostVerifier: (key: Buffer) => {
      const check = checkHostKey(profile.host, profile.port, key);
      rejection.check = check;
      if (check.status === 'mismatch') {
        rejection.message = hostKeyMismatchMessage(profile.host, profile.port, check);
        return false;
      }
      return true;
    },
  };
  if (profile.authType === 'key' && profile.keyPath) {
    // Key paths must stay inside KEYS_DIR: otherwise a profile becomes a way
    // to read an arbitrary file on the application host (export already
    // enforces the same restriction).
    opts.privateKey = fs.readFileSync(assertKeyPathAllowed(profile.keyPath));
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
  const rejection: HostKeyRejection = {};

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
      reject(new Error(rejection.message ?? `SSH error: ${err.message}`));
    });
    client.connect(connectOptions(profile, rejection));
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
      // stdin (e.g. a password for `sudo -S`): write to the channel and send
      // EOF. The password never lands in the command line — invisible to ps
      // and logs.
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
 *
 * Transport fixed (epic 13, per the epic 14 plan): `handle.code` is a real
 * promise from the moment the handle exists (not `Promise.resolve(null)`),
 * resolved with the exit code when the channel closes. A route can subscribe
 * before the channel opens — otherwise `res.end()` would fire before the
 * first chunk and the stream would come out empty.
 */
export function execStream(
  profile: Profile,
  command: string,
  onChunk: (chunk: string, isStderr: boolean) => void,
  opts: { stdin?: string } = {},
): ExecStreamHandle {
  let channel: ClientChannel | null = null;
  let closed = false;
  // The promise is created up front and the resolve function is called on
  // every terminal path: the consumer reads handle.code synchronously right
  // after the call, so assigning the property later (inside the async exec
  // callback) would go unseen — it would stay a forever-resolved stub.
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
        // StringDecoder, not buffer.toString(): a multi-byte UTF-8 character
        // split across a chunk boundary would otherwise turn into a
        // replacement char (�).
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        channel.on('data', (d: Buffer) => onChunk(outDecoder.write(d), false));
        channel.stderr.on('data', (d: Buffer) => onChunk(errDecoder.write(d), true));
        // Optional stdin (a password for `sudo -S`): write to the channel and
        // send EOF. The password never lands in the command line — invisible
        // to ps and logs. apt-get -y / dnf -y / apk don't read stdin, so EOF
        // is safe.
        if (opts.stdin !== undefined) {
          ch.write(opts.stdin);
          ch.end();
        }
        ch.on('close', (exitCode: number | null) => resolveCode(exitCode));
        channel.on('error', () => {
          // close usually follows error, but don't rely on that.
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
export interface TestConnectionResult {
  banner: string;
  /** Host key fingerprint (`SHA256:…`) — the user has something to verify against. */
  fingerprint?: string;
  algo?: string;
  /** `new` — first time this host was seen, just remembered. */
  hostKeyStatus?: HostKeyCheck['status'];
}

export function testConnection(profile: Profile): Promise<TestConnectionResult> {
  return new Promise<TestConnectionResult>((resolve, reject) => {
    const client = new Client();
    const rejection: HostKeyRejection = {};
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
      if (err) {
        reject(rejection.message ? new Error(rejection.message) : err);
      } else {
        resolve({
          banner,
          fingerprint: rejection.check?.fingerprint,
          algo: rejection.check?.algo,
          hostKeyStatus: rejection.check?.status,
        });
      }
    };
    client.on('banner', (msg: string) => {
      banner = msg;
    });
    client.once('ready', () => done());
    client.once('error', (err) => done(err));
    try {
      // Shorter timeout than for cached connections: the user is waiting.
      client.connect({ ...connectOptions(profile, rejection), readyTimeout: 10000 });
    } catch (err) {
      // connectOptions throws synchronously, e.g. unreadable key file.
      done(err as Error);
    }
  });
}
