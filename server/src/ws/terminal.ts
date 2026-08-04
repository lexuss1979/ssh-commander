import type { WebSocket } from 'ws';
import { openShell, closeProfileConnection, type ShellSession } from '../ssh/manager.js';
import type { Profile } from '../types.js';

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

class TerminalSession {
  private shell: ShellSession | null = null;
  private attachments = new Set<WebSocket>();
  private destroyTimer: NodeJS.Timeout | null = null;
  private pendingInput: string[] = [];
  private spawning = false;
  private restartQueued = false;

  constructor(
    private profile: Profile,
    private cols: number,
    private rows: number,
  ) {}

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
        this.shell = null;
        this.broadcast({ type: 'close' });
        this.cleanupAttachments();
      });
      shell.channel.on('error', () => {
        /* close follows */
      });
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
    sessions.delete(this.profile.id);
  }

  private cleanupAttachments(): void {
    for (const ws of this.attachments) {
      ws.close(1011, 'Terminal session closed');
    }
    this.attachments.clear();
  }
}

const sessions = new Map<string, TerminalSession>();

export function attachTerminal(
  ws: WebSocket,
  profile: Profile,
  cols: number,
  rows: number,
): void {
  let session = sessions.get(profile.id);
  if (!session) {
    session = new TerminalSession(profile, cols || 80, rows || 24);
    sessions.set(profile.id, session);
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
