import { useEffect, useState } from 'react';
import { fetchPorts } from '../api';
import type { PortListener, PortsSnapshot } from '../api';
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

function matchesFilter(p: PortListener, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return (
    p.proto.includes(q) ||
    p.host.toLowerCase().includes(q) ||
    String(p.port).includes(q) ||
    (p.process ?? '').toLowerCase().includes(q) ||
    (p.pid !== null && String(p.pid).includes(q))
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

  const ports = (snapshot?.ports ?? []).filter((p) => matchesFilter(p, filter));
  const publicCount = (snapshot?.ports ?? []).filter((p) => p.scope === 'public').length;

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
          placeholder="Фильтр: порт, адрес, процесс…"
        />
        <div className="toolbar-actions">
          {snapshot && (
            <span className="muted">
              {snapshot.ports.length} слушателей
              {publicCount > 0 ? ` · ${publicCount} наружу` : ''}
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
                    {p.process ?? <span className="muted">—</span>}
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
            колонка «Процесс» остаётся пустой.
          </p>
        </div>
      )}
    </div>
  );
}
