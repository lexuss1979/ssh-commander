import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Profile } from '../types';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
}

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

export function TerminalPage({ profile, showError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('connecting');
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Consolas, "JetBrains Mono", monospace',
      theme: {
        background: '#0f1419',
        foreground: '#d8dee9',
        cursor: '#88c0d0',
        selectionBackground: '#3b4252',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    let closed = false;
    const ws = new WebSocket(
      `/ws/terminal?profileId=${encodeURIComponent(profile.id)}&cols=${term.cols}&rows=${term.rows}`,
    );
    wsRef.current = ws;

    const send = (msg: WsMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    term.onData((data) => send({ type: 'input', data }));
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

    ws.onopen = () => {
      if (!closed) {
        setStatus('connected');
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      }
    };
    ws.onmessage = (e) => {
      if (closed) return;
      try {
        const msg = JSON.parse(e.data) as WsMessage;
        if (msg.type === 'output' && msg.data) term.write(msg.data);
        if (msg.type === 'connected') setStatus('connected');
        if (msg.type === 'close') {
          setStatus('closed');
          term.write('\r\n\x1b[31m[сессия завершена]\x1b[0m\r\n');
        }
        if (msg.type === 'error') {
          setStatus('error');
          term.write(`\r\n\x1b[31m${msg.data ?? 'Ошибка подключения'}\x1b[0m\r\n`);
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setStatus((s) => (s === 'connected' ? 'disconnected' : s));
    };

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        /* container hidden */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      closed = true;
      wsRef.current = null;
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [profile.id, showError]);

  return (
    <div className="page terminal-page">
      <div className="toolbar">
        <span className="muted">
          {profile.name} — {profile.username}@{profile.host}
        </span>
        <span className={`status-dot ${status}`} />
        <span className="status-text">
          {status === 'connected' && 'подключено'}
          {status === 'connecting' && 'подключение…'}
          {status === 'disconnected' && 'отключено'}
          {status === 'closed' && 'сессия завершена'}
          {status === 'error' && 'ошибка'}
        </span>
        <button
          className="btn btn-ghost"
          title="Переустановить SSH-подключение (применить новые группы и права)"
          onClick={() => {
            setStatus('connecting');
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'restart' }));
            }
          }}
        >
          Обновить сессию
        </button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}
