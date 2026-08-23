import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetrics, fetchMetricsHistory, fetchPackages, packagesApplyRequest } from '../api';
import type { HistorySample, PackagesSnapshot, ServerMetrics } from '../api';
import type { AgentAskMode, Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';
import { LoadChart } from '../components/Sparkline';
import { LogViewer, type LogViewerStatus } from '../components/LogViewer';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const POLL_INTERVAL_MS = 3000;
// Обновления пакетов опрашиваются отдельным (медленным) таймером, а не тиком
// метрик: снимок — это 2 exec'а + SFTP-stat, и раз в минуту он не должен
// стопорить тик CPU/памяти/дисков. Серверный кэш 60 с гасит повторы.
const PACKAGES_POLL_MS = 60000;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} дн ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
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
function indexAgeText(ms: number | null): string {
  if (ms === null) return 'индекс не обновлялся';
  const days = ms / 86400000;
  if (days >= 1) return `индекс обновлён ${Math.floor(days)} дн назад`;
  const hours = ms / 3600000;
  if (hours >= 1) return `индекс обновлён ${Math.floor(hours)} ч назад`;
  return 'индекс обновлён недавно';
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
  const count = packages?.updates.length ?? 0;
  const pm = packages?.pm;
  const reboot = packages?.rebootRequired;
  return (
    <div className="overview-card">
      <div className="overview-card-title">Обновления</div>
      {!packages ? (
        <div className="overview-sub">Загрузка…</div>
      ) : pm === null ? (
        <div className="overview-sub">Обновления не проверяются</div>
      ) : (
        <>
          <div className="overview-big">
            {count} {pluralUpdates(count)}
          </div>
          <div className="overview-sub">
            менеджер: <code>{pm}</code>
            {pm === 'apt' && (
              <> · {indexAgeText(packages.indexAgeMs)}</>
            )}
          </div>
          {reboot && (
            <div
              className="packages-reboot"
              title={packages.rebootPackages.length > 0 ? packages.rebootPackages.join(', ') : undefined}
            >
              ⚠ нужен рестарт сервера
            </div>
          )}
          <div className="packages-actions">
            <button
              className="btn btn-danger btn-small"
              onClick={onApply}
              disabled={count === 0}
              title={count === 0 ? 'обновлений нет' : undefined}
            >
              Обновить всё
            </button>
            <button className="btn btn-ghost btn-small" onClick={onScrollToList}>
              Список
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function pluralUpdates(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'обновление';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'обновления';
  return 'обновлений';
}

export function OverviewPage({ profile, visible, onAskAgent }: Props) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [packages, setPackages] = useState<PackagesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
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
    command: (p: (typeof processes)[0]) => p.command,
    pid: (p: (typeof processes)[0]) => p.pid,
    user: (p: (typeof processes)[0]) => p.user,
    cpu: (p: (typeof processes)[0]) => p.cpuPercent ?? 0,
    mem: (p: (typeof processes)[0]) => p.memPercent ?? 0,
  }), []);
  const { sort: procSort, toggle: toggleProcSort, sorted: sortedProcesses } = useSortBy(processes, procAccessors, { key: 'cpu', dir: 'desc' });

  return (
    <div className="page overview-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? `Нет связи: ${error}`
            : metrics
              ? `Обновлено ${new Date(metrics.timestamp).toLocaleTimeString('ru-RU')}`
              : 'Загрузка…'}
        </span>
        <div className="toolbar-actions">
          <span className="muted">
            {profile.name} — {profile.username}@{profile.host}
          </span>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {error && !metrics ? (
        <div className="empty-state">
          <p>Сервер недоступен: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <div className="overview-scroll">
          <div className="overview-grid">
            <div className="overview-card">
              <div className="overview-card-title">Процессор</div>
              <div className="overview-big">{formatPct(metrics?.cpu.percent ?? null)}</div>
              <Meter percent={metrics?.cpu.percent ?? null} />
              <div className="overview-sub">
                Ядер: {metrics?.cpu.cores ?? '—'}
              </div>
              <LoadChart samples={history} value={(s) => s.cpu} tone="cpu" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Память</div>
              <div className="overview-big">{formatPct(mem?.usedPercent ?? null)}</div>
              <Meter percent={mem?.usedPercent ?? null} />
              <div className="overview-sub">
                {formatBytes(mem?.usedBytes ?? null)} из {formatBytes(mem?.totalBytes ?? null)}
              </div>
              <LoadChart samples={history} value={(s) => s.memPct} tone="mem" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Аптайм и нагрузка</div>
              <div className="overview-big">{formatUptime(metrics?.uptimeSeconds ?? null)}</div>
              <div className="overview-sub">
                Load average (1/5/15 мин):{' '}
                {metrics?.loadAverage ? metrics.loadAverage.map((n) => n.toFixed(2)).join(' / ') : '—'}
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Диски</div>
              {metrics && metrics.disks.length === 0 && (
                <div className="overview-sub">Нет данных</div>
              )}
              {!metrics && <div className="overview-sub">Загрузка…</div>}
              {(metrics?.disks ?? []).map((d) => (
                <div className="disk-row" key={d.mount}>
                  <div className="disk-row-head">
                    <span className="mount" title={d.filesystem}>
                      {d.mount}
                    </span>
                    <span className="sizes">
                      {formatBytes(d.usedBytes)} из {formatBytes(d.totalBytes)}
                    </span>
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
            <div className="overview-card-title">Топ процессов по CPU</div>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh sortKey="command" currentSort={procSort} onToggle={toggleProcSort}>Процесс</SortableTh>
                  <SortableTh sortKey="pid" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">PID</SortableTh>
                  <SortableTh sortKey="user" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">Пользователь</SortableTh>
                  <SortableTh sortKey="cpu" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">CPU</SortableTh>
                  <SortableTh sortKey="mem" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">Память</SortableTh>
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
                  </tr>
                ))}
                {metrics && sortedProcesses.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Нет данных
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="overview-card packages-section" ref={updatesSectionRef}>
            <div className="overview-card-title">Доступные обновления</div>
            {!packages ? (
              <div className="overview-sub">Загрузка…</div>
            ) : packages.pm === null ? (
              <div className="overview-sub">Обновления не проверяются: {packages.error ?? 'менеджер не найден'}</div>
            ) : packages.updates.length === 0 ? (
              <div className="overview-sub">Обновлений нет</div>
            ) : (
              <div className="packages-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Пакет</th>
                      <th>Версия (текущая → доступная)</th>
                      <th>Источник</th>
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

      {confirmApply && packages?.pm && (
        <Modal title="Обновить все пакеты" onClose={() => setConfirmApply(false)}>
          <p>
            Будет выполнено обновление всех доступных пакетов (<code>{applyLogLabel(packages.pm)}</code>,{' '}
            {packages.updates.length} шт).
          </p>
          <p className="critical-warning">
            ⚠ Обновление может перезапустить службы и оборвать SSH-соединение (sshd/ядро). Закрытие окна вывода
            прервёт обновление.
          </p>
          <label>
            sudo-пароль (применение требует root)
            <input
              type="password"
              value={applyPassword}
              onChange={(e) => setApplyPassword(e.target.value)}
              placeholder="оставьте пустым — команда без sudo, ошибка прав уйдёт в вывод"
              autoComplete="off"
            />
            <span className="muted" style={{ fontSize: 12 }}>
              {' '}передаётся только на этот запрос, в логи не попадает
            </span>
          </label>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmApply(false)}>
              Отмена
            </button>
            <button className="btn btn-danger" onClick={startApply}>
              Запустить
            </button>
          </div>
        </Modal>
      )}

      {applying && packages?.pm && (
        <Modal
          title={`Обновление пакетов (${packages.pm})`}
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
              Закрыть
            </button>
          </div>
        </Modal>
      )}

      {confirmCloseApply && (
        <Modal title="Прервать обновление?" onClose={() => setConfirmCloseApply(false)}>
          <p>Обновление пакетов ещё выполняется. Прервать его?</p>
          <p className="critical-warning">
            ⚠ Незавершённое обновление может оставить пакеты в промежуточном состоянии. Если обновление почти
            закончилось, лучше дождаться завершения.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmCloseApply(false)}>
              Продолжить обновление
            </button>
            <button className="btn btn-danger" onClick={finishApply}>
              Прервать
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
