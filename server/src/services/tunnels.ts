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

// Диапазон портов для автоподбора и ограничений.
// Переопределяется через env TUNNEL_PORT_MIN/MAX (для Docker-развёртывания).
const PORT_MIN = Number(process.env.TUNNEL_PORT_MIN) || 10000;
const PORT_MAX = Number(process.env.TUNNEL_PORT_MAX) || 10049;
const MAX_TUNNELS_PER_PROFILE = 10;
const MAX_CONNECTIONS_PER_TUNNEL = 10;

// Валидация диапазона при старте.
if (PORT_MIN > PORT_MAX) {
  throw new Error(`TUNNEL_PORT_MIN (${PORT_MIN}) > TUNNEL_PORT_MAX (${PORT_MAX})`);
}

export function getPortRange(): { min: number; max: number } {
  return { min: PORT_MIN, max: PORT_MAX };
}

/**
 * Валидация параметров туннеля. Чистая функция — удобна для unit-тестов.
 * Бросает Error с понятным сообщением при невалидных данных.
 */
export function validateTunnelParams(params: TunnelParams, existingTunnels?: Tunnel[]): void {
  const { localPort, targetHost, targetPort, profileId } = params;

  // Локальный порт: 0 (авто) или диапазон 1–65535.
  if (localPort !== 0 && (localPort < 1 || localPort > 65535)) {
    throw new Error(`Недопустимый локальный порт: ${localPort}`);
  }
  // Ограничение диапазона для локального запуска (Docker-диапазон задаётся env).
  if (localPort !== 0 && (localPort < PORT_MIN || localPort > PORT_MAX)) {
    throw new Error(`Локальный порт вне диапазона ${PORT_MIN}–${PORT_MAX}`);
  }

  // Целевой порт: 1–65535.
  if (targetPort < 1 || targetPort > 65535) {
    throw new Error(`Недопустимый целевой порт: ${targetPort}`);
  }

  // Целевой хост: hostname/IP до 253 символов, только безопасные символы.
  if (!targetHost || targetHost.length > 253) {
    throw new Error('Недопустимый целевой хост');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(targetHost)) {
    throw new Error('Целевой хост содержит недопустимые символы');
  }

  // Лимит туннелей на профиль (считаем только active).
  const profileTunnels = existingTunnels?.filter((t) => t.profileId === profileId && t.status === 'active') ?? [];
  if (profileTunnels.length >= MAX_TUNNELS_PER_PROFILE) {
    throw new Error(`Превышен лимит туннелей на профиль (${MAX_TUNNELS_PER_PROFILE})`);
  }

  // Дубликат (profileId, localPort).
  const duplicate = existingTunnels?.find(
    (t) => t.profileId === profileId && t.localPort === localPort && t.status === 'active',
  );
  if (duplicate) {
    throw new Error(`Туннель на порту ${localPort} уже существует`);
  }
}

/**
 * Создаёт SSH-туннель (эквивалент `ssh -L`). Слушает 127.0.0.1:localPort,
 * на каждое TCP-соединение открывает direct-tcpip канал через SSH к targetHost:targetPort.
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
    // EADDRINUSE при ручном указании занятого порта.
    // Туннель остаётся в реестре со статусом closed и ошибкой — UI покажет
    // кнопку «Удалить» (пользователь может удалить и создать заново).
    tunnel.status = 'closed';
    tunnel.error = err.message;
    // Не удаляем из реестра — пусть UI увидит closed-статус.
  });

  // Добавляем в реестр ДО listen, чтобы при ошибке listen (EADDRINUSE)
  // туннель уже был в реестре со статусом closed.
  tunnels.set(id, tunnel);

  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(localPort, '127.0.0.1', () => resolve());
      server.once('error', (err) => reject(err));
    });
  } catch (err) {
    // listen failed — туннель уже в реестре со статусом closed (обработчик error выше).
    // Пробрасываем ошибку, чтобы роут вернул 409/500.
    throw err;
  }

  return toPublicTunnel(tunnel);
}

async function handleConnection(tunnel: TunnelInternal, socket: net.Socket): Promise<void> {
  // Резервируем слот сразу (до await), чтобы параллельные соединения не пробили лимит.
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

    // Двусторонний pipe.
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
    // Ошибка открытия канала (AllowTcpForwarding no, хост недоступен и т.д.).
    tunnel.activeConnections.delete(socket);
    try {
      socket.destroy();
    } catch {
      /* noop */
    }
    // Логируем в консоль, но не закрываем туннель — это ошибка конкретного соединения.
    console.error(`Tunnel ${tunnel.id} connection error:`, (err as Error).message);
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
    server.listen(port, '127.0.0.1');
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

  // Закрываем все активные соединения.
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

  // Закрываем сервер.
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
