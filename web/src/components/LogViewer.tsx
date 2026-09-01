import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appendChunk, lastNChars, type LogBufferState } from '../log-buffer';
import { useT } from '../i18n';

const MAX_LINES = 5000;
// Флеш буфера в стейт интервалом, а не на каждый чанк — батчинг против
// ререндера на каждый кусок стрима. Интервал общий для обоих режимов и живёт
// вне стрим-эффекта: oneShot-стрим переживает переключение вкладок, и флеш
// не должен умирать вместе с его эффектом.
const FLUSH_MS = 250;
// Контекст для «В чат»: хвост отфильтрованного буфера до 4 КБ.
const ASK_TAIL_CHARS = 4096;
// Ручной скролл дальше от дна выключает автоскролл, возврат к дну — включает.
const AUTOSCROLL_THRESHOLD_PX = 40;

export type LogViewerStatus = 'loading' | 'live' | 'stopped' | 'error';

/**
 * Обычный стрим (tail, journalctl) строится на `buildUrl` (`kind: 'url'`);
 * мутирующий POST-стрим (эпик 19: применение обновлений) — на
 * `buildRequest` + `abortSignal` (`kind: 'request'`, по сути oneShot).
 * Дискриминированное объединение по `kind` делает состояние «не передан ни
 * один» непредставимым (обязательный литерал — дискриминант).
 */
type Props = {
  /** Заголовок источника (для сноски, если не задан logPath). */
  title: string;
  visible: boolean;
  onAskAgent?: (text: string) => void;
  /** Слот для дополнительных контролов тулбара (например «★ Закрепить»). */
  toolbarExtra?: ReactNode;
  /** Путь файла для сообщения «В чат» — агент знает, что смотрит пользователь. */
  logPath?: string;
  serverName?: string;
  /** Терминальное состояние стрима — родителю (нужен ли confirm при закрытии). */
  onStatusChange?: (status: LogViewerStatus) => void;
} & (
  | {
      kind: 'url';
      /** URL стрима; вызывающий стабилизирует useCallback, иначе identity
       * пропа будет перезапускать стрим. */
      buildUrl: (follow: boolean) => string;
    }
  | {
      kind: 'request';
      /**
       * POST-стрим мутации (пароль — в теле запроса, не в URL). Обязательно
       * стабилизировать useCallback с явными зависимостями — смена identity
       * перезапустила бы стрим, то есть повторно выполнила мутацию.
       */
      buildRequest: () => { url: string; init?: RequestInit };
      /**
       * Сигнал прерывания: родитель рвёт стрим при закрытии модалки. Стрим
       * НЕ завязан на `visible` и не рвётся cleanup'ом эффекта — переключение
       * вкладок и StrictMode-перезапуск эффекта не должны убивать идущую
       * мутацию (иначе `apt-get upgrade` обрывался бы при смене вкладки).
       */
      abortSignal: AbortSignal;
    }
);

export function LogViewer(props: Props) {
  const { t } = useT();
  const { title, visible, onAskAgent, toolbarExtra, logPath, serverName, onStatusChange } = props;
  const oneShot = props.kind === 'request';
  const [follow, setFollow] = useState(true);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<LogViewerStatus>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  // Неполная хвостовая строка без \n: её видно сразу, а не после следующего
  // чанка — иначе пустой лог и пометка об обрезке (обе без \n) терялись бы.
  const [pendingLine, setPendingLine] = useState('');
  const bufferRef = useRef<LogBufferState>({ lines: [], pending: '' });
  const dirtyRef = useRef(false);
  const preRef = useRef<HTMLPreElement>(null);
  // oneShot: guard «запуск ровно один на монтирование» — StrictMode в dev
  // монтирует эффекты дважды, без guard'а POST (apt-get upgrade) ушёл бы
  // двумя запросами. Abort в cleanup нет, поэтому первый (живой) fetch
  // переживает двойной вызов; новый монтаж (повторное открытие модалки)
  // получает свежий экземпляр ref.
  const oneShotStartedRef = useRef(false);
  // Подавление setState после размонтирования (в т.ч. StrictMode-перезапуск:
  // эффект с [] переустанавливает флаг в false после двойного вызова).
  const unmountedRef = useRef(false);
  // Метрики скролла прошлого события/эффекта. Клампинг браузера при сжатии
  // контента (фильтр, вытеснение кольцом) прижимает scrollTop к низу без
  // жеста пользователя — его подпись: упали ОБА, scrollHeight и scrollTop.
  // Жест вверх роняет только scrollTop, жест к дну scrollTop растит.
  const lastMetricsRef = useRef({ height: 0, top: 0 });

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Флеш буфера в стейт интервалом (батчинг против ререндера на каждый чанк).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      if (unmountedRef.current) return;
      setLines(bufferRef.current.lines);
      setPendingLine(bufferRef.current.pending);
    }, FLUSH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const flushNow = () => {
    if (unmountedRef.current) return;
    setLines(bufferRef.current.lines);
    setPendingLine(bufferRef.current.pending);
  };

  const finish = (nextStatus: LogViewerStatus, errText = '') => {
    if (unmountedRef.current) return;
    setStatus(nextStatus);
    if (errText) setError(errText);
    onStatusChange?.(nextStatus);
  };

  // Общий цикл стрима: fetch + reader + кольцевой буфер + статусы. Живёт в
  // ref'ах и не привязан к идентичности вызова — оба эффекта зовут его
  // один раз за свой жизненный цикл.
  const runStream = (opts: { url: string; init?: RequestInit; signal: AbortSignal }) => {
    bufferRef.current = { lines: [], pending: '' };
    setLines([]);
    setPendingLine('');
    setStatus('loading');
    setError('');
    void fetch(opts.url, { credentials: 'same-origin', signal: opts.signal, ...(opts.init ?? {}) })
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
        finish('live');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = bufferRef.current;
          bufferRef.current = appendChunk(buf.lines, buf.pending, decoder.decode(value, { stream: true }), MAX_LINES);
          dirtyRef.current = true;
        }
        if (!unmountedRef.current) {
          // Финальный флеш: продолжения не будет, неполная строка — весь
          // остаток вывода (частый случай у follow=0-снимка).
          dirtyRef.current = true;
          flushNow();
          finish('stopped');
        }
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return; // родитель закрыл модалку
        if (unmountedRef.current) return;
        dirtyRef.current = true;
        flushNow();
        finish('error', (err as Error).message);
      });
  };

  // Сужение дискриминированного пропса до конкретных значений: локальные
  // переменные проще для TS в массивах зависимостей, чем доступ через union.
  const buildUrl = props.kind === 'url' ? props.buildUrl : undefined;
  const buildRequest = props.kind === 'request' ? props.buildRequest : undefined;
  const abortSignal = props.kind === 'request' ? props.abortSignal : undefined;

  // Обычные стримы: пауза при скрытой вкладке, рестарт при смене
  // follow/retry/возврате видимости — cleanup рвёт fetch (для follow-стрима
  // перезапуск безвреден).
  useEffect(() => {
    if (!buildUrl) return;
    if (!visible) return;
    const controller = new AbortController();
    runStream({ url: buildUrl(follow), signal: controller.signal });
    return () => controller.abort();
    // runStream намеренно не в зависимостях: он пересоздаётся каждый рендер,
    // а стрим должен жить по своим стабильным пропсам.
  }, [buildUrl, visible, follow, retry]);

  // kind='request' (мутация): старт ровно один раз на монтирование, жизнь
  // стрима НЕ зависит от visible и перезапусков эффекта; прерывание — только
  // по abortSignal родителя (закрытие модалки) или естественному завершению
  // команды. Cleanup не делает abort: StrictMode-двойной вызов эффекта не
  // должен рвать первый (живой) POST.
  useEffect(() => {
    if (!buildRequest || !abortSignal) return;
    if (oneShotStartedRef.current) return;
    oneShotStartedRef.current = true;
    const { url, init } = buildRequest();
    runStream({ url, init, signal: abortSignal });
  }, [buildRequest, abortSignal]);

  // Автоскролл после каждого флеша.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (autoscroll) el.scrollTop = el.scrollHeight;
    // Рост контента без событий скролла (автоскролл выключен) должен
    // попадать в метрики — иначе сжатие после роста не распознается как
    // сжатие. При уменьшении метрики НЕ трогаем: пассивный эффект выполняется
    // раньше события клампинга, и реф, обновлённый здесь, погасил бы
    // подавление в onScroll.
    if (autoscroll || el.scrollHeight > lastMetricsRef.current.height) {
      lastMetricsRef.current = { height: el.scrollHeight, top: el.scrollTop };
    }
  }, [lines, pendingLine, autoscroll]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const { height, top } = lastMetricsRef.current;
    const sh = el.scrollHeight;
    const st = el.scrollTop;
    lastMetricsRef.current = { height: sh, top: st };
    // Оба упали — браузер прижал scrollTop при сжатии контента: жеста не
    // было, автоскролл не трогаем (пользователь его выключал).
    if (sh < height && st < top) return;
    const atBottom = sh - st - el.clientHeight <= AUTOSCROLL_THRESHOLD_PX;
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
    const server = serverName ? t('logViewer.askServerSuffix', { name: serverName }) : '';
    onAskAgent(t('logViewer.askPrompt', { where, server, tail: lastNChars(visibleLines, ASK_TAIL_CHARS) }));
  };

  const statusText =
    status === 'stopped'
      ? oneShot
        ? t('logViewer.statusDone')
        : t('logViewer.statusStopped')
      : status === 'error'
        ? error
        : t('logViewer.statusConnected');

  const statusClass = status === 'error' ? 'error' : status === 'stopped' ? 'stopped' : 'live';
  const fileName = (logPath ?? title).split('/').pop() ?? title;

  return (
    <div className="log-viewer">
      <div className="logs-toolbar">
        {!oneShot && (
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            {t('logViewer.follow')}
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          {t('logViewer.autoscroll')}
        </label>
        <input
          className="log-filter"
          placeholder={t('logViewer.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {toolbarExtra}
        <button className="btn btn-mini" onClick={() => void copy()}>{t('logViewer.copy')}</button>
        {onAskAgent && (
          <button className="btn btn-mini" onClick={ask}>{t('logViewer.toChat')}</button>
        )}
        {!oneShot && (status === 'error' || status === 'stopped') && (
          <button className="btn btn-mini" onClick={() => setRetry((r) => r + 1)}>{t('logViewer.reconnect')}</button>
        )}
      </div>
      <div className="viewer-pane">
        <div className="viewer-pane-head">
          <code>{fileName}</code>
          <span className="spacer" />
          <span>{t('logViewer.linesCount', { n: visibleLines.length })}</span>
          <span className={`viewer-status ${statusClass}`}>{statusText}</span>
        </div>
        <pre className="logs-view" ref={preRef} onScroll={onScroll}>
          {visibleLines.join('\n')}
        </pre>
      </div>
    </div>
  );
}
