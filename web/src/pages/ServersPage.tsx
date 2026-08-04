import { useEffect, useState } from 'react';
import { fetchOverview } from '../api';
import type { OverviewResponse, OverviewServerEntry } from '../api';
import { Meter, formatBytes, formatPct, formatUptime } from './OverviewPage';

interface Props {
  showError: (msg: string) => void;
  visible: boolean;
  onOpenProfile: (profileId: string) => void;
}

const POLL_INTERVAL_MS = 5000;

/** Основной диск сервера: корень, иначе первый в списке. */
function mainDisk(entry: OverviewServerEntry) {
  const disks = entry.metrics?.disks ?? [];
  return disks.find((d) => d.mount === '/') ?? disks[0] ?? null;
}

function ServerCard({
  entry,
  onOpen,
}: {
  entry: OverviewServerEntry;
  onOpen: (profileId: string) => void;
}) {
  const mem = entry.metrics?.memory;
  const disk = mainDisk(entry);

  return (
    <button
      type="button"
      className={`overview-card server-card${entry.ok ? '' : ' down'}`}
      onClick={() => onOpen(entry.id)}
      title={`Открыть обзор ${entry.name}`}
    >
      <div className="server-card-head">
        <span className={`status-dot ${entry.ok ? 'connected' : 'error'}`} />
        <span className="server-name">{entry.name}</span>
        <span className="server-addr muted">
          {entry.host}:{entry.port}
        </span>
      </div>

      {entry.ok && entry.metrics ? (
        <>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>CPU</span>
              <span>{formatPct(entry.metrics.cpu.percent)}</span>
            </div>
            <Meter percent={entry.metrics.cpu.percent} />
          </div>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>Память</span>
              <span>
                {formatPct(mem?.usedPercent ?? null)} · {formatBytes(mem?.usedBytes ?? null)} из{' '}
                {formatBytes(mem?.totalBytes ?? null)}
              </span>
            </div>
            <Meter percent={mem?.usedPercent ?? null} />
          </div>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>Диск {disk ? disk.mount : ''}</span>
              <span>
                {disk
                  ? `${formatPct(disk.usedPercent)} · ${formatBytes(disk.usedBytes)} из ${formatBytes(disk.totalBytes)}`
                  : '—'}
              </span>
            </div>
            <Meter percent={disk?.usedPercent ?? null} />
          </div>
          <div className="server-card-footer">
            <span>Аптайм: {formatUptime(entry.metrics.uptimeSeconds)}</span>
            <span>
              {entry.docker
                ? `Контейнеры: ${entry.docker.containersRunning}/${entry.docker.containersTotal}`
                : 'Docker: нет данных'}
            </span>
          </div>
        </>
      ) : (
        <div className="server-error">Недоступен: {entry.error ?? 'нет данных'}</div>
      )}
    </button>
  );
}

export function ServersPage({ showError, visible, onOpenProfile }: Props) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Последовательный polling только на видимой вкладке (keep-alive):
  // ошибки запроса — в toast, последний снимок остаётся на экране.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await fetchOverview();
        if (cancelled) return;
        setData(res);
      } catch (err) {
        if (!cancelled) showError((err as Error).message);
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
  }, [visible, reloadKey, showError]);

  return (
    <div className="page servers-page">
      <div className="toolbar">
        <span className="status-text">
          {data
            ? `Обновлено ${new Date(data.timestamp).toLocaleTimeString('ru-RU')}`
            : 'Загрузка…'}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      <div className="overview-scroll">
        {data && data.servers.length === 0 && (
          <div className="empty-state">
            <p>Серверы не добавлены. Добавьте сервер через «Управление серверами» в левой панели.</p>
          </div>
        )}
        <div className="servers-grid">
          {(data?.servers ?? []).map((s) => (
            <ServerCard key={s.id} entry={s} onOpen={onOpenProfile} />
          ))}
        </div>
      </div>
    </div>
  );
}
