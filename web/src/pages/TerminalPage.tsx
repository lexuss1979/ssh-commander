import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AgentAskMode, Profile, TerminalTab } from '../types';
import { fetchTerminalHistory, fetchTerminalSessions } from '../api';
import { useT } from '../i18n';

// Limit until reconciled with the server (the actual one comes in /api/terminal/sessions).
const TERMINAL_LIMIT_DEFAULT = 4;

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'closed' | 'error';

// Context limits for the "Ask the agent" button (see roadmap, epic 7):
// the last ~30 non-empty lines, at most ~4 KB total.
const ASK_AGENT_MAX_LINES = 30;
const ASK_AGENT_MAX_CHARS = 4096;

// The xterm selection (trimmed to 4 KB keeping the tail, same as in
// collectTerminalContext) — for the "To chat" menu actions that work only
// on a selection.
function collectSelection(term: Terminal): string {
  return term.getSelection().trim().slice(-ASK_AGENT_MAX_CHARS);
}

// The xterm selection if any; otherwise the buffer tail (last non-empty lines).
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

/** POSIX single-quote escaping for a command in the terminal. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface WsMessage {
  type: string;
  data?: string;
  cols?: number;
  rows?: number;
}

interface HistoryPaletteProps {
  profileId: string;
  /** Insert a command into the terminal (no Enter) and close the palette. */
  onPick: (cmd: string) => void;
  onClose: () => void;
}

function HistoryPalette({ profileId, onPick, onClose }: HistoryPaletteProps) {
  const { t } = useT();
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
          setError(err instanceof Error ? err.message : t('terminal.historyLoadFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, t]);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.toLowerCase().includes(q));
  }, [commands, filter]);

  // On a filter change the selection returns to the first row.
  useEffect(() => {
    setSelected(0);
  }, [filter]);

  // The selected row is always within the visible area of the list.
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
        placeholder={t('terminal.historyPlaceholder')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="history-list" ref={listRef}>
        {error && <div className="history-empty">{error}</div>}
        {!error && commands === null && <div className="history-empty">{t('terminal.historyLoading')}</div>}
        {!error && commands !== null && filtered.length === 0 && (
          <div className="history-empty">
            {commands.length === 0 ? t('terminal.historyEmpty') : t('terminal.historyNoMatches')}
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
  /** The inner tab is active (switching terminal tabs). */
  active: boolean;
  /** The app's "Terminal" tab is visible (returning from other tabs). */
  visible: boolean;
  showError: (msg: string) => void;
  /** "Ask the agent": pass the terminal context to the AI agent. */
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
  /** The "tab closed by the user" flag (✕): the cleanup sends the server a
   * close frame and the session dies explicitly. On other unmounts (profile
   * change, "Restart session") the frame is not sent — the session is kept
   * by the 60 s grace. */
  closeOnUnmountRef: { current: boolean };
  /** WS/shell status — the dot in the tab header. */
  onStatus: (key: string, status: TerminalStatus) => void;
  /** One-shot `cd`s for "Open in terminal" tabs (keyed by terminalTabKey). */
  pendingCwdRef: React.MutableRefObject<Map<string, string>>;
}

/** Client-side tab identifier — the (tabId, container) pair, same as the
 * server session key: two browsers with independent tabId counters can give
 * the same number to a host tab and a container tab — a single number is
 * not enough (a React key collision). */
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
  pendingCwdRef,
}: TerminalViewProps) {
  const { t } = useT();
  // t for the WS effect goes through a ref: t in deps would tear down the WebSocket on a language change.
  const tRef = useRef(t);
  tRef.current = t;
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [sessionKey, setSessionKey] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Whether there is a selection in xterm — enables the "To chat" menu items.
  const [hasSelection, setHasSelection] = useState(false);
  const [askMenuOpen, setAskMenuOpen] = useState(false);
  const askMenuRef = useRef<HTMLDivElement>(null);
  const containerId = tab.container?.id ?? '';

  // Status goes up, into the tab header dot.
  useEffect(() => {
    onStatus(terminalTabKey(tab), status);
  }, [tab, status, onStatus]);

  // In a container session the system shell history makes no sense.
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
    // The command goes as ordinary input, without Enter — execution is up to the user.
    sendInputRef.current(cmd);
    closeHistory();
  };

  // "Ask the agent": take the selection or the buffer tail and pass it up (App).
  // In container mode the button stays available: container output is also
  // useful context for the agent (it works on the host, but can explain it).
  const askAgent = () => {
    const term = termRef.current;
    if (!term || !onAskAgent) return;
    const text = collectTerminalContext(term);
    if (!text) {
      showError(t('terminal.bufferEmpty'));
      return;
    }
    term.clearSelection();
    onAskAgent(text);
  };

  // "To chat" menu actions — strictly on a selection (no buffer-tail fallback):
  // 'new-dialogue' — a new dialogue with the selection as the first message,
  // 'prefill' — insert into the current dialogue's input without sending.
  const sendSelectionToChat = (mode: 'new-dialogue' | 'prefill') => {
    const term = termRef.current;
    if (!term || !onAskAgent) return;
    const text = collectSelection(term);
    if (!text) {
      showError(t('terminal.needSelection'));
      return;
    }
    term.clearSelection();
    setAskMenuOpen(false);
    onAskAgent(text, mode);
  };

  // The "To chat" menu: closes on an outside click and on Escape.
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

    // Ctrl+R — the history palette instead of reverse-i-search in readline.
    // false = the event does not reach xterm, ordinary input keeps working.
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

    // The "To chat" menu items are active only with a selection — tracked live.
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
        if (msg.type === 'connected') {
          setStatus('connected');
          // "Open in terminal": run the cd into the directory once.
          const cwd = pendingCwdRef.current.get(terminalTabKey(tab));
          if (cwd) {
            pendingCwdRef.current.delete(terminalTabKey(tab));
            send({ type: 'input', data: `cd ${shq(cwd)}\r` });
          }
        }
        if (msg.type === 'close') {
          setStatus('closed');
          term.write(`\r\n\x1b[31m${tRef.current('terminal.sessionClosedMark')}\x1b[0m\r\n`);
        }
        if (msg.type === 'error') {
          setStatus('error');
          term.write(`\r\n\x1b[31m${msg.data ?? tRef.current('terminal.connectError')}\x1b[0m\r\n`);
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
      // The close frame — only for an explicit tab close by the user: a
      // profile change unmounts the page, and an unconditional send would
      // kill all terminals instead of grace (back within 60 s — the same
      // shell).
      if (closeOnUnmountRef.current) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'close' }));
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          // The session is created on the server at upgrade time, while the
          // client's OPEN comes later: closing a fresh tab must deliver the
          // close over a not-yet-open socket too, otherwise the slot sits in
          // grace.
          ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'close' }));
            ws.close();
          });
        } else {
          ws.close();
        }
      } else {
        ws.close();
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sendInputRef.current = () => {};
    };
  }, [profile.id, sessionKey, showError, containerId, tab.id, tab, pendingCwdRef, closeOnUnmountRef]);

  // With display:none xterm loses its size — recompute when the terminal tab
  // is visible and the inner tab is active (both hiding cases).
  useEffect(() => {
    if (!visible || !active) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* the container is still hidden */
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
          <span className="container-chip">{t('terminal.containerChip', { name: tab.container.name })}</span>
        )}
        <span className={`status-dot ${status}`} />
        <span className="status-text">
          {status === 'connected' && t('terminal.statusConnected')}
          {status === 'connecting' && t('terminal.statusConnecting')}
          {status === 'disconnected' && t('terminal.statusDisconnected')}
          {status === 'closed' && t('terminal.statusClosed')}
          {status === 'error' && t('terminal.statusError')}
        </span>
        {!tab.container && (
          <button className="btn btn-ghost" onClick={openHistory} title="Ctrl+R">
            {t('terminal.historyButton')}
          </button>
        )}
        {onAskAgent && (
          <button
            className="btn btn-ghost"
            onClick={askAgent}
            title={t('terminal.askAgentTitle')}
          >
            {t('terminal.askAgent')}
          </button>
        )}
        {onAskAgent && (
          <div className="terminal-ask" ref={askMenuRef}>
            <button
              className={`btn btn-ghost ${askMenuOpen ? 'open' : ''}`}
              onClick={() => setAskMenuOpen((o) => !o)}
              title={t('terminal.toChatTitle')}
            >
              {t('terminal.toChat')}
            </button>
            {askMenuOpen && (
              <div className="terminal-ask-menu">
                <button
                  className="terminal-ask-item"
                  disabled={!hasSelection}
                  title={
                    hasSelection
                      ? t('terminal.newChatTitle')
                      : t('terminal.needSelection')
                  }
                  onClick={() => sendSelectionToChat('new-dialogue')}
                >
                  {t('terminal.openInNewChat')}
                </button>
                <button
                  className="terminal-ask-item"
                  disabled={!hasSelection}
                  title={
                    hasSelection
                      ? t('terminal.addToChatTitle')
                      : t('terminal.needSelection')
                  }
                  onClick={() => sendSelectionToChat('prefill')}
                >
                  {t('terminal.addToChat')}
                </button>
              </div>
            )}
          </div>
        )}
        <button
          className="btn btn-ghost"
          title={t('terminal.restartSessionTitle')}
          onClick={() => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              // Soft restart: the server will close the SSH channel and open
              // a new shell; the terminal buffer is kept.
              setStatus('connecting');
              ws.send(JSON.stringify({ type: 'restart' }));
            } else {
              // The WS is dead (session closed/error) — a full terminal remount.
              setSessionKey((k) => k + 1);
              setStatus('connecting');
            }
          }}
        >
          {t('terminal.restartSession')}
        </button>
      </div>
      {/* The palette lives inside terminal-container: anchored to the
          terminal area (position: relative), not to the tab strip/toolbar
          with a fixed offset that drifts as the toolbar grows. */}
      <div className="terminal-container" ref={containerRef}>
        {historyOpen && !tab.container && (
          <HistoryPalette profileId={profile.id} onPick={pickHistory} onClose={closeHistory} />
        )}
      </div>
    </div>
  );
}

// ---------- Terminal tabs (epic 15) ----------

interface TabsState {
  tabs: TerminalTab[];
  /** Monotonic id counter — a tab keeps its id for life. */
  nextId: number;
  /** The active tab key — terminalTabKey (the id+container pair). */
  activeId: string | null;
}

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** One-shot "open a container terminal" request from Docker Explorer:
   * TerminalPage adds/activates the container tab and resets the request via
   * onOpenContainerConsumed (the sqlInsert pattern). */
  openContainerRequest: { containerId: string; name: string } | null;
  onOpenContainerConsumed: () => void;
  /** One-shot "Open in terminal (cd <path>)" request from the file manager. */
  openInTerminalRequest: { cwd: string } | null;
  onOpenInTerminalConsumed: () => void;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const tabsStorageKey = (profileId: string) => `sc-terminal-tabs:${profileId}`;

const DEFAULT_TABS: TabsState = { tabs: [{ id: 0 }], nextId: 1, activeId: '0:host' };

/** Parsing stored tabs: junk entries are discarded, duplicate numeric ids
 * as well — our own writes never produce duplicates (nextId is monotonic),
 * while a possible "host N + container N" pair left over from the server
 * reconciliation is filled in by that same reconciliation on the next F5
 * from live sessions. */
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
    /* localStorage may be unavailable */
    return DEFAULT_TABS;
  }
}

export function TerminalPage({
  profile,
  showError,
  visible,
  openContainerRequest,
  onOpenContainerConsumed,
  openInTerminalRequest,
  onOpenInTerminalConsumed,
  onAskAgent,
}: Props) {
  const { t } = useT();
  const [tabsState, setTabsState] = useState<TabsState>(() => loadTabsState(profile.id));
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [limit, setLimit] = useState(TERMINAL_LIMIT_DEFAULT);
  // The "tab closed by the user" flags: TerminalView reads the ref in its
  // cleanup and decides whether to send the close frame (an unmount for
  // another reason — grace).
  const closeFlags = useRef(new Map<string, { current: boolean }>());
  // A one-shot `cd` for a new host tab ("Open in terminal"):
  // the key is terminalTabKey; consumed in TerminalView after 'connected'.
  const pendingCwdRef = useRef(new Map<string, string>());

  // Tabs survive F5: written on every change.
  useEffect(() => {
    try {
      localStorage.setItem(tabsStorageKey(profile.id), JSON.stringify(tabsState));
    } catch {
      /* localStorage may be unavailable */
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

  // Reconcile with the server on mount: live sessions missing from the tabs
  // (localStorage cleanup, another browser) come back as tabs; overflow cuts
  // local tabs that have no server session.
  useEffect(() => {
    let cancelled = false;
    fetchTerminalSessions(profile.id)
      .then(({ sessions, limit: serverLimit }) => {
        if (cancelled) return;
        setLimit(serverLimit);
        const trimmed: string[] = [];
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
                // The cut tab may have missed the snapshot (its WS opened
                // after the request) — set the close flag so the cleanup
                // sends the close frame and the slot frees right away,
                // not after the 60 s grace.
                const key = terminalTabKey(tabs[i]);
                getCloseFlag(key).current = true;
                trimmed.push(key);
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
        if (trimmed.length) {
          setStatuses((prev) => {
            const next = { ...prev };
            for (const key of trimmed) delete next[key];
            return next;
          });
        }
      })
      .catch(() => {
        /* The server is unreachable — staying on the localStorage tabs. */
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, getCloseFlag]);

  // "Open a container terminal" from Docker Explorer: an existing tab is
  // activated, a new container tab need not fear the limit (the server
  // remains the guard — an error will arrive in the terminal).
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

  // "Open in terminal" from the file manager: create/activate a new host tab
  // (no container) and remember the cd for a one-time insertion after
  // connecting (see TerminalView on 'connected').
  useEffect(() => {
    if (!openInTerminalRequest) return;
    const { cwd } = openInTerminalRequest;
    onOpenInTerminalConsumed();
    setTabsState((prev) => {
      const id = prev.nextId;
      pendingCwdRef.current.set(`${id}:host`, cwd);
      return {
        tabs: [...prev.tabs, { id }],
        nextId: id + 1,
        activeId: `${id}:host`,
      };
    });
  }, [openInTerminalRequest, onOpenInTerminalConsumed]);

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
    // The flag is set BEFORE removing from state: the TerminalView cleanup
    // on unmount will see it and send the close frame — a destroy, no grace.
    // The closeFlags entry is not removed: the flag object must outlive the
    // unmount of the View with the same identity (a prop in the WS effect
    // deps) — tab keys never repeat (nextId is monotonic), a negligible map
    // growth is acceptable.
    getCloseFlag(key).current = true;
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
          {tabs.map((tab) => {
            const key = terminalTabKey(tab);
            return (
              <div key={key} className={`tab terminal-tab${key === activeId ? ' active' : ''}`}>
                <button
                  type="button"
                  className="terminal-tab-main"
                  onClick={() => activateTab(key)}
                  title={tab.container ? tab.container.id : t('terminal.tabTitle', { n: tab.id + 1 })}
                >
                  <span className={`status-dot ${statuses[key] ?? 'connecting'}`} />
                  <span className="terminal-tab-label">
                    {tab.container ? tab.container.name : t('terminal.shellLabel', { n: tab.id + 1 })}
                  </span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  title={t('terminal.closeTabTitle')}
                  onClick={() => closeTab(key)}
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="terminal-tab-add"
            onClick={addTab}
            disabled={tabs.length >= limit}
            title={
              tabs.length >= limit
                ? t('terminal.limitTitle', { limit })
                : t('terminal.newTabTitle')
            }
          >
            +
          </button>
        </div>
      )}
      {tabs.length === 0 ? (
        <div className="empty-state">
          <p>{t('terminal.allClosed')}</p>
          <button className="btn btn-primary" onClick={addTab}>
            {t('terminal.openTerminal')}
          </button>
        </div>
      ) : (
        tabs.map((tab) => (
          <TerminalView
            key={terminalTabKey(tab)}
            profile={profile}
            tab={tab}
            active={terminalTabKey(tab) === activeId}
            visible={visible}
            showError={showError}
            onAskAgent={onAskAgent}
            closeOnUnmountRef={getCloseFlag(terminalTabKey(tab))}
            onStatus={handleStatus}
            pendingCwdRef={pendingCwdRef}
          />
        ))
      )}
    </div>
  );
}
