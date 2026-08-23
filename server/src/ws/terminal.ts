import type { WebSocket } from 'ws';
import { openShell, closeProfileConnection, type ShellSession } from '../ssh/manager.js';
import { dockerCommand } from '../services/docker.js';
import type { Profile } from '../types.js';

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * Лимит живых терминальных сессий на профиль (суммарно системных и
 * контейнерных). Бюджет SSH-каналов: OpenSSH MaxSessions по умолчанию 10,
 * из них постоянные потребители — SFTP (1) + follow-стримы (до 3, общий
 * лимитер эпика 14); 4 терминала оставляют транзитным exec'ам запас 2.
 */
export const MAX_TERMINAL_SESSIONS_PER_PROFILE = 4;

/** Запись о живой терминальной сессии для `GET /api/terminal/sessions`. */
export interface TerminalSessionInfo {
  tabId: number;
  container: string | null;
  containerName: string | null;
}

class TerminalSession {
  private shell: ShellSession | null = null;
  private attachments = new Set<WebSocket>();
  private destroyTimer: NodeJS.Timeout | null = null;
  private pendingInput: string[] = [];
  private spawning = false;
  private restartQueued = false;

  constructor(
    private sessionKey: string,
    private profile: Profile,
    private cols: number,
    private rows: number,
    private tabId: number,
    private container?: string,
    private containerName?: string | null,
  ) {}

  /** Живая ли сессия: shell держит SSH-канал или канал открывается. */
  isAlive(): boolean {
    return this.shell !== null || this.spawning;
  }

  get profileId(): string {
    return this.profile.id;
  }

  info(): TerminalSessionInfo {
    return {
      tabId: this.tabId,
      container: this.container ?? null,
      containerName: this.containerName ?? null,
    };
  }

  private broadcast(data: WsMessage): void {
    const payload = JSON.stringify(data);
    for (const ws of this.attachments) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  private async spawn(): Promise<void> {
    if (this.shell || this.spawning) return;
    this.spawning = true;
    try {
      const shell = await openShell(this.profile, this.cols, this.rows);
      if (this.shell || this.restartQueued) {
        // A newer spawn or a restart won while we were connecting: drop this
        // shell — its connection is being replaced anyway.
        shell.destroy();
        return;
      }
      this.shell = shell;
      shell.channel.on('data', (d: Buffer) => this.broadcast({ type: 'output', data: d.toString() }));
      shell.channel.on('close', () => {
        if (this.shell !== shell) return;
        if (this.destroyTimer) {
          clearTimeout(this.destroyTimer);
          this.destroyTimer = null;
        }
        this.shell = null;
        this.broadcast({ type: 'close' });
        this.cleanupAttachments();
        // Выход из shell закрывает SSH-канал — реанимировать нечего, grace не
        // нужен. Запись убирается из реестра сразу: с ключом по вкладке мапа
        // иначе копит призраки на каждый `exit`, и они всплывают в
        // /api/terminal/sessions. Клиент по close-фрейму переподключается тем
        // же tabId и получает свежую запись.
        sessions.delete(this.sessionKey);
      });
      shell.channel.on('error', () => {
        /* close follows */
      });
      if (this.container) {
        // Контейнерная сессия: `exec` заменяет логин-shell на docker exec,
        // поэтому выход из контейнера закрывает канал и сессию.
        // bash предпочтителен, sh — запасной вариант (alpine и т.п.).
        const cmd = dockerCommand(this.profile, [
          'exec', '-it', this.container, 'sh', '-c', 'exec bash || exec sh',
        ]);
        shell.write(`exec ${cmd}\n`);
      }
      if (this.pendingInput.length) {
        for (const chunk of this.pendingInput.splice(0)) {
          shell.write(chunk);
        }
      }
      this.broadcast({ type: 'connected' });
    } catch (err) {
      if (this.restartQueued) {
        // The connection was closed intentionally while connecting; the
        // queued respawn will open a fresh one.
        return;
      }
      this.pendingInput = [];
      this.broadcast({ type: 'error', data: String((err as Error).message ?? err) });
      this.shell = null;
      this.cleanupAttachments();
    } finally {
      this.spawning = false;
      if (this.restartQueued) {
        this.restartQueued = false;
        void this.spawn();
      }
    }
  }

  /**
   * Re-establishes the SSH session: closes the current shell and the whole
   * SSH connection, then opens a new shell. A fresh login picks up new group
   * memberships and permissions (e.g. a user just added to a group).
   */
  restart(): void {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    this.pendingInput = [];
    this.broadcast({
      type: 'output',
      data: '\r\n\x1b[33m[переподключение SSH-сессии — применяются новые группы и права]\x1b[0m\r\n',
    });
    if (this.spawning) {
      this.restartQueued = true;
      closeProfileConnection(this.profile.id);
      return;
    }
    const old = this.shell;
    this.shell = null;
    old?.destroy();
    closeProfileConnection(this.profile.id);
    void this.spawn();
  }

  attach(ws: WebSocket, cols?: number, rows?: number): void {
    this.attachments.add(ws);
    if (cols && rows) {
      this.cols = cols;
      this.rows = rows;
    }
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    if (!this.shell) {
      void this.spawn();
    } else {
      this.shell.resize(this.cols, this.rows);
      this.broadcast({ type: 'connected' });
    }
  }

  detach(ws: WebSocket): void {
    this.attachments.delete(ws);
    if (this.attachments.size === 0 && this.shell) {
      // Keep the shell alive briefly so a page reload can reattach.
      this.destroyTimer = setTimeout(() => this.destroy(), 60_000);
    }
  }

  input(data: string): void {
    if (!data) return;
    if (this.shell) {
      this.shell.write(data);
    } else {
      const queued = this.pendingInput.join('');
      if (queued.length + data.length <= 64 * 1024) {
        this.pendingInput.push(data);
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    this.shell?.resize(cols, rows);
  }

  destroy(): void {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
    this.shell?.destroy();
    this.shell = null;
    this.cleanupAttachments();
    sessions.delete(this.sessionKey);
  }

  private cleanupAttachments(): void {
    for (const ws of this.attachments) {
      ws.close(1011, 'Terminal session closed');
    }
    this.attachments.clear();
  }
}

const sessions = new Map<string, TerminalSession>();

// Системный shell и shell контейнера — разные сессии, ключ включает container
// и tabId вкладки (эпик 15): `${profileId}::${container|host}::${tabId}`.
export function sessionKey(profileId: string, container?: string, tabId = 0): string {
  return `${profileId}::${container ?? 'host'}::${tabId}`;
}

/**
 * Разбор tabId из query. Отсутствие параметра — 0 (бесшовный деплой: вкладка
 * старого клиента без tabId продолжает работать с единственной сессией
 * `…::host::0`). Невалидное значение (не целое, вне 0..9999) — null → отказ.
 */
export function parseTabId(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

/** Живые записи профиля: grace-сессии (shell жив) считаются, записи после
 * exit/ошибки spawn — нет (канал освобождён или не открывался). */
function countAliveSessions(profileId: string): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.profileId === profileId && session.isAlive()) count++;
  }
  return count;
}

/** Живые терминальные сессии профиля — восстановление вкладок после F5. */
export function listTerminalSessions(profileId: string): TerminalSessionInfo[] {
  const result: TerminalSessionInfo[] = [];
  for (const session of sessions.values()) {
    if (!session.isAlive()) continue;
    if (session.profileId !== profileId) continue;
    result.push(session.info());
  }
  return result;
}

export function attachTerminal(
  ws: WebSocket,
  profile: Profile,
  cols: number,
  rows: number,
  container?: string,
  tabIdParam?: string | null,
  containerName?: string | null,
): void {
  const tabId = parseTabId(tabIdParam ?? null);
  if (tabId === null) {
    ws.close(1008, 'Invalid tabId');
    return;
  }
  const key = sessionKey(profile.id, container, tabId);
  let session = sessions.get(key);
  if (!session) {
    // Лимит считают только живые записи — они держат SSH-канал. Существующая
    // сессия (переподключение вкладки) проверку не проходит повторно.
    if (countAliveSessions(profile.id) >= MAX_TERMINAL_SESSIONS_PER_PROFILE) {
      ws.send(
        JSON.stringify({
          type: 'error',
          data: `Слишком много терминалов (максимум ${MAX_TERMINAL_SESSIONS_PER_PROFILE}) — закройте другие вкладки`,
        }),
      );
      ws.close(1013, 'Too many terminals');
      return;
    }
    session = new TerminalSession(
      key,
      profile,
      cols || 80,
      rows || 24,
      tabId,
      container,
      // containerName — только отображение (заголовок вкладки после F5), в
      // ключ и shell-команду не попадает.
      containerName ? containerName.slice(0, 200) : null,
    );
    sessions.set(key, session);
  }
  session.attach(ws, cols, rows);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as WsMessage;
      switch (msg.type) {
        case 'input':
          session?.input(msg.data ?? '');
          break;
        case 'resize':
          session?.resize(Number(msg.cols) || 80, Number(msg.rows) || 24);
          break;
        case 'close':
          session?.destroy();
          break;
        case 'restart':
          session?.restart();
          break;
      }
    } catch {
      /* ignore malformed frames */
    }
  });

  ws.on('close', () => {
    session?.detach(ws);
  });
}
