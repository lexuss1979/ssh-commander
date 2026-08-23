import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appendChunk, lastNChars, type LogBufferState } from '../log-buffer';

const MAX_LINES = 5000;
// Флеш буфера в стейт интервалом, а не на каждый чанк — батчинг против
// ререндера на каждый кусок стрима.
const FLUSH_MS = 250;
// Контекст для «В чат»: хвост отфильтрованного буфера до 4 КБ.
const ASK_TAIL_CHARS = 4096;
// Ручной скролл дальше от дна выключает автоскролл, возврат к дну — включает.
const AUTOSCROLL_THRESHOLD_PX = 40;

type Status = 'loading' | 'live' | 'stopped' | 'error';

interface Props {
  /** Заголовок источника (для сноски, если не задан logPath). */
  title: string;
  /** URL стрима; вызывающий стабилизирует useCallback, иначе identity
   * пропа будет перезапускать стрим. */
  buildUrl: (follow: boolean) => string;
  visible: boolean;
  onAskAgent?: (text: string) => void;
  /** Слот для дополнительных контролов тулбара (например «★ Закрепить»). */
  toolbarExtra?: ReactNode;
  /** Путь файла для сообщения «В чат» — агент знает, что смотрит пользователь. */
  logPath?: string;
  serverName?: string;
}

export function LogViewer({ title, buildUrl, visible, onAskAgent, toolbarExtra, logPath, serverName }: Props) {
  const [follow, setFollow] = useState(true);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  // Неполная хвостовая строка без \n: её видно сразу, а не после следующего
  // чанка — иначе пустой лог и пометка об обрезке (обе без \n) терялись бы.
  const [pendingLine, setPendingLine] = useState('');
  const bufferRef = useRef<LogBufferState>({ lines: [], pending: '' });
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Вкладка скрыта (keep-alive) — стрим на паузе; возврат перезапускает
    // его с чистым буфером. Рестарт (смена follow, retry) — тоже с чистым.
    if (!visible) return;
    const controller = new AbortController();
    bufferRef.current = { lines: [], pending: '' };
    setLines([]);
    setPendingLine('');
    setStatus('loading');
    setError('');
    let cancelled = false;
    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      setLines(bufferRef.current.lines);
      setPendingLine(bufferRef.current.pending);
    };
    const flushTimer = window.setInterval(flush, FLUSH_MS);

    void fetch(buildUrl(follow), { credentials: 'same-origin', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          let message = res.statusText;
          try {
            message = (await res.json()).error ?? message;
          } catch {
            /* noop */
          }
          throw new Error(message);
        }
        setStatus('live');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = bufferRef.current;
          bufferRef.current = appendChunk(buf.lines, buf.pending, decoder.decode(value, { stream: true }), MAX_LINES);
          dirty = true;
        }
        if (!cancelled) {
          // Финальный флеш: продолжения не будет, неполная строка — весь
          // остаток вывода (частый случай у follow=0-снимка).
          dirty = true;
          flush();
          setStatus('stopped');
        }
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        dirty = true;
        flush();
        setStatus('error');
        setError((err as Error).message);
      });

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(flushTimer);
    };
  }, [buildUrl, follow, visible, retry]);

  // Автоскролл после каждого флеша.
  useEffect(() => {
    if (autoscroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines, pendingLine, autoscroll]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_THRESHOLD_PX;
    if (atBottom !== autoscroll) setAutoscroll(atBottom);
  };

  const normalizedFilter = filter.trim().toLowerCase();
  // Отображаемый буфер: полные строки + неполная хвостовая (если матчится
  // фильтру) — фильтр, копирование и «В чат» работают по одному набору.
  const visibleLines = useMemo(() => {
    const withPending =
      pendingLine && (!normalizedFilter || pendingLine.toLowerCase().includes(normalizedFilter))
        ? [...lines, pendingLine]
        : lines;
    if (!normalizedFilter) return withPending;
    return withPending.filter((l) => l.toLowerCase().includes(normalizedFilter));
  }, [lines, pendingLine, normalizedFilter]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visibleLines.join('\n'));
    } catch {
      /* clipboard может быть недоступен */
    }
  };

  // 'send': текст уже собран и не оборачивается в «вывод терминала» — путь
  // файла попадает в сообщение, агент знает, что смотрит пользователь.
  const ask = () => {
    if (!onAskAgent) return;
    const where = logPath ?? title;
    const server = serverName ? ` (сервер ${serverName})` : '';
    onAskAgent(`Объясни этот вывод лога ${where}${server}:\n\`\`\`\n${lastNChars(visibleLines, ASK_TAIL_CHARS)}\n\`\`\``);
  };

  const statusText =
    status === 'stopped'
      ? 'остановлено'
      : status === 'error'
        ? error
        : 'подключено…';

  return (
    <div className="log-viewer">
      <div className="logs-toolbar">
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Следовать
        </label>
        <label className="check">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          Автоскролл
        </label>
        <input
          className="log-filter"
          placeholder="Фильтр (подстрока)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {toolbarExtra}
        <span className={`muted log-status${status === 'error' ? ' log-status-error' : ''}`}>{statusText}</span>
        <button className="btn btn-mini" onClick={() => void copy()}>Скопировать</button>
        {onAskAgent && (
          <button className="btn btn-mini" onClick={ask}>В чат</button>
        )}
        {(status === 'error' || status === 'stopped') && (
          <button className="btn btn-mini" onClick={() => setRetry((r) => r + 1)}>Переподключиться</button>
        )}
      </div>
      <pre className="logs-view" ref={preRef} onScroll={onScroll}>
        {visibleLines.join('\n')}
      </pre>
    </div>
  );
}
