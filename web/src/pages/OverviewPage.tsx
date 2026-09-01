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
// Не-React вариант t — для экспортируемых хелперов (их сигнатуры
// использует ServersPage, менять их нельзя).
import { t as tCore } from '../i18n/core';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** Переход на путь во вкладке «Файлы» (из навигатора «Что занимает»). */
  onOpenInFiles: (path: string) => void;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const POLL_INTERVAL_MS = 3000;
// Обновления пакетов опрашиваются отдельным (медленным) таймером, а не тиком
// метрик: снимок — это 2 exec'а + SFTP-stat, и раз в минуту он не должен
// стопорить тик CPU/памяти/дисков. Серверный кэш 60 с гасит повторы.
const PACKAGES_POLL_MS = 60000;

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

/** Строка таблицы процессов (элемент `metrics.processes`). */
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

/** Имя команды применения — для заголовка просмотрщика и контекста «В чат». */
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

/** Возраст индекса apt: «индекс не обновлялся» (файла нет) / «N дн назад». */
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
  // Навигатор «Что занимает»: точка монтирования выбранной строки диска.
  const [duTarget, setDuTarget] = useState<string | null>(null);
  // Действия над процессами (эпик 17): цель модалки, статус, sudo-пароль.
  const [actionTarget, setActionTarget] = useState<ProcRow | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // sudo-пароль держим в стейте страницы на время жизни вкладки (без persist):
  // после первого ввода повторные действия не спрашивают его заново (паттерн
  // ServicesPage, комментарий тот же).
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
  // Применение обновлений: подтверждение → просмотрщик живого вывода.
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyPassword, setApplyPassword] = useState('');
  const [applying, setApplying] = useState(false);
  // Подтверждение закрытия просмотрщика, пока обновление ещё выполняется.
  const [confirmCloseApply, setConfirmCloseApply] = useState(false);
  // Прерывание стрима применения: родительский контроллер — LogViewer в
  // oneShot-режиме живёт не по `visible`, а по abortSignal.
  const applyAbortRef = useRef<AbortController | null>(null);
  // Последний статус стрима — чтобы requestCloseApply знал, нужен ли confirm.
  const applyStatusRef = useRef<LogViewerStatus>('loading');

  // Последовательный polling: следующий запрос только после завершения
  // предыдущего. На скрытой вкладке (keep-alive) опрос полностью остановлен.
  // История нагрузки грузится тем же тиком, но её ошибки тихие — графики
  // декоративные, при сбое остаётся последнее нарисованное.
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

  // Обновления пакетов — отдельный медленный таймер (не блокирует тик метрик);
  // ошибки тихие — карточка остаётся с последним снимком. reloadKey — чтобы
  // после применения (инвалидации серверного кэша) refetch случился сразу.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tickPackages = async () => {
      try {
        const p = await fetchPackages(profile.id);
        if (!cancelled) setPackages(p);
      } catch {
        /* тихие ошибки */
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

  // Стабильность identity обязательна: LogViewer перезапускает стрим при
  // смене buildRequest, а для oneShot это повторный запуск мутации.
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
    // Прерывание идущего стрима (если он ещё жив) и закрытие модалки.
    applyAbortRef.current?.abort();
    // Пароль не живёт в стейте дольше модалки — следующее подтверждение
    // начинается с пустого поля.
    setApplyPassword('');
    setApplying(false);
    setConfirmCloseApply(false);
    // Серверный кэш снимка уже сброшен инвалидацией — немедленный refetch.
    setReloadKey((k) => k + 1);
  };

  // Закрытие просмотрщика: пока стрим выполняется — подтверждение (клик по
  // оверлею при этом вообще не закрывает: Modal dismissable={false}).
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

  /** Подтверждённое действие из модалки: сигнал или renice с sudo-ретраем.
   * После успеха — кэш метрик сброшен на сервере, тик polling'а сработает
   * немедленно против свежего снимка. */
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
            // Закрываем навигатор: без этого модалка уезжает вместе со скрытой
            // вкладкой «Обзора» и встречает пользователя на старом пути.
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
              // Модалку НЕ закрываем: для oneShot закрытие = прерывание
              // мутации; панель агента раскрывается справа, вывод остаётся.
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
// Модалка действий над процессом (эпик 17)
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
  // Сырая строка: очищенное `<input type="number">` даёт '', а
  // `Number('') === 0` — пустое поле не должно молча означать «сброс в 0».
  const [nice, setNice] = useState('5');

  // Превью команды mono: сервер соберёт ровно её (кроме sudo-обёртки).
  const command = action === 'renice' ? `renice -n ${nice} -p ${p.pid}` : `kill -${action} ${p.pid}`;

  // Предупреждения усиливают подтверждение, не блокируют (roadmap).
  const warnings: string[] = [];
  // `ps aux` усекает колонку USER до 8 символов с хвостовым '+' — длинные
  // имена своего пользователя не должны ложно помечаться «чужими».
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
          // Пустое поле nice — дефолт 5, а не молчаливый 0 (Number('') === 0).
          onClick={() => onConfirm(action, nice.trim() === '' ? 5 : Number(nice))}
          disabled={busy}
        >
          {busy ? t('overview.actionRunning') : t(PROCESS_ACTION_LABELS[action])}
        </button>
      </div>
    </Modal>
  );
}
