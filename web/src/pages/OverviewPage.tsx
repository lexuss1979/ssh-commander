import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetrics, fetchMetricsHistory, fetchPackages } from '../api';
import type { HistorySample, PackagesSnapshot, ServerMetrics } from '../api';
import type { AgentAskMode, Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';
import { LoadChart } from '../components/Sparkline';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  onAskAgent?: (text: string, mode?: AgentAskMode) => void;
}

const POLL_INTERVAL_MS = 3000;

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
  onScrollToList,
}: {
  packages: PackagesSnapshot | null;
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
            {pm === 'apt' && packages.indexAgeMs !== null && (
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

export function OverviewPage({ profile, visible }: Props) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [packages, setPackages] = useState<PackagesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const updatesSectionRef = useRef<HTMLDivElement>(null);

  // Последовательный polling: следующий запрос только после завершения
  // предыдущего. На скрытой вкладке (keep-alive) опрос полностью остановлен.
  // История нагрузки грузится тем же тиком, но её ошибки тихие — графики
  // декоративные, при сбое остаётся последнее нарисованное. Обновления
  // пакетов — там же: снимок кэшируется на сервере 60 с, отдельный тик не нужен.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const [mRes, hRes, pRes] = await Promise.allSettled([
        fetchMetrics(profile.id),
        fetchMetricsHistory(profile.id),
        fetchPackages(profile.id),
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
      if (pRes.status === 'fulfilled') {
        setPackages(pRes.value);
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
