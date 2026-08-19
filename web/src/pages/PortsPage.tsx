import { useEffect, useMemo, useState } from 'react';
import { fetchPorts, fetchTunnels, createTunnel, deleteTunnel } from '../api';
import type {
  PortListener,
  PortsSnapshot,
  ContainerPortEntry,
  ContainerPortBinding,
  Tunnel,
} from '../api';
import type { Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;

const SCOPE_LABEL: Record<PortListener['scope'], string> = {
  public: 'наружу',
  loopback: 'локально',
  interface: 'интерфейс',
};

function matchesHostFilter(p: PortListener, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return (
    p.proto.includes(q) ||
    p.host.toLowerCase().includes(q) ||
    String(p.port).includes(q) ||
    (p.process ?? '').toLowerCase().includes(q) ||
    (p.pid !== null && String(p.pid).includes(q)) ||
    (p.container?.name ?? '').toLowerCase().includes(q)
  );
}

function matchesContainerFilter(c: ContainerPortEntry, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.containerId.toLowerCase().includes(q) ||
    (c.ip ?? '').toLowerCase().includes(q) ||
    c.ports.some((b) =>
      String(b.containerPort).includes(q) ||
      String(b.hostPort ?? '').includes(q) ||
      b.proto.includes(q),
    )
  );
}

function containerAccessLabel(b: ContainerPortBinding, networkMode: string): string {
  if (networkMode === 'host') return 'сеть хоста';
  if (b.hostPort !== null) {
    const ip = b.hostIp && b.hostIp !== '0.0.0.0' ? `${b.hostIp}:` : '';
    return `опубликован на ${ip}${b.hostPort}`;
  }
  return 'только сеть контейнера';
}

// Модалка создания туннеля
function TunnelModal({
  onClose,
  onCreate,
  portRange,
  prefill,
}: {
  onClose: () => void;
  onCreate: (params: { localPort: number; targetHost: string; targetPort: number }) => Promise<void>;
  portRange: { min: number; max: number };
  prefill?: { targetHost: string; targetPort: number };
}) {
  const [localPort, setLocalPort] = useState('0');
  const [targetHost, setTargetHost] = useState(prefill?.targetHost ?? '');
  const [targetPort, setTargetPort] = useState(prefill?.targetPort ? String(prefill.targetPort) : '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    try {
      await onCreate({
        localPort: Number(localPort),
        targetHost,
        targetPort: Number(targetPort),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Проброс порта (SSH-туннель)</h2>
        <div className="modal-body">
          <label>
            Локальный порт (0 = авто):
            <input
              type="number"
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              min={0}
              max={65535}
              placeholder="0"
            />
            <span className="muted" style={{ fontSize: 12 }}>
              {' '}Диапазон: {portRange.min}–{portRange.max}
            </span>
          </label>
          <label>
            Целевой хост:
            <input
              type="text"
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="172.17.0.2 или localhost"
            />
          </label>
          <label>
            Целевой порт:
            <input
              type="number"
              value={targetPort}
              onChange={(e) => setTargetPort(e.target.value)}
              min={1}
              max={65535}
              placeholder="8080"
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Туннель слушает на 127.0.0.1 и перенаправляет трафик через SSH к целевому хосту.
            UDP не поддерживается.
          </p>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={loading}>
            Отмена
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Создание…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Секция активных туннелей
function TunnelsSection({
  tunnels,
  onStop,
}: {
  tunnels: Tunnel[];
  onStop: (id: string) => void;
}) {
  if (tunnels.length === 0) return null;

  return (
    <div className="tunnels-section">
      <h3 className="section-title">Активные туннели</h3>
      <div className="ports-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Локально</th>
              <th>→</th>
              <th>Удалённо</th>
              <th className="col-narrow">Статус</th>
              <th className="col-narrow">Действия</th>
            </tr>
          </thead>
          <tbody>
            {tunnels.map((t) => (
              <tr key={t.id} className={t.status === 'closed' ? 'tunnel-closed' : ''}>
                <td className="tunnel-local">
                  <a href={`http://127.0.0.1:${t.localPort}`} target="_blank" rel="noopener noreferrer">
                    127.0.0.1:{t.localPort}
                  </a>
                </td>
                <td className="tunnel-arrow">→</td>
                <td className="tunnel-target">
                  {t.targetHost}:{t.targetPort}
                </td>
                <td>
                  <span className={`status-dot ${t.status === 'active' ? 'connected' : 'error'}`} />
                  {t.status === 'closed' && t.error && (
                    <span className="muted" title={t.error}> ошибка</span>
                  )}
                </td>
                <td>
                  {t.status === 'active' ? (
                    <button className="btn btn-ghost btn-small" onClick={() => onStop(t.id)}>
                      Стоп
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-small" onClick={() => onStop(t.id)}>
                      Удалить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContainerPortsSection({
  containers,
  filter,
  onForward,
}: {
  containers: ContainerPortEntry[];
  filter: string;
  onForward: (targetHost: string, targetPort: number) => void;
}) {
  const filtered = containers.filter((c) => matchesContainerFilter(c, filter));

  if (containers.length === 0) return null;

  return (
    <div className="container-ports-section">
      <h3 className="section-title">Порты контейнеров</h3>
      <div className="ports-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Контейнер</th>
              <th className="col-narrow">IP</th>
              <th className="col-narrow">Порт</th>
              <th className="col-narrow">Протокол</th>
              <th>Доступ</th>
              <th className="col-narrow"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.flatMap((c) =>
              c.ports.map((b, i) => {
                const targetHost = c.networkMode === 'host' ? 'localhost' : (c.ip ?? 'localhost');
                const isTcp = b.proto === 'tcp';
                return (
                  <tr key={`${c.containerId}-${b.containerPort}-${b.proto}-${i}`}>
                    <td className="container-name" title={c.containerId}>
                      {i === 0 ? c.name : ''}
                      {i === 0 && c.networkMode === 'host' && (
                        <span className="muted container-host-badge"> host</span>
                      )}
                    </td>
                    <td>{i === 0 ? (c.ip ?? '—') : ''}</td>
                    <td className="port-num">{b.containerPort}</td>
                    <td className="port-proto">{b.proto}</td>
                    <td>
                      <span className="container-access">
                        {containerAccessLabel(b, c.networkMode)}
                      </span>
                    </td>
                    <td>
                      {isTcp ? (
                        <button
                          className="btn btn-ghost btn-small"
                          onClick={() => onForward(targetHost, b.containerPort)}
                          title="Пробросить порт"
                        >
                          Пробросить
                        </button>
                      ) : (
                        <span className="muted" title="SSH-туннели только TCP">—</span>
                      )}
                    </td>
                  </tr>
                );
              }),
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Ничего не найдено по фильтру
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted ports-hint">
        Контейнеры с host-сетью видны в основной таблице слушателей.
      </p>
    </div>
  );
}

export function PortsPage({ profile, visible, showError }: Props) {
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Туннели
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [portRange, setPortRange] = useState({ min: 10000, max: 10049 });
  const [showTunnelModal, setShowTunnelModal] = useState(false);
  const [tunnelPrefill, setTunnelPrefill] = useState<{ targetHost: string; targetPort: number } | undefined>();

  // Polling портов
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await fetchPorts(profile.id);
        if (cancelled) return;
        setSnapshot(s);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
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

  // Polling туннелей
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const res = await fetchTunnels(profile.id);
        if (cancelled) return;
        setTunnels(res.tunnels);
        setPortRange(res.portRange);
      } catch {
        // Туннели — опционально, не блокируем UI.
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

  const handleForward = (targetHost: string, targetPort: number) => {
    setTunnelPrefill({ targetHost, targetPort });
    setShowTunnelModal(true);
  };

  const handleCreateTunnel = async (params: { localPort: number; targetHost: string; targetPort: number }) => {
    await createTunnel(profile.id, params);
    setReloadKey((k) => k + 1);
  };

  const handleStopTunnel = async (id: string) => {
    try {
      await deleteTunnel(id);
      setReloadKey((k) => k + 1);
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const portsFiltered = (snapshot?.ports ?? []).filter((p) => matchesHostFilter(p, filter));
  const publicCount = (snapshot?.ports ?? []).filter((p) => p.scope === 'public').length;
  const containers = snapshot?.containers;
  const containersWithPorts = containers?.filter((c) => c.ports.length > 0);
  const activeTunnels = tunnels.filter((t) => t.status === 'active');

  const portAccessors = useMemo(() => ({
    proto: (p: PortListener) => p.proto,
    port: (p: PortListener) => p.port,
    host: (p: PortListener) => p.host,
    process: (p: PortListener) => p.process ?? '',
    pid: (p: PortListener) => p.pid ?? 0,
    scope: (p: PortListener) => p.scope,
  }), []);
  const { sort: portSort, toggle: togglePortSort, sorted: ports } = useSortBy(portsFiltered, portAccessors, { key: 'port', dir: 'asc' });

  return (
    <div className="page ports-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? `Нет связи: ${error}`
            : snapshot
              ? `Обновлено ${new Date(snapshot.timestamp).toLocaleTimeString('ru-RU')}`
              : 'Загрузка…'}
        </span>
        <input
          className="search-input ports-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Фильтр: порт, адрес, процесс, контейнер…"
        />
        <div className="toolbar-actions">
          {snapshot && (
            <span className="muted">
              {snapshot.ports.length} слушателей
              {publicCount > 0 ? ` · ${publicCount} наружу` : ''}
              {containersWithPorts ? ` · ${containersWithPorts.length} контейнеров` : ''}
              {activeTunnels.length > 0 ? ` · ${activeTunnels.length} туннелей` : ''}
            </span>
          )}
          <button className="btn btn-ghost" onClick={() => setShowTunnelModal(true)}>
            Проброс порта
          </button>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {error && !snapshot ? (
        <div className="empty-state">
          <p>Сервер недоступен: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <>
          {/* Активные туннели */}
          <TunnelsSection tunnels={tunnels} onStop={handleStopTunnel} />

          {/* Основная таблица хостовых портов */}
          <div className="ports-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh sortKey="proto" currentSort={portSort} onToggle={togglePortSort} className="col-narrow">Протокол</SortableTh>
                  <SortableTh sortKey="port" currentSort={portSort} onToggle={togglePortSort} className="col-narrow">Порт</SortableTh>
                  <SortableTh sortKey="host" currentSort={portSort} onToggle={togglePortSort}>Адрес</SortableTh>
                  <SortableTh sortKey="process" currentSort={portSort} onToggle={togglePortSort}>Процесс</SortableTh>
                  <SortableTh sortKey="pid" currentSort={portSort} onToggle={togglePortSort} className="col-narrow">PID</SortableTh>
                  <SortableTh sortKey="scope" currentSort={portSort} onToggle={togglePortSort} className="col-narrow">Доступ</SortableTh>
                  <th className="col-narrow"></th>
                </tr>
              </thead>
              <tbody>
                {ports.map((p) => {
                  const isTcp = p.proto === 'tcp';
                  const targetHost = p.host === '0.0.0.0' || p.host === '::' ? 'localhost' : p.host;
                  return (
                    <tr key={`${p.proto}-${p.host}-${p.port}`} className={p.scope === 'public' ? 'port-public' : ''}>
                      <td className="port-proto">{p.proto}</td>
                      <td className="port-num">{p.port}</td>
                      <td className="port-host" title={p.host}>{p.host}</td>
                      <td className="port-process" title={p.process ?? undefined}>
                        {p.container
                          ? <span className="docker-process" title={`Контейнер ${p.container.name}`}>docker: {p.container.name}</span>
                          : (p.process ?? <span className="muted">—</span>)}
                      </td>
                      <td>{p.pid ?? '—'}</td>
                      <td>
                        <span className={`scope-badge ${p.scope}`}>{SCOPE_LABEL[p.scope]}</span>
                      </td>
                      <td>
                        {isTcp ? (
                          <button
                            className="btn btn-ghost btn-small"
                            onClick={() => handleForward(targetHost, p.port)}
                            title="Пробросить порт"
                          >
                            Пробросить
                          </button>
                        ) : (
                          <span className="muted" title="SSH-туннели только TCP">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {snapshot && ports.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      {filter.trim() ? 'Ничего не найдено по фильтру' : 'Прослушиваемых портов не найдено'}
                    </td>
                  </tr>
                )}
                {!snapshot && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Загрузка…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="muted ports-hint">
              Имена процессов других пользователей видны только при подключении под root — без прав
              колонка «Процесс» остаётся пустой. Опубликованные порты контейнеров видны как
              безымянный docker-proxy — аннотация «docker: …» закрывает эту дыру.
            </p>
          </div>

          {/* Порты контейнеров */}
          {containersWithPorts && containersWithPorts.length > 0 && (
            <ContainerPortsSection
              containers={containersWithPorts}
              filter={filter}
              onForward={handleForward}
            />
          )}
        </>
      )}

      {/* Модалка создания туннеля */}
      {showTunnelModal && (
        <TunnelModal
          onClose={() => {
            setShowTunnelModal(false);
            setTunnelPrefill(undefined);
          }}
          onCreate={handleCreateTunnel}
          portRange={portRange}
          prefill={tunnelPrefill}
        />
      )}
    </div>
  );
}
