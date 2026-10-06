import net from 'node:net';
import type { Channel, Client } from 'ssh2';
import type { Profile } from '../types.js';
import { getClient } from '../ssh/manager.js';

export interface TunnelParams {
  profileId: string;
  localPort: number; // 0 = auto-select
  targetHost: string;
  targetPort: number;
}

export interface Tunnel {
  id: string;
  profileId: string;
  localHost: '127.0.0.1';
  localPort: number;
  targetHost: string;
  targetPort: number;
  status: 'active' | 'closed';
  error?: string;
  createdAt: number;
}

interface TunnelInternal extends Tunnel {
  server: net.Server;
  profile: Profile;
  activeConnections: Set<net.Socket | Channel>;
}

const tunnels = new Map<string, TunnelInternal>();
let nextId = 1;

// Port range for auto-selection and limits.
// Overridden via the TUNNEL_PORT_MIN/MAX env (for the Docker deployment).
const PORT_MIN = Number(process.env.TUNNEL_PORT_MIN) || 10000;
const PORT_MAX = Number(process.env.TUNNEL_PORT_MAX) || 10049;
const MAX_TUNNELS_PER_PROFILE = 10;
const MAX_CONNECTIONS_PER_TUNNEL = 10;

// Range validation at startup.
if (PORT_MIN > PORT_MAX) {
  throw new Error(`TUNNEL_PORT_MIN (${PORT_MIN}) > TUNNEL_PORT_MAX (${PORT_MAX})`);
}

export function getPortRange(): { min: number; max: number } {
  return { min: PORT_MIN, max: PORT_MAX };
}

/**
 * Tunnel parameter validation. A pure function — convenient for unit tests.
 * Throws an Error with a clear message on invalid data.
 */
export function validateTunnelParams(params: TunnelParams, existingTunnels?: Tunnel[]): void {
  const { localPort, targetHost, targetPort, profileId } = params;

  // Local port: 0 (auto) or the 1–65535 range.
  if (localPort !== 0 && (localPort < 1 || localPort > 65535)) {
    throw new Error(`Недопустимый локальный порт: ${localPort}`);
  }
  // Range restriction for a local run (the Docker range is set via env).
  if (localPort !== 0 && (localPort < PORT_MIN || localPort > PORT_MAX)) {
    throw new Error(`Локальный порт вне диапазона ${PORT_MIN}–${PORT_MAX}`);
  }

  // Target port: 1–65535.
  if (targetPort < 1 || targetPort > 65535) {
    throw new Error(`Недопустимый целевой порт: ${targetPort}`);
  }

  // Target host: a hostname/IP up to 253 characters, safe characters only.
  if (!targetHost || targetHost.length > 253) {
    throw new Error('Недопустимый целевой хост');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(targetHost)) {
    throw new Error('Целевой хост содержит недопустимые символы');
  }

  // Tunnel limit per profile (only active ones are counted).
  const profileTunnels = existingTunnels?.filter((t) => t.profileId === profileId && t.status === 'active') ?? [];
  if (profileTunnels.length >= MAX_TUNNELS_PER_PROFILE) {
    throw new Error(`Превышен лимит туннелей на профиль (${MAX_TUNNELS_PER_PROFILE})`);
  }

  // A duplicate (profileId, localPort).
  const duplicate = existingTunnels?.find(
    (t) => t.profileId === profileId && t.localPort === localPort && t.status === 'active',
  );
  if (duplicate) {
    throw new Error(`Туннель на порту ${localPort} уже существует`);
  }
}

/**
 * Creates an SSH tunnel (the `ssh -L` equivalent). Listens on
 * 127.0.0.1:localPort; for every TCP connection it opens a direct-tcpip
 * channel via SSH to targetHost:targetPort.
 */
export async function createTunnel(profile: Profile, params: TunnelParams): Promise<Tunnel> {
  const allTunnels = listTunnels();
  validateTunnelParams(params, allTunnels);

  const id = `tun-${nextId++}`;
  const localPort = params.localPort === 0 ? await findFreePort() : params.localPort;

  const server = net.createServer();
  const tunnel: TunnelInternal = {
    id,
    profileId: profile.id,
    localHost: '127.0.0.1',
    localPort,
    targetHost: params.targetHost,
    targetPort: params.targetPort,
    status: 'active',
    createdAt: Date.now(),
    server,
    profile,
    activeConnections: new Set(),
  };

  server.on('connection', (socket) => handleConnection(tunnel, socket));

  server.on('error', (err) => {
    // EADDRINUSE when a busy port is set manually.
    // The tunnel stays in the registry with the closed status and an error —
    // the UI shows the "Delete" button (the user can delete it and create a
    // new one).
    tunnel.status = 'closed';
    tunnel.error = err.message;
    // Not removed from the registry — let the UI see the closed status.
  });

  // Added to the registry BEFORE listen, so that on a listen error
  // (EADDRINUSE) the tunnel is already in the registry with the closed status.
  tunnels.set(id, tunnel);

  try {
    await new Promise<void>((resolve, reject) => {
      // Listening on 0.0.0.0 inside the container so that Docker can forward
      // a connection to this port. On the host Docker restricts access via
      // 127.0.0.1:10000-10049 in compose.yml — the port does not stick out.
      server.listen(localPort, '0.0.0.0', () => resolve());
      server.once('error', (err) => reject(err));
    });
  } catch (err) {
    // listen failed — the tunnel is already in the registry with the closed
    // status (the error handler above). Rethrow so that the route returns
    // 409/500.
    throw err;
  }

  return toPublicTunnel(tunnel);
}

async function handleConnection(tunnel: TunnelInternal, socket: net.Socket): Promise<void> {
  // Reserve the slot immediately (before await), so that parallel connections do not break the limit.
  if (tunnel.activeConnections.size >= MAX_CONNECTIONS_PER_TUNNEL) {
    socket.destroy();
    return;
  }
  tunnel.activeConnections.add(socket);

  let channel: Channel | null = null;
  try {
    const client: Client = await getClient(tunnel.profile);
    channel = await new Promise<Channel>((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, tunnel.targetHost, tunnel.targetPort, (err, ch) => {
        if (err) reject(err);
        else resolve(ch);
      });
    });

    tunnel.activeConnections.add(channel);

    // Two-way pipe.
    socket.pipe(channel);
    channel.pipe(socket);

    const cleanup = () => {
      tunnel.activeConnections.delete(socket);
      if (channel) tunnel.activeConnections.delete(channel);
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      try {
        channel?.close();
      } catch {
        /* noop */
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
    channel.on('close', cleanup);
    channel.on('error', cleanup);
  } catch (err) {
    // Channel open failure (AllowTcpForwarding no, unreachable host, etc.).
    tunnel.activeConnections.delete(socket);
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
  }
}

async function findFreePort(): Promise<number> {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  throw new Error(`Нет свободных портов в диапазоне ${PORT_MIN}–${PORT_MAX}`);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // Check on 0.0.0.0 — the same address the tunnel will listen on.
    server.listen(port, '0.0.0.0');
  });
}

export function listTunnels(): Tunnel[] {
  return Array.from(tunnels.values()).map(toPublicTunnel);
}

export function getTunnel(id: string): Tunnel | null {
  const t = tunnels.get(id);
  return t ? toPublicTunnel(t) : null;
}

export async function deleteTunnel(id: string): Promise<void> {
  const t = tunnels.get(id);
  if (!t) return;

  // Close all active connections.
  for (const conn of t.activeConnections) {
    try {
      if (conn instanceof net.Socket) {
        conn.destroy();
      } else {
        (conn as Channel).close();
      }
    } catch {
      /* noop */
    }
  }
  t.activeConnections.clear();

  // Close the server.
  await new Promise<void>((resolve) => {
    t.server.close(() => resolve());
  });

  t.status = 'closed';
  tunnels.delete(id);
}

function toPublicTunnel(t: TunnelInternal): Tunnel {
  return {
    id: t.id,
    profileId: t.profileId,
    localHost: t.localHost,
    localPort: t.localPort,
    targetHost: t.targetHost,
    targetPort: t.targetPort,
    status: t.status,
    error: t.error,
    createdAt: t.createdAt,
  };
}
