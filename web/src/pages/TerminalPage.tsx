import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AgentAskMode, Profile } from '../types';
import { fetchTerminalHistory } from '../api';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** Контейнерная сессия: shell внутри docker-контейнера вместо системного. */
  container?: { id: string; name: string } | null;
  onExitContainer?: () => void;
  /** «Спросить агента»: передать контекст терминала AI-агенту. */
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

// Лимиты контекста для кнопки «Спросить агента» (см. roadmap, эпик 7):
// последние ~30 непустых строк, суммарно не более ~4 КБ.
const ASK_AGENT_MAX_LINES = 30;
const ASK_AGENT_MAX_CHARS = 4096;

// Выделение xterm (с той же обрезкой до 4 КБ с сохранением хвоста, что и
// в collectTerminalContext) — для действий меню «В чат», работающих только
// на выделении.
function collectSelection(term: Terminal): string {
  return term.getSelection().trim().slice(-ASK_AGENT_MAX_CHARS);
}

// Выделение xterm, если есть; иначе — хвост буфера (последние непустые строки).
function collectTerminalContext(term: Terminal): string {
  const selection = term.getSelection().trim();
  if (selection) return selection.slice(-ASK_AGENT_MAX_CHARS);
  const buf = term.buffer.active;
  const lines: string[] = [];
  let total = 0;
  for (let i = buf.length - 1; i >= 0 && lines.length < ASK_AGENT_MAX_LINES; i--) {
    const text = (buf.getLine(i)?.translateToString(true) ?? '').trimEnd();
    if (!text.trim()) continue;
    total += text.length;
    if (total > ASK_AGENT_MAX_CHARS) break;
    lines.unshift(text);
  }
  return lines.join('\n');
}

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

interface HistoryPaletteProps {
  profileId: string;
  /** Вставить команду в терминал (без Enter) и закрыть палитру. */
  onPick: (cmd: string) => void;
  onClose: () => void;
}

function HistoryPalette({ profileId, onPick, onClose }: HistoryPaletteProps) {
  const [commands, setCommands] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTerminalHistory(profileId)
      .then((cmds) => {
        if (!cancelled) setCommands(cmds);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Не удалось загрузить историю');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.toLowerCase().includes(q));
  }, [commands, filter]);

  // При смене фильтра выбор возвращается на первую строку.
  useEffect(() => {
    setSelected(0);
  }, [filter]);

  // Выбранная строка всегда в видимой области списка.
  useEffect(() => {
    listRef.current
      ?.querySelector('.history-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selected];
      if (cmd) onPick(cmd);
    }
  };

  return (
    <div className="history-palette" onKeyDown={onKeyDown}>
      <input
        className="history-filter"
        autoFocus
        placeholder="Фильтр команд… (↑↓ — выбор, Enter — вставить, Esc — закрыть)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="history-list" ref={listRef}>
        {error && <div className="history-empty">{error}</div>}
        {!error && commands === null && <div className="history-empty">Загрузка истории…</div>}
        {!error && commands !== null && filtered.length === 0 && (
          <div className="history-empty">
            {commands.length === 0 ? 'История команд пуста' : 'Ничего не найдено'}
          </div>
        )}
        {filtered.map((cmd, i) => (
          <button
            key={`${i}:${cmd}`}
            type="button"
            className={`history-item${i === selected ? ' selected' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => onPick(cmd)}
          >
            {cmd}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TerminalPage({ profile, showError, visible, container, onExitContainer, onAskAgent }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('connecting');
  const [sessionKey, setSessionKey] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Есть ли выделение в xterm — включает пункты меню «В чат».
  const [hasSelection, setHasSelection] = useState(false);
  const [askMenuOpen, setAskMenuOpen] = useState(false);
  const askMenuRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const containerId = container?.id ?? '';

  // В контейнерной сессии история системного shell не имеет смысла.
  const openHistory = () => {
    if (containerId) return;
    setHistoryOpen(true);
  };
  const openHistoryRef = useRef(openHistory);
  openHistoryRef.current = openHistory;

  const closeHistory = () => {
    setHistoryOpen(false);
    termRef.current?.focus();
  };

  const pickHistory = (cmd: string) => {
    // Команда уходит как обычный ввод, без Enter — выполнение за пользователем.
    sendInputRef.current(cmd);
    closeHistory();
  };

  // «Спросить агента»: берём выделение или хвост буфера и отдаём наверх (App).
  // В контейнерном режиме кнопка остаётся доступной: вывод контейнера — тоже
  // полезный контекст для агента (он работает с хостом, но объяснить его может).
  const askAgent = () => {
    const term = termRef.current;
    if (!term || !onAskAgent) return;
    const text = collectTerminalContext(term);
    if (!text) {
      showError('Буфер терминала пуст — нечего отправлять агенту');
      return;
    }
    term.clearSelection();
    onAskAgent(text);
  };

  // Действия меню «В чат» — строго на выделении (без фолбэка хвоста буфера):
  // 'new-dialogue' — новый диалог с выделением первым сообщением,
  // 'prefill' — вставка в поле ввода текущего диалога без отправки.
  const sendSelectionToChat = (mode: 'new-dialogue' | 'prefill') => {
    const term = termRef.current;
    if (!term || !onAskAgent) return;
    const text = collectSelection(term);
    if (!text) {
      showError('Сначала выделите текст в терминале');
      return;
    }
    term.clearSelection();
    setAskMenuOpen(false);
    onAskAgent(text, mode);
  };

  // Меню «В чат»: закрывается по клику вне его и по Escape.
  useEffect(() => {
    if (!askMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (askMenuRef.current && !askMenuRef.current.contains(e.target as Node)) {
        setAskMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAskMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [askMenuOpen]);

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
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    // Ctrl+R — палитра истории вместо reverse-i-search в readline.
    // false = событие не уходит в xterm, обычный ввод не ломается.
    term.attachCustomKeyEventHandler((ev) => {
      if (
        ev.type === 'keydown' &&
        ev.ctrlKey &&
        !ev.altKey &&
        !ev.shiftKey &&
        !ev.metaKey &&
        ev.key.toLowerCase() === 'r'
      ) {
        openHistoryRef.current();
        return false;
      }
      return true;
    });

    let closed = false;
    const wsParams = new URLSearchParams({
      profileId: profile.id,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    if (containerId) wsParams.set('container', containerId);
    const ws = new WebSocket(`/ws/terminal?${wsParams}`);
    wsRef.current = ws;

    const send = (msg: WsMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    sendInputRef.current = (data) => send({ type: 'input', data });

    term.onData((data) => send({ type: 'input', data }));

    // Пункты меню «В чат» активны только при выделении — трекаем его live.
    term.onSelectionChange(() => setHasSelection(term.hasSelection()));

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
      termRef.current = null;
      fitRef.current = null;
      sendInputRef.current = () => {};
    };
  }, [profile.id, sessionKey, showError, containerId]);

  // При display:none xterm теряет размеры — пересчитываем при возврате на вкладку.
  useEffect(() => {
    if (!visible) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* контейнер ещё скрыт */
    }
  }, [visible]);

  return (
    <div className="page terminal-page">
      <div className="toolbar">
        <span className="muted">
          {profile.name} — {profile.username}@{profile.host}
        </span>
        {container && (
          <span className="container-chip">контейнер: {container.name}</span>
        )}
        <span className={`status-dot ${status}`} />
        <span className="status-text">
          {status === 'connected' && 'подключено'}
          {status === 'connecting' && 'подключение…'}
          {status === 'disconnected' && 'отключено'}
          {status === 'closed' && 'сессия завершена'}
          {status === 'error' && 'ошибка'}
        </span>
        {!container && (
          <button className="btn btn-ghost" onClick={openHistory} title="Ctrl+R">
            История
          </button>
        )}
        {onAskAgent && (
          <button
            className="btn btn-ghost"
            onClick={askAgent}
            title="Отправить выделение (или последние строки буфера) AI-агенту"
          >
            Спросить агента
          </button>
        )}
        {onAskAgent && (
          <div className="terminal-ask" ref={askMenuRef}>
            <button
              className={`btn btn-ghost ${askMenuOpen ? 'open' : ''}`}
              onClick={() => setAskMenuOpen((o) => !o)}
              title="Действия с выделением терминала в чате агента"
            >
              В чат ▾
            </button>
            {askMenuOpen && (
              <div className="terminal-ask-menu">
                <button
                  className="terminal-ask-item"
                  disabled={!hasSelection}
                  title={
                    hasSelection
                      ? 'Создать новый диалог и отправить выделение первым сообщением'
                      : 'Сначала выделите текст в терминале'
                  }
                  onClick={() => sendSelectionToChat('new-dialogue')}
                >
                  Открыть в новом чате
                </button>
                <button
                  className="terminal-ask-item"
                  disabled={!hasSelection}
                  title={
                    hasSelection
                      ? 'Вставить выделение в поле ввода текущего диалога (без отправки)'
                      : 'Сначала выделите текст в терминале'
                  }
                  onClick={() => sendSelectionToChat('prefill')}
                >
                  Добавить в чат
                </button>
              </div>
            )}
          </div>
        )}
        {container && onExitContainer && (
          <button className="btn btn-ghost" onClick={onExitContainer}>
            Системный shell
          </button>
        )}
        <button
          className="btn btn-ghost"
          title="Переустановить SSH-подключение (применить новые группы и права)"
          onClick={() => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              // Мягкий перезапуск: сервер закроет SSH и откроет новый shell,
              // буфер терминала сохраняется.
              setStatus('connecting');
              ws.send(JSON.stringify({ type: 'restart' }));
            } else {
              // WS мёртв (сессия завершена/ошибка) — полный ремаунт терминала.
              setSessionKey((k) => k + 1);
              setStatus('connecting');
            }
          }}
        >
          Обновить сессию
        </button>
      </div>
      <div className="terminal-container" ref={containerRef} />
      {historyOpen && !container && (
        <HistoryPalette profileId={profile.id} onPick={pickHistory} onClose={closeHistory} />
      )}
    </div>
  );
}
