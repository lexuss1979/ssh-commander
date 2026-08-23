import { useEffect, useMemo, useState } from 'react';
import { fetchMetrics, fetchMetricsHistory } from '../api';
import type { HistorySample, ServerMetrics } from '../api';
import type { Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';
import { LoadChart } from '../components/Sparkline';
import { DiskUsageModal } from '../components/DiskUsageModal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  /** Переход на путь во вкладке «Файлы» (из навигатора «Что занимает»). */
  onOpenInFiles: (path: string) => void;
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

export function OverviewPage({ profile, visible, onOpenInFiles }: Props) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Навигатор «Что занимает»: точка монтирования выбранной строки диска.
  const [duTarget, setDuTarget] = useState<string | null>(null);

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
                    <button
                      className="btn btn-ghost btn-mini disk-whats-eating"
                      onClick={() => setDuTarget(d.mount)}
                      title="Что занимает место в этом каталоге"
                    >
                      Что занимает
                    </button>
                    <span className="sizes">
                      {formatBytes(d.usedBytes)} из {formatBytes(d.totalBytes)}
                    </span>
                  </div>
                  <Meter percent={d.usedPercent} />
                </div>
              ))}
            </div>
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
        </div>
      )}

      {duTarget !== null && (
        <DiskUsageModal
          key={duTarget}
          profile={profile}
          initialPath={duTarget}
          onClose={() => setDuTarget(null)}
          onOpenInFiles={onOpenInFiles}
        />
      )}
    </div>
  );
}
