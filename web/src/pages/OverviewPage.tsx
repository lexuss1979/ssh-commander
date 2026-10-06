import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchMetrics,
  fetchMetricsHistory,
  fetchPackages,
  packagesApplyRequest,
  processRenice,
  processSignal,
} from '../api';
import type { HistorySample, PackagesSnapshot, ProcessSignal, ServerMetrics } from '../api';
import type { AgentAskMode, Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';
import { LoadChart } from '../components/Sparkline';
import { DiskUsageModal } from '../components/DiskUsageModal';
import { LogViewer, type LogViewerStatus } from '../components/LogViewer';
import { Modal } from '../components/Modal';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';
// A non-React variant of t — for the exported helpers (ServersPage uses
// their signatures, they must not change).
import { t as tCore } from '../i18n/core';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** Navigate to the path in the "Files" tab (from the "What takes space" navigator). */
  onOpenInFiles: (path: string) => void;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const POLL_INTERVAL_MS = 3000;
// Package updates are polled by a separate (slow) timer, not by the metrics
// tick: a snapshot is 2 execs + an SFTP-stat, and once a minute it must not
// stall the CPU/memory/disks tick. The server's 60 s cache absorbs repeats.
const PACKAGES_POLL_MS = 60000;

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

/** A process table row (an element of `metrics.processes`). */
type ProcRow = ServerMetrics['processes'][number];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < 4) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${tCore('common.sizeUnit', i)}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return tCore('overview.uptimeDh', { d, h });
  if (h > 0) return tCore('overview.uptimeHm', { h, m });
  return tCore('overview.uptimeM', m);
}

export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(1)}%`;
}

function meterClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return '';
}

export function Meter({ percent }: { percent: number | null }) {
  return (
    <div className="meter">
      <div
        className={`meter-fill ${meterClass(percent)}`}
        style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
      />
    </div>
  );
}

/** The apply command name — for the viewer title and the "To chat" context. */
export function applyLogLabel(pm: 'apt' | 'dnf' | 'yum' | 'apk'): string {
  switch (pm) {
    case 'apt':
      return 'apt-get upgrade';
    case 'dnf':
      return 'dnf upgrade';
    case 'yum':
      return 'yum upgrade';
    case 'apk':
      return 'apk upgrade';
  }
}

/** The apt index age: "index never updated" (no file) / "N days ago". */
function indexAgeText(t: TFn, ms: number | null): string {
  if (ms === null) return t('overview.indexNever');
  const days = ms / 86400000;
  if (days >= 1) return t('overview.indexDaysAgo', Math.floor(days));
  const hours = ms / 3600000;
  if (hours >= 1) return t('overview.indexHoursAgo', Math.floor(hours));
  return t('overview.indexRecent');
}

function PackagesCard({
  packages,
  onApply,
  onScrollToList,
}: {
  packages: PackagesSnapshot | null;
  onApply: () => void;
  onScrollToList: () => void;
}) {
  const { t } = useT();
  const count = packages?.updates.length ?? 0;
  const pm = packages?.pm;
  const reboot = packages?.rebootRequired;
  return (
    <div className="overview-card">
      <div className="overview-card-title">{t('overview.cardUpdates')}</div>
      {!packages ? (
        <div className="overview-sub">{t('common.loading')}</div>
      ) : pm === null ? (
        <div className="overview-sub">{t('overview.updatesNotChecked')}</div>
      ) : (
        <>
          <div className="overview-big">
            {count} {t('overview.updatesWord', count)}
          </div>
          <div className="overview-sub">
            {t('overview.managerPrefix')} <code>{pm}</code>
            {pm === 'apt' && (
              <> · {indexAgeText(t, packages.indexAgeMs)}</>
            )}
          </div>
          {reboot && (
            <div
              className="packages-reboot"
              title={packages.rebootPackages.length > 0 ? packages.rebootPackages.join(', ') : undefined}
            >
              {t('overview.rebootRequired')}
            </div>
          )}
          <div className="packages-actions">
            <button
              className="btn btn-danger btn-small"
              onClick={onApply}
              disabled={count === 0}
              title={count === 0 ? t('overview.noUpdatesTitle') : undefined}
            >
              {t('overview.applyAll')}
            </button>
            <button className="btn btn-ghost btn-small" onClick={onScrollToList}>
              {t('overview.listButton')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function OverviewPage({ profile, visible, onOpenInFiles, onAskAgent }: Props) {
  const { t, locale } = useT();
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [packages, setPackages] = useState<PackagesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The "What takes space" navigator: the mount point of the selected disk row.
  const [duTarget, setDuTarget] = useState<string | null>(null);
  // Process actions (epic 17): the modal target, status, sudo password.
  const [actionTarget, setActionTarget] = useState<ProcRow | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // The sudo password is kept in the page state for the tab's lifetime (no
  // persist): after the first entry subsequent actions do not ask again (the
  // ServicesPage pattern, same comment).
  const [sudoPassword, setSudoPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);
  const updatesSectionRef = useRef<HTMLDivElement>(null);
  // Applying updates: confirmation → live output viewer.
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyPassword, setApplyPassword] = useState('');
  const [applying, setApplying] = useState(false);
  // Closing confirmation for the viewer while the update is still running.
  const [confirmCloseApply, setConfirmCloseApply] = useState(false);
  // Aborting the apply stream: the parent controller — LogViewer in oneShot
  // mode lives not by `visible` but by the abortSignal.
  const applyAbortRef = useRef<AbortController | null>(null);
  // The last stream status — so requestCloseApply knows whether to confirm.
  const applyStatusRef = useRef<LogViewerStatus>('loading');

  // Sequential polling: the next request only after the previous one
  // finishes. In a hidden tab (keep-alive) the poll is fully stopped.
  // The load history is fetched by the same tick, but its errors are silent —
  // the charts are decorative, on a failure the last drawn picture remains.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const [mRes, hRes] = await Promise.allSettled([
        fetchMetrics(profile.id),
        fetchMetricsHistory(profile.id),
      ]);
      if (cancelled) return;
      if (mRes.status === 'fulfilled') {
        setMetrics(mRes.value);
        setError(null);
      } else {
        setError((mRes.reason as Error).message);
      }
      if (hRes.status === 'fulfilled') {
        setHistory(hRes.value.samples);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profile.id, visible, reloadKey]);

  // Package updates — a separate slow timer (does not block the metrics tick);
  // errors are silent — the card keeps the last snapshot. reloadKey — so that
  // after applying (invalidating the server cache) a refetch happens at once.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tickPackages = async () => {
      try {
        const p = await fetchPackages(profile.id);
        if (!cancelled) setPackages(p);
      } catch {
        /* silent errors */
      }
      if (!cancelled) {
        timer = window.setTimeout(tickPackages, PACKAGES_POLL_MS);
      }
    };
    tickPackages();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profile.id, visible, reloadKey]);

  // Identity stability is mandatory: LogViewer restarts the stream when
  // buildRequest changes, and for oneShot that means re-running the mutation.
  const buildApplyRequest = useCallback(
    (): { url: string; init?: RequestInit } => packagesApplyRequest(profile.id, applyPassword || undefined),
    [profile.id, applyPassword],
  );

  const startApply = () => {
    applyAbortRef.current = new AbortController();
    applyStatusRef.current = 'loading';
    setConfirmApply(false);
    setApplying(true);
  };

  const finishApply = () => {
    // Abort the running stream (if still alive) and close the modal.
    applyAbortRef.current?.abort();
    // The password does not live in the state longer than the modal — the
    // next confirmation starts with an empty field.
    setApplyPassword('');
    setApplying(false);
    setConfirmCloseApply(false);
    // The server snapshot cache has already been reset by invalidation — an immediate refetch.
    setReloadKey((k) => k + 1);
  };

  // Closing the viewer: while the stream runs — a confirmation (clicking the
  // overlay does not close at all: Modal dismissable={false}).
  const requestCloseApply = () => {
    const s = applyStatusRef.current;
    if (s === 'stopped' || s === 'error') {
      finishApply();
    } else {
      setConfirmCloseApply(true);
    }
  };

  const mem = metrics?.memory;

  const processes = metrics?.processes ?? [];
  const procAccessors = useMemo(() => ({
    command: (p: ProcRow) => p.command,
    pid: (p: ProcRow) => p.pid,
    user: (p: ProcRow) => p.user,
    cpu: (p: ProcRow) => p.cpuPercent ?? 0,
    mem: (p: ProcRow) => p.memPercent ?? 0,
  }), []);
  const { sort: procSort, toggle: toggleProcSort, sorted: sortedProcesses } = useSortBy(processes, procAccessors, { key: 'cpu', dir: 'desc' });

  /** The confirmed action from the modal: a signal or a renice with a sudo retry.
   * After success — the metrics cache has been reset on the server, the
   * polling tick will immediately hit a fresh snapshot. */
  const handleProcessAction = async (action: ProcessModalAction, nice: number) => {
    if (!actionTarget) return;
    setActionBusy(true);
    setConfirmError(null);
    try {
      if (action === 'renice') {
        const result = await processRenice(profile.id, actionTarget.pid, nice, sudoPassword || undefined);
        setActionTarget(null);
        showNotice(t('overview.noticeRenice', { pid: actionTarget.pid }) + (result.output ? ` — ${result.output}` : ''));
      } else {
        await processSignal(profile.id, actionTarget.pid, action, sudoPassword || undefined);
        setActionTarget(null);
        showNotice(t('overview.noticeSignal', { signal: action, pid: actionTarget.pid }));
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      setConfirmError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="page overview-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? t('common.noConnection', { error })
            : metrics
              ? t('common.updated', { time: new Date(metrics.timestamp).toLocaleTimeString(locale) })
              : t('common.loading')}
        </span>
        <div className="toolbar-actions">
          <span className="muted">
            {profile.name} — {profile.username}@{profile.host}
          </span>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && !metrics ? (
        <div className="empty-state">
          <p>{t('common.serverUnavailable', { error })}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <div className="overview-scroll">
          <div className="overview-grid">
            <div className="overview-card">
              <div className="overview-card-title">{t('overview.cardCpu')}</div>
              <div className="overview-big">{formatPct(metrics?.cpu.percent ?? null)}</div>
              <Meter percent={metrics?.cpu.percent ?? null} />
              <div className="overview-sub">
                {t('overview.cores', { n: metrics?.cpu.cores ?? '—' })}
              </div>
              <LoadChart samples={history} value={(s) => s.cpu} tone="cpu" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">{t('overview.cardMemory')}</div>
              <div className="overview-big">{formatPct(mem?.usedPercent ?? null)}</div>
              <Meter percent={mem?.usedPercent ?? null} />
              <div className="overview-sub">
                {formatBytes(mem?.usedBytes ?? null)} {t('common.of')} {formatBytes(mem?.totalBytes ?? null)}
              </div>
              <LoadChart samples={history} value={(s) => s.memPct} tone="mem" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">{t('overview.cardUptime')}</div>
              <div className="overview-big">{formatUptime(metrics?.uptimeSeconds ?? null)}</div>
              <div className="overview-sub">
                {t('overview.loadAverage')}{' '}
                {metrics?.loadAverage ? metrics.loadAverage.map((n) => n.toFixed(2)).join(' / ') : '—'}
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-card-title">{t('overview.cardDisks')}</div>
              {metrics && metrics.disks.length === 0 && (
                <div className="overview-sub">{t('overview.noData')}</div>
              )}
              {!metrics && <div className="overview-sub">{t('common.loading')}</div>}
              {(metrics?.disks ?? []).map((d) => (
                <div className="disk-row" key={d.mount}>
                  <div className="disk-row-head">
                    <span className="mount" title={d.filesystem}>
                      {d.mount}
                    </span>
                    <span className="sizes">
                      {formatBytes(d.usedBytes)} {t('common.of')} {formatBytes(d.totalBytes)}
                    </span>
                    <button
                      className="btn btn-small disk-analyze"
                      onClick={() => setDuTarget(d.mount)}
                      title={t('overview.diskAnalyzeTitle')}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="11" cy="11" r="7" />
                        <line x1="20.5" y1="20.5" x2="16" y2="16" />
                      </svg>
                      {t('overview.diskAnalyze')}
                    </button>
                  </div>
                  <Meter percent={d.usedPercent} />
                </div>
              ))}
            </div>

            <PackagesCard
              packages={packages}
              onApply={() => setConfirmApply(true)}
              onScrollToList={() => updatesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          </div>

          <div className="overview-card overview-processes">
            <div className="overview-card-title">{t('overview.topProcesses')}</div>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh sortKey="command" currentSort={procSort} onToggle={toggleProcSort}>{t('overview.colProcess')}</SortableTh>
                  <SortableTh sortKey="pid" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">PID</SortableTh>
                  <SortableTh sortKey="user" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">{t('overview.colUser')}</SortableTh>
                  <SortableTh sortKey="cpu" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">CPU</SortableTh>
                  <SortableTh sortKey="mem" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">{t('overview.colMemory')}</SortableTh>
                  <th className="col-actions">{t('overview.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedProcesses.map((p) => (
                  <tr key={p.pid}>
                    <td className="proc-command" title={p.command}>
                      {p.command}
                    </td>
                    <td>{p.pid}</td>
                    <td>{p.user}</td>
                    <td>{formatPct(p.cpuPercent)}</td>
                    <td>{formatPct(p.memPercent)}</td>
                    <td className="col-actions">
                      <button
                        className="btn btn-ghost btn-small"
                        title={t('overview.procActionsTitle', { pid: p.pid })}
                        onClick={() => {
                          setActionTarget(p);
                          setConfirmError(null);
                        }}
                      >
                        ⋯
                      </button>
                    </td>
                  </tr>
                ))}
                {metrics && sortedProcesses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {t('overview.noData')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="overview-card packages-section" ref={updatesSectionRef}>
            <div className="overview-card-title">{t('overview.updatesTitle')}</div>
            {!packages ? (
              <div className="overview-sub">{t('common.loading')}</div>
            ) : packages.pm === null ? (
              <div className="overview-sub">{t('overview.updatesNotCheckedError', { error: packages.error ?? t('overview.managerNotFound') })}</div>
            ) : packages.updates.length === 0 ? (
              <div className="overview-sub">{t('overview.noUpdates')}</div>
            ) : (
              <div className="packages-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('overview.colPackage')}</th>
                      <th>{t('overview.colVersion')}</th>
                      <th>{t('overview.colSource')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.updates.map((u) => (
                      <tr key={u.name}>
                        <td>
                          <code>{u.name}</code>
                        </td>
                        <td>
                          {u.current ?? '—'} → {u.available}
                        </td>
                        <td className="muted">{u.source ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {duTarget !== null && (
        <DiskUsageModal
          key={duTarget}
          profile={profile}
          initialPath={duTarget}
          onClose={() => setDuTarget(null)}
          onOpenInFiles={(p) => {
            // Close the navigator: without this the modal rides along with the
            // hidden "Overview" tab and greets the user at the old path.
            setDuTarget(null);
            onOpenInFiles(p);
          }}
        />
      )}

      {actionTarget && (
        <ProcessActionModal
          process={actionTarget}
          profileUsername={profile.username}
          busy={actionBusy}
          error={confirmError}
          sudoPassword={sudoPassword}
          onSudoPasswordChange={setSudoPassword}
          onClose={() => setActionTarget(null)}
          onConfirm={handleProcessAction}
        />
      )}

      {notice && <div className="toast toast-notice">{notice}</div>}
      {confirmApply && packages?.pm && (
        <Modal title={t('overview.applyModalTitle')} onClose={() => setConfirmApply(false)} dismissable={false}>
          <p>
            {t('overview.applyConfirmPre')}<code>{applyLogLabel(packages.pm)}</code>{t('overview.applyConfirmPost', { n: packages.updates.length })}
          </p>
          <p className="critical-warning">
            {t('overview.applyWarning')}
          </p>
          <label>
            {t('overview.applySudoLabel')}
            <input
              type="password"
              value={applyPassword}
              onChange={(e) => setApplyPassword(e.target.value)}
              placeholder={t('overview.applySudoPlaceholder')}
              autoComplete="off"
            />
            <span className="muted" style={{ fontSize: 12 }}>
              {' '}{t('overview.applySudoHint')}
            </span>
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmApply(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-danger" onClick={startApply}>
              {t('overview.applyStart')}
            </button>
          </div>
        </Modal>
      )}

      {applying && packages?.pm && (
        <Modal
          title={t('overview.applyingTitle', { pm: packages.pm })}
          onClose={requestCloseApply}
          wide
          dismissable={false}
        >
          <LogViewer
            kind="request"
            title={applyLogLabel(packages.pm)}
            buildRequest={buildApplyRequest}
            abortSignal={applyAbortRef.current?.signal ?? new AbortController().signal}
            visible={visible}
            logPath={applyLogLabel(packages.pm)}
            serverName={profile.name}
            onStatusChange={(s) => {
              applyStatusRef.current = s;
            }}
            onAskAgent={(text) => {
              // Do NOT close the modal: for oneShot closing = aborting the
              // mutation; the agent panel expands on the right, the output
              // stays.
              onAskAgent?.(text, 'send');
            }}
          />
          <div className="modal-actions">
            <button className="btn" onClick={requestCloseApply}>
              {t('common.close')}
            </button>
          </div>
        </Modal>
      )}

      {confirmCloseApply && (
        <Modal title={t('overview.abortTitle')} onClose={() => setConfirmCloseApply(false)}>
          <p>{t('overview.abortText')}</p>
          <p className="critical-warning">
            {t('overview.abortWarning')}
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmCloseApply(false)}>
              {t('overview.abortContinue')}
            </button>
            <button className="btn btn-danger" onClick={finishApply}>
              {t('overview.abortConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Process action modal (epic 17)
// ---------------------------------------------------------------------------

type ProcessModalAction = ProcessSignal | 'renice';

const PROCESS_ACTION_LABELS: Record<ProcessModalAction, I18nKey> = {
  TERM: 'overview.actionTerm',
  KILL: 'overview.actionKill',
  HUP: 'overview.actionHup',
  renice: 'overview.actionRenice',
};

function ProcessActionModal({
  process: p,
  profileUsername,
  busy,
  error,
  sudoPassword,
  onSudoPasswordChange,
  onClose,
  onConfirm,
}: {
  process: ProcRow;
  profileUsername: string;
  busy: boolean;
  error: string | null;
  sudoPassword: string;
  onSudoPasswordChange: (v: string) => void;
  onClose: () => void;
  onConfirm: (action: ProcessModalAction, nice: number) => void;
}) {
  const { t } = useT();
  const [action, setAction] = useState<ProcessModalAction>('TERM');
  // The raw string: a cleared `<input type="number">` yields '', and
  // `Number('') === 0` — an empty field must not silently mean "reset to 0".
  const [nice, setNice] = useState('5');

  // Mono command preview: the server will run exactly this (except the sudo wrapper).
  const command = action === 'renice' ? `renice -n ${nice} -p ${p.pid}` : `kill -${action} ${p.pid}`;

  // Warnings strengthen the confirmation, they do not block (roadmap).
  const warnings: string[] = [];
  // `ps aux` truncates the USER column to 8 characters with a trailing '+' —
  // long names of the user's own account must not be falsely marked as
  // "someone else's".
  const userMatches = (u: string): boolean =>
    u === profileUsername || (profileUsername.length > 8 && u === `${profileUsername.slice(0, 8)}+`);
  if (!userMatches(p.user)) {
    warnings.push(t('overview.warnOtherUser'));
  }
  if (p.pid < 100) {
    warnings.push(t('overview.warnSystemPid'));
  }
  if (action === 'KILL') {
    warnings.push(t('overview.warnKill'));
  }

  const actionBtnClass = (a: ProcessModalAction): string => {
    if (a !== action) return 'btn btn-ghost btn-small';
    return a === 'KILL' ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
  };

  return (
    <Modal title={t('overview.processTitle', { pid: p.pid })} onClose={onClose}>
      <div className="process-summary">
        <div className="proc-command" title={p.command}>
          {p.command}
        </div>
        <div className="muted">
          {t('overview.processSummary', {
            pid: p.pid,
            user: p.user,
            cpu: formatPct(p.cpuPercent),
            mem: formatPct(p.memPercent),
          })}
        </div>
      </div>

      <div className="process-action-row">
        {(['TERM', 'KILL', 'HUP', 'renice'] as const).map((a) => (
          <button key={a} className={actionBtnClass(a)} onClick={() => setAction(a)}>
            {t(PROCESS_ACTION_LABELS[a])}
          </button>
        ))}
      </div>

      {action === 'renice' && (
        <label>
          {t('overview.niceLabel')}
          <input
            type="number"
            min={-20}
            max={19}
            value={nice}
            onChange={(e) => setNice(e.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {' '}{t('overview.niceHint')}
          </span>
        </label>
      )}

      <pre className="process-preview">{command}</pre>

      {warnings.length > 0 && (
        <div className="process-warnings">
          {warnings.map((w, i) => (
            <p key={i} className="process-warning">⚠ {w}</p>
          ))}
        </div>
      )}

      <label>
        {t('overview.sudoPasswordLabel')}
        <input
          type="password"
          value={sudoPassword}
          onChange={(e) => onSudoPasswordChange(e.target.value)}
          placeholder={t('overview.sudoPasswordPlaceholder')}
          autoComplete="off"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {' '}{t('overview.sudoPasswordHint')}
        </span>
      </label>

      {error && <p className="error-text">{error}</p>}

      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button
          className={`btn ${action === 'KILL' ? 'btn-danger' : 'btn-primary'}`}
          // An empty nice field — the default of 5, not a silent 0 (Number('') === 0).
          onClick={() => onConfirm(action, nice.trim() === '' ? 5 : Number(nice))}
          disabled={busy}
        >
          {busy ? t('overview.actionRunning') : t(PROCESS_ACTION_LABELS[action])}
        </button>
      </div>
    </Modal>
  );
}
