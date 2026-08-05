import { useEffect, useState } from 'react';
import { fetchPorts } from '../api';
import type { PortListener, PortsSnapshot, ContainerPortEntry, ContainerPortBinding } from '../api';
import type { Profile } from '../types';

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

function ContainerPortsSection({
  containers,
  filter,
}: {
  containers: ContainerPortEntry[];
  filter: string;
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
            </tr>
          </thead>
          <tbody>
            {filtered.flatMap((c) =>
              c.ports.map((b, i) => (
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
                </tr>
              )),
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
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

export function PortsPage({ profile, visible }: Props) {
  const [snapshot, setSnapshot] = useState<PortsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Последовательный polling: следующий запрос только после завершения
  // предыдущего. На скрытой вкладке (keep-alive) опрос полностью остановлен.
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

  const ports = (snapshot?.ports ?? []).filter((p) => matchesHostFilter(p, filter));
  const publicCount = (snapshot?.ports ?? []).filter((p) => p.scope === 'public').length;
  const containers = snapshot?.containers;
  const containersWithPorts = containers?.filter((c) => c.ports.length > 0);

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
            </span>
          )}
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
          <div className="ports-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-narrow">Протокол</th>
                  <th className="col-narrow">Порт</th>
                  <th>Адрес</th>
                  <th>Процесс</th>
                  <th className="col-narrow">PID</th>
                  <th className="col-narrow">Доступ</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((p) => (
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
                  </tr>
                ))}
                {snapshot && ports.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {filter.trim() ? 'Ничего не найдено по фильтру' : 'Прослушиваемых портов не найдено'}
                    </td>
                  </tr>
                )}
                {!snapshot && (
                  <tr>
                    <td colSpan={6} className="muted">
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

          {containersWithPorts && containersWithPorts.length > 0 && (
            <ContainerPortsSection containers={containersWithPorts} filter={filter} />
          )}
        </>
      )}
    </div>
  );
}
