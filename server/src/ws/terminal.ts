import type { WebSocket } from 'ws';
import { openShell, type ShellSession } from '../ssh/manager.js';
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
    if (this.shell) return;
    try {
      const shell = await openShell(this.profile, this.cols, this.rows);
      this.shell = shell;
      shell.channel.on('data', (d: Buffer) => this.broadcast({ type: 'output', data: d.toString() }));
      shell.channel.on('close', () => {
        this.broadcast({ type: 'close' });
        this.shell = null;
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
      this.pendingInput = [];
      this.broadcast({ type: 'error', data: String((err as Error).message ?? err) });
      this.shell = null;
      this.cleanupAttachments();
    }
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
      }
    } catch {
      /* ignore malformed frames */
    }
  });

  ws.on('close', () => {
    session?.detach(ws);
  });
}
