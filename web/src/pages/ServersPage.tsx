import { useEffect, useState } from 'react';
import { fetchBulkMetricsHistory, fetchOverview } from '../api';
import type { HistorySample, OverviewResponse, OverviewServerEntry } from '../api';
import type { AgentAskMode, Profile } from '../types';
import { Sparkline } from '../components/Sparkline';
import { SnippetsSection } from '../components/SnippetsSection';
import { Meter, formatBytes, formatPct, formatUptime } from './OverviewPage';
import { useT } from '../i18n';

interface Props {
  showError: (msg: string) => void;
  visible: boolean;
  onOpenProfile: (profileId: string) => void;
  onAskAgent: (text: string, mode?: AgentAskMode) => void;
  /** Профили из стейта App — цели запуска сниппетов (обзор бывает не загружен). */
  profiles: Profile[];
}

const POLL_INTERVAL_MS = 5000;

/** Основной диск сервера: корень, иначе первый в списке. */
function mainDisk(entry: OverviewServerEntry) {
  const disks = entry.metrics?.disks ?? [];
  return disks.find((d) => d.mount === '/') ?? disks[0] ?? null;
}

function ServerCard({
  entry,
  history,
  onOpen,
}: {
  entry: OverviewServerEntry;
  history: HistorySample[];
  onOpen: (profileId: string) => void;
}) {
  const { t } = useT();
  const mem = entry.metrics?.memory;
  const disk = mainDisk(entry);

  return (
    <button
      type="button"
      className={`overview-card server-card${entry.ok ? '' : ' down'}`}
      onClick={() => onOpen(entry.id)}
      title={t('servers.openOverview', { name: entry.name })}
    >
      <div className="server-card-head">
        <span className={`status-dot ${entry.ok ? 'connected' : 'error'}`} />
        <span className="server-name">{entry.name}</span>
        <span className="server-addr muted">
          {entry.host}:{entry.port}
        </span>
      </div>
      {entry.externalIp && (
        <div className="server-ip muted">{t('servers.externalIp')}: {entry.externalIp}</div>
      )}

      {entry.ok && entry.metrics ? (
        <>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>CPU</span>
              <span>{formatPct(entry.metrics.cpu.percent)}</span>
            </div>
            <Meter percent={entry.metrics.cpu.percent} />
            <Sparkline samples={history} value={(s) => s.cpu} tone="cpu" />
          </div>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>{t('servers.memory')}</span>
              <span>
                {formatPct(mem?.usedPercent ?? null)} · {formatBytes(mem?.usedBytes ?? null)} {t('common.of')}{' '}
                {formatBytes(mem?.totalBytes ?? null)}
              </span>
            </div>
            <Meter percent={mem?.usedPercent ?? null} />
            <Sparkline samples={history} value={(s) => s.memPct} tone="mem" />
          </div>
          <div className="server-metric">
            <div className="server-metric-head">
              <span>{t('servers.disk')} {disk ? disk.mount : ''}</span>
              <span>
                {disk
                  ? `${formatPct(disk.usedPercent)} · ${formatBytes(disk.usedBytes)} ${t('common.of')} ${formatBytes(disk.totalBytes)}`
                  : '—'}
              </span>
            </div>
            <Meter percent={disk?.usedPercent ?? null} />
          </div>
          <div className="server-card-footer">
            <span>{t('servers.uptime')}: {formatUptime(entry.metrics.uptimeSeconds)}</span>
            <span>
              {entry.docker
                ? `${t('servers.containers')}: ${entry.docker.containersRunning}/${entry.docker.containersTotal}`
                : t('servers.dockerNoData')}
            </span>
          </div>
        </>
      ) : (
        <div className="server-error">{t('servers.unavailable')}: {entry.error ?? t('servers.noData')}</div>
      )}
    </button>
  );
}

export function ServersPage({ showError, visible, onOpenProfile, onAskAgent, profiles }: Props) {
  const { t, locale } = useT();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [history, setHistory] = useState<Map<string, HistorySample[]>>(new Map());
  const [reloadKey, setReloadKey] = useState(0);

  // Последовательный polling только на видимой вкладке (keep-alive):
  // ошибки запроса — в toast, последний снимок остаётся на экране. История
  // нагрузки для спарклайнов грузится тем же тиком и падает тихо.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const [oRes, hRes] = await Promise.allSettled([fetchOverview(), fetchBulkMetricsHistory()]);
      if (cancelled) return;
      if (oRes.status === 'fulfilled') {
        setData(oRes.value);
      } else {
        showError((oRes.reason as Error).message);
      }
      if (hRes.status === 'fulfilled') {
        setHistory(new Map(hRes.value.profiles.map((p) => [p.id, p.samples])));
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
            ? t('common.updated', { time: new Date(data.timestamp).toLocaleTimeString(locale) })
            : t('common.loading')}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="overview-scroll">
        {data && data.servers.length === 0 && (
          <div className="empty-state">
            <p>{t('servers.empty')}</p>
          </div>
        )}
        <div className="servers-grid">
          {(data?.servers ?? []).map((s) => (
            <ServerCard key={s.id} entry={s} history={history.get(s.id) ?? []} onOpen={onOpenProfile} />
          ))}
        </div>

        <SnippetsSection
          showError={showError}
          onAskAgent={onAskAgent}
          profiles={profiles}
          servers={data?.servers ?? null}
        />
      </div>
    </div>
  );
}
