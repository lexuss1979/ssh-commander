import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AgentAskMode, Profile, TerminalTab } from '../types';
import { fetchTerminalHistory, fetchTerminalSessions } from '../api';

// Лимит до сверки с сервером (сервер отдаёт фактический в /api/terminal/sessions).
const TERMINAL_LIMIT_DEFAULT = 4;

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'closed' | 'error';

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

interface TerminalViewProps {
  profile: Profile;
  tab: TerminalTab;
  /** Внутренняя вкладка активна (переключение вкладок терминала). */
  active: boolean;
  /** Вкладка «Терминал» приложения видима (возврат с других вкладок). */
  visible: boolean;
  showError: (msg: string) => void;
  /** «Спросить агента»: передать контекст терминала AI-агенту. */
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
  /** Флаг «вкладку закрыл пользователь» (✕): cleanup шлёт серверу close-фрейм,
   * сессия умирает явно. На прочих unmount'ах (смена профиля, «Обновить
   * сессию») фрейм не шлётся — сессию держит grace 60 с. */
  closeOnUnmountRef: { current: boolean };
  /** Статус WS/shell — точка в заголовке вкладки. */
  onStatus: (key: string, status: TerminalStatus) => void;
}

/** Идентификатор вкладки на клиенте — пара (tabId, container), как и ключ
 * серверной сессии: два браузера с независимыми счётчиками tabId могут
 * дать одинаковый номер host-вкладке и контейнерной — id одного номера
 * недостаточно (коллизия React-ключей). */
export function terminalTabKey(tab: TerminalTab): string {
  return `${tab.id}:${tab.container?.id ?? 'host'}`;
}

function TerminalView({
  profile,
  tab,
  active,
  visible,
  showError,
  onAskAgent,
  closeOnUnmountRef,
  onStatus,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [sessionKey, setSessionKey] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Есть ли выделение в xterm — включает пункты меню «В чат».
  const [hasSelection, setHasSelection] = useState(false);
  const [askMenuOpen, setAskMenuOpen] = useState(false);
  const askMenuRef = useRef<HTMLDivElement>(null);
  const containerId = tab.container?.id ?? '';

  // Статус — вверх, в точку заголовка вкладки.
  useEffect(() => {
    onStatus(terminalTabKey(tab), status);
  }, [tab, status, onStatus]);

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
      tabId: String(tab.id),
    });
    if (containerId) {
      wsParams.set('container', containerId);
      wsParams.set('containerName', tab.container?.name ?? '');
    }
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
      // close-фрейм — только явное закрытие вкладки пользователем: смена
      // профиля размонтирует страницу, и безусловная отправка убивала бы все
      // терминалы вместо grace (вернулся в течение 60 с — тот же shell).
      if (closeOnUnmountRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'close' }));
      }
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sendInputRef.current = () => {};
    };
  }, [profile.id, sessionKey, showError, containerId, tab.id, closeOnUnmountRef]);

  // При display:none xterm теряет размеры — пересчитываем, когда вкладка
  // терминалов видима и внутренняя вкладка активна (оба случая скрытия).
  useEffect(() => {
    if (!visible || !active) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* контейнер ещё скрыт */
    }
    termRef.current?.focus();
  }, [visible, active]);

  return (
    <div className={`terminal-view${active ? '' : ' hidden'}`}>
      <div className="toolbar">
        <span className="muted">
          {profile.name} — {profile.username}@{profile.host}
        </span>
        {tab.container && (
          <span className="container-chip">контейнер: {tab.container.name}</span>
        )}
        <span className={`status-dot ${status}`} />
        <span className="status-text">
          {status === 'connected' && 'подключено'}
          {status === 'connecting' && 'подключение…'}
          {status === 'disconnected' && 'отключено'}
          {status === 'closed' && 'сессия завершена'}
          {status === 'error' && 'ошибка'}
        </span>
        {!tab.container && (
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
      {historyOpen && !tab.container && (
        <HistoryPalette profileId={profile.id} onPick={pickHistory} onClose={closeHistory} />
      )}
    </div>
  );
}

// ---------- Вкладки терминалов (эпик 15) ----------

interface TabsState {
  tabs: TerminalTab[];
  /** Монотонный счётчик id — вкладка сохраняет id на всю жизнь. */
  nextId: number;
  /** Ключ активной вкладки — terminalTabKey (пара id+container). */
  activeId: string | null;
}

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** Одноразовый запрос «терминал в контейнер» из Docker Explorer:
   * TerminalPage добавляет/активирует вкладку контейнера и сбрасывает
   * запрос через onOpenContainerConsumed (паттерн sqlInsert). */
  openContainerRequest: { containerId: string; name: string } | null;
  onOpenContainerConsumed: () => void;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const tabsStorageKey = (profileId: string) => `sc-terminal-tabs:${profileId}`;

const DEFAULT_TABS: TabsState = { tabs: [{ id: 0 }], nextId: 1, activeId: '0:host' };

/** Разбор сохранённых вкладок: мусорные элементы отбрасываются, дубли
 * числовых id — тоже: свои записи дубликатов не пишут (nextId монотонный),
 * а возможную после сверки с сервером пару «host N + контейнер N» при
 * следующем F5 сверка же и доукомплектует из живых сессий. */
function parseStoredTabs(raw: string | null): TabsState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { tabs, nextId, activeId } = parsed as {
      tabs?: unknown;
      nextId?: unknown;
      activeId?: unknown;
    };
    if (!Array.isArray(tabs)) return null;
    const valid: TerminalTab[] = [];
    const seen = new Set<number>();
    for (const item of tabs) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, container } = item as { id?: unknown; container?: unknown };
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || seen.has(id)) continue;
      let tab: TerminalTab | null = null;
      if (container === undefined) {
        tab = { id };
      } else if (
        typeof container === 'object' &&
        container !== null &&
        typeof (container as { id?: unknown }).id === 'string' &&
        typeof (container as { name?: unknown }).name === 'string'
      ) {
        tab = { id, container: container as { id: string; name: string } };
      }
      if (!tab) continue;
      seen.add(id);
      valid.push(tab);
    }
    if (valid.length === 0) return null;
    const maxId = valid.reduce((m, t) => Math.max(m, t.id), 0);
    const storedNext = typeof nextId === 'number' && Number.isInteger(nextId) ? nextId : 0;
    const active =
      typeof activeId === 'string' && valid.some((t) => terminalTabKey(t) === activeId)
        ? activeId
        : terminalTabKey(valid[0]);
    return { tabs: valid, nextId: Math.max(maxId + 1, storedNext), activeId: active };
  } catch {
    return null;
  }
}

function loadTabsState(profileId: string): TabsState {
  try {
    return parseStoredTabs(localStorage.getItem(tabsStorageKey(profileId))) ?? DEFAULT_TABS;
  } catch {
    /* localStorage может быть недоступен */
    return DEFAULT_TABS;
  }
}

export function TerminalPage({
  profile,
  showError,
  visible,
  openContainerRequest,
  onOpenContainerConsumed,
  onAskAgent,
}: Props) {
  const [tabsState, setTabsState] = useState<TabsState>(() => loadTabsState(profile.id));
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [limit, setLimit] = useState(TERMINAL_LIMIT_DEFAULT);
  // Флаги «вкладку закрыл пользователь»: TerminalView читает ref в cleanup
  // и решает, слать ли close-фрейм (unmount по другой причине — grace).
  const closeFlags = useRef(new Map<string, { current: boolean }>());

  // Вкладки переживают F5: пишем при каждом изменении.
  useEffect(() => {
    try {
      localStorage.setItem(tabsStorageKey(profile.id), JSON.stringify(tabsState));
    } catch {
      /* localStorage может быть недоступен */
    }
  }, [profile.id, tabsState]);

  const getCloseFlag = useCallback((key: string) => {
    let flag = closeFlags.current.get(key);
    if (!flag) {
      flag = { current: false };
      closeFlags.current.set(key, flag);
    }
    return flag;
  }, []);

  const handleStatus = useCallback((key: string, status: TerminalStatus) => {
    setStatuses((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
  }, []);

  // Сверка с сервером при монтировании: живые сессии, которых нет среди
  // вкладок (чистка localStorage, другой браузер), возвращаются вкладками;
  // переполнение режет локальные вкладки без серверной сессии.
  useEffect(() => {
    let cancelled = false;
    fetchTerminalSessions(profile.id)
      .then(({ sessions, limit: serverLimit }) => {
        if (cancelled) return;
        setLimit(serverLimit);
        setTabsState((prev) => {
          const isServerBacked = (t: TerminalTab) =>
            sessions.some(
              (s) => s.tabId === t.id && (s.container ?? null) === (t.container?.id ?? null),
            );
          const added: TerminalTab[] = [];
          for (const s of sessions) {
            const dup = prev.tabs.some(
              (t) => t.id === s.tabId && (t.container?.id ?? null) === s.container,
            );
            if (dup) continue;
            added.push({
              id: s.tabId,
              container: s.container
                ? { id: s.container, name: s.containerName ?? s.container }
                : undefined,
            });
          }
          const tabs = [...prev.tabs, ...added];
          while (tabs.length > serverLimit && tabs.some((t) => !isServerBacked(t))) {
            for (let i = tabs.length - 1; i >= 0; i--) {
              if (!isServerBacked(tabs[i])) {
                tabs.splice(i, 1);
                break;
              }
            }
          }
          const nextId = sessions.reduce((m, s) => Math.max(m, s.tabId + 1), prev.nextId);
          const lastKey = tabs.length ? terminalTabKey(tabs[tabs.length - 1]) : null;
          const activeId = tabs.some((t) => terminalTabKey(t) === prev.activeId)
            ? prev.activeId
            : lastKey;
          return { tabs, nextId, activeId };
        });
      })
      .catch(() => {
        /* Сервер недоступен — остаёмся на вкладках из localStorage. */
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id]);

  // «Терминал в контейнер» из Docker Explorer: существующая вкладка
  // активируется, новой контейнерной вкладке не страшен предел (сервер
  // останется защитой — ошибка придёт в терминал).
  useEffect(() => {
    if (!openContainerRequest) return;
    const { containerId, name } = openContainerRequest;
    onOpenContainerConsumed();
    setTabsState((prev) => {
      const existing = prev.tabs.find((t) => t.container?.id === containerId);
      if (existing) return { ...prev, activeId: terminalTabKey(existing) };
      const id = prev.nextId;
      return {
        tabs: [...prev.tabs, { id, container: { id: containerId, name } }],
        nextId: id + 1,
        activeId: `${id}:${containerId}`,
      };
    });
  }, [openContainerRequest, onOpenContainerConsumed]);

  const addTab = () => {
    setTabsState((prev) => {
      if (prev.tabs.length >= limit) return prev;
      const id = prev.nextId;
      return { tabs: [...prev.tabs, { id }], nextId: id + 1, activeId: `${id}:host` };
    });
  };

  const activateTab = (key: string) => {
    setTabsState((prev) => (prev.activeId === key ? prev : { ...prev, activeId: key }));
  };

  const closeTab = (key: string) => {
    // Флаг выставляется ДО удаления из стейта: cleanup TerminalView при
    // unmount увидит его и пошлёт close-фрейм — destroy, grace не занимается.
    getCloseFlag(key).current = true;
    closeFlags.current.delete(key);
    setStatuses((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setTabsState((prev) => {
      const tabs = prev.tabs.filter((t) => terminalTabKey(t) !== key);
      const lastKey = tabs.length ? terminalTabKey(tabs[tabs.length - 1]) : null;
      const activeId = prev.activeId === key ? lastKey : prev.activeId;
      return { ...prev, tabs, activeId };
    });
  };

  const { tabs, activeId } = tabsState;

  return (
    <div className="page terminal-page">
      {tabs.length > 0 && (
        <div className="terminal-tabs">
          {tabs.map((t) => {
            const key = terminalTabKey(t);
            return (
              <button
                key={key}
                type="button"
                className={`tab terminal-tab${key === activeId ? ' active' : ''}`}
                onClick={() => activateTab(key)}
                title={t.container ? t.container.id : `Терминал ${t.id + 1}`}
              >
                <span className={`status-dot ${statuses[key] ?? 'connecting'}`} />
                <span className="terminal-tab-label">
                  {t.container ? t.container.name : `shell ${t.id + 1}`}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="terminal-tab-close"
                  title="Закрыть вкладку (сессия завершается)"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(key);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      closeTab(key);
                    }
                  }}
                >
                  ✕
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className="terminal-tab-add"
            onClick={addTab}
            disabled={tabs.length >= limit}
            title={
              tabs.length >= limit
                ? `Максимум ${limit} терминала на сервер — закройте другие вкладки`
                : 'Новый терминал'
            }
          >
            +
          </button>
        </div>
      )}
      {tabs.length === 0 ? (
        <div className="empty-state">
          <p>Все терминалы закрыты.</p>
          <button className="btn btn-primary" onClick={addTab}>
            Открыть терминал
          </button>
        </div>
      ) : (
        tabs.map((t) => (
          <TerminalView
            key={terminalTabKey(t)}
            profile={profile}
            tab={t}
            active={terminalTabKey(t) === activeId}
            visible={visible}
            showError={showError}
            onAskAgent={onAskAgent}
            closeOnUnmountRef={getCloseFlag(terminalTabKey(t))}
            onStatus={handleStatus}
          />
        ))
      )}
    </div>
  );
}
