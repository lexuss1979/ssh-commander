import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appendChunk, lastNChars, type LogBufferState } from '../log-buffer';
import { useT } from '../i18n';

const MAX_LINES = 5000;
// Flush the buffer into state on an interval, not on every chunk — batching
// against a re-render per stream piece. The interval is shared by both modes
// and lives outside the stream effect: the oneShot stream survives tab
// switches, so the flush must not die with its effect.
const FLUSH_MS = 250;
// Context for "To chat": the tail of the filtered buffer, up to 4 KB.
const ASK_TAIL_CHARS = 4096;
// Manual scrolling away from the bottom turns autoscroll off, returning to the bottom turns it back on.
const AUTOSCROLL_THRESHOLD_PX = 40;

export type LogViewerStatus = 'loading' | 'live' | 'stopped' | 'error';

/**
 * A regular stream (tail, journalctl) is built on `buildUrl` (`kind: 'url'`);
 * the mutating POST stream (epic 19: applying updates) — on `buildRequest` +
 * `abortSignal` (`kind: 'request'`, essentially oneShot). The discriminated
 * union on `kind` makes the "neither passed" state unrepresentable (the
 * required literal is the discriminant).
 */
type Props = {
  /** Source title (for the footer line, when logPath is not set). */
  title: string;
  visible: boolean;
  onAskAgent?: (text: string) => void;
  /** Slot for extra toolbar controls (e.g. "★ Pin"). */
  toolbarExtra?: ReactNode;
  /** File path for the "To chat" message — the agent learns what the user is looking at. */
  logPath?: string;
  serverName?: string;
  /** Terminal stream state — to the parent (whether closing needs a confirm). */
  onStatusChange?: (status: LogViewerStatus) => void;
} & (
  | {
      kind: 'url';
      /** Stream URL; the caller stabilizes it with useCallback, otherwise the
       * identity of the prop would restart the stream. */
      buildUrl: (follow: boolean) => string;
    }
  | {
      kind: 'request';
      /**
       * The mutation's POST stream (the password goes in the request body,
       * not the URL). The useCallback must be stabilized with explicit
       * dependencies — an identity change would restart the stream, i.e.
       * execute the mutation a second time.
       */
      buildRequest: () => { url: string; init?: RequestInit };
      /**
       * Abort signal: the parent tears the stream down when the modal closes.
       * The stream is NOT tied to `visible` and is not aborted by the effect
       * cleanup — tab switches and StrictMode effect re-runs must not kill a
       * running mutation (otherwise `apt-get upgrade` would break on a tab
       * switch).
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
  // Trailing partial line without \n: it becomes visible right away rather
  // than after the next chunk — otherwise an empty log and the truncation
  // marker (both without \n) would be lost.
  const [pendingLine, setPendingLine] = useState('');
  const bufferRef = useRef<LogBufferState>({ lines: [], pending: '' });
  const dirtyRef = useRef(false);
  const preRef = useRef<HTMLPreElement>(null);
  // oneShot: the "start exactly once per mount" guard — StrictMode in dev
  // mounts effects twice, and without the guard the POST (apt-get upgrade)
  // would go out twice. There is no abort in cleanup, so the first (live)
  // fetch survives the double invocation; a new mount (reopening the modal)
  // gets a fresh ref instance.
  const oneShotStartedRef = useRef(false);
  // Suppress setState after unmount (including the StrictMode re-run: the
  // [] effect resets the flag to false after the double invocation).
  const unmountedRef = useRef(false);
  // Scroll metrics of the previous event/effect. Browser clamping when the
  // content shrinks (filter, ring eviction) pushes scrollTop to the bottom
  // without a user gesture — its signature: BOTH scrollHeight and scrollTop
  // dropped. An upward gesture drops only scrollTop; a gesture toward the
  // bottom grows scrollTop.
  const lastMetricsRef = useRef({ height: 0, top: 0 });

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Flush the buffer into state on an interval (batching against a re-render per chunk).
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

  // Shared stream loop: fetch + reader + ring buffer + statuses. Lives in
  // refs and is not tied to call identity — both effects invoke it once per
  // their own lifecycle.
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
          // Final flush: there will be no more data, the partial line is the
          // whole rest of the output (a common case for a follow=0 snapshot).
          dirtyRef.current = true;
          flushNow();
          finish('stopped');
        }
      })
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return; // the parent closed the modal
        if (unmountedRef.current) return;
        dirtyRef.current = true;
        flushNow();
        finish('error', (err as Error).message);
      });
  };

  // Narrowing the discriminated prop down to concrete values: plain local
  // variables are easier for TS in dependency arrays than access through the union.
  const buildUrl = props.kind === 'url' ? props.buildUrl : undefined;
  const buildRequest = props.kind === 'request' ? props.buildRequest : undefined;
  const abortSignal = props.kind === 'request' ? props.abortSignal : undefined;

  // Regular streams: pause on a hidden tab, restart on follow/retry changes
  // or on visibility return — the cleanup aborts the fetch (a restart is
  // harmless for a follow stream).
  useEffect(() => {
    if (!buildUrl) return;
    if (!visible) return;
    const controller = new AbortController();
    runStream({ url: buildUrl(follow), signal: controller.signal });
    return () => controller.abort();
    // runStream is intentionally left out of the dependencies: it is re-created
    // on every render, while the stream should live by its stable props.
  }, [buildUrl, visible, follow, retry]);

  // kind='request' (mutation): starts exactly once per mount; the stream
  // lifetime does NOT depend on visible or effect re-runs; interruption is
  // only via the parent's abortSignal (modal close) or the command finishing
  // naturally. The cleanup does not abort: the StrictMode double invocation
  // must not tear down the first (live) POST.
  useEffect(() => {
    if (!buildRequest || !abortSignal) return;
    if (oneShotStartedRef.current) return;
    oneShotStartedRef.current = true;
    const { url, init } = buildRequest();
    runStream({ url, init, signal: abortSignal });
  }, [buildRequest, abortSignal]);

  // Autoscroll after every flush.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (autoscroll) el.scrollTop = el.scrollHeight;
    // Content growth without scroll events (autoscroll off) must still land
    // in the metrics — otherwise shrinkage after growth would not be
    // recognized as shrinkage. On decrease the metrics are NOT touched: the
    // passive effect runs before the clamping event, and a ref updated here
    // would cancel out the suppression in onScroll.
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
    // Both dropped — the browser pushed scrollTop while the content shrank:
    // there was no gesture, autoscroll is left alone (the user turned it off).
    if (sh < height && st < top) return;
    const atBottom = sh - st - el.clientHeight <= AUTOSCROLL_THRESHOLD_PX;
    if (atBottom !== autoscroll) setAutoscroll(atBottom);
  };

  const normalizedFilter = filter.trim().toLowerCase();
  // Displayed buffer: full lines + the trailing partial one (if it matches
  // the filter) — filter, copy and "To chat" all work off the same set.
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
      /* clipboard may be unavailable */
    }
  };

  // 'send': the text is already assembled and is not wrapped in "terminal
  // output" — the file path goes into the message, so the agent learns what
  // the user is looking at.
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
