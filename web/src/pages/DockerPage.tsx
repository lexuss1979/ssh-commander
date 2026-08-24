import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { DockerEntity, Profile } from '../types';
import { Modal } from '../components/Modal';
import { useSortBy, SortableTh } from '../hooks/useSortBy';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  onExecContainer: (id: string, name: string) => void;
}

type Section = 'containers' | 'images' | 'volumes' | 'networks' | 'compose';
type ContainerAction = 'start' | 'stop' | 'restart' | 'rm';
type PruneTarget = 'containers' | 'images' | 'volumes' | 'system';

interface ComposeStatus {
  available: boolean;
  kind: 'v2' | 'v1' | null;
}

// Лимит буфера логов в LogsModal (~500 КБ текста).
const LOG_BUFFER_LIMIT = 500 * 1024;

const PRUNE_LABELS: Record<PruneTarget, string> = {
  containers: 'все остановленные контейнеры',
  images: 'все dangling-образы (без тега и не используемые)',
  volumes: 'все неиспользуемые volumes — данные будут потеряны',
  system: 'остановленные контейнеры, неиспользуемые сети, dangling-образы и кэш сборки',
};

function q(profileId: string): string {
  return `?profileId=${encodeURIComponent(profileId)}`;
}

// ---------------------------------------------------------------------------
// Чистые хелперы таблицы контейнеров (парсинг docker-строк) — держим вне
// компонента, чтобы не ре-создавать на каждый рендер и иметь под тесты.
// ---------------------------------------------------------------------------

/** Максимум символов отображаемого имени образа до обрезки (полный — в title). */
const IMAGE_MAX_CHARS = 50;

const UPTIME_UNIT_RU: Record<string, string> = {
  year: 'г',
  month: 'мес',
  week: 'нед',
  day: 'дн',
  hour: 'ч',
  minute: 'мин',
  second: 'с',
};

/** Статус контейнера → класс точки. running — зелёная, restarting — жёлтая, иначе нейтральная. */
function containerDotClass(status: string, running: boolean): string {
  if (running) return 'running';
  if (/^Restarting/i.test(status.trim())) return 'pending';
  return 'stopped';
}

/** Короткий текст статуса для не-работающего контейнера (вместо аптайма). */
function containerStatusLabel(status: string): string {
  const s = status.trim();
  if (/^Exited/i.test(s)) return 'остановлен';
  if (/^Restarting/i.test(s)) return 'перезапуск';
  if (/^Paused/i.test(s)) return 'приостановлен';
  if (/^Created/i.test(s)) return 'создан';
  if (/^Dead/i.test(s)) return 'недоступен';
  return s;
}

/** «Up 6 months (healthy)» → «6 мес». `About an hour` → «≈1 ч». null — не запущен. */
function containerUptimeLabel(status: string): string | null {
  const m = /^Up\s+(.+?)(?:\s*\(.*\))?$/i.exec(status.trim());
  if (!m) return null;
  let d = m[1].trim();
  let approx = false;
  const about = /^about\s+an?\s+/i.test(d);
  if (about) {
    approx = true;
    d = d.replace(/^about\s+an?\s+/i, '');
  }
  const base = d.match(/^(\d+)?\s*([a-z]+)$/i);
  if (!base) return status;
  const n = base[1] ?? '1';
  const ru = UPTIME_UNIT_RU[base[2].toLowerCase().replace(/s$/, '')] ?? base[2];
  return approx ? `≈${n} ${ru}` : `${n} ${ru}`;
}

/** Слушающий наружу (не loopback, не wildcard) → public (подсветка warn). */
function isPublicBind(host: string): boolean {
  const ip = host.slice(0, host.lastIndexOf(':'));
  if (ip === '0.0.0.0' || ip === '::' || ip === '[::]') return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '[::1]') return false;
  return ip !== '';
}

/** «0.0.0.0:5601->5601/tcp, :::5601->5601/tcp» → чипы. Без `->` — порт только в сети. */
function parseDockerPorts(ports: string): Array<{ text: string; pub: boolean }> {
  if (!ports) return [];
  return ports
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const arrow = part.indexOf('->');
      if (arrow === -1) return { text: part, pub: false };
      const host = part.slice(0, arrow).trim();
      const target = part.slice(arrow + 2).trim();
      return { text: `${host} → ${target}`, pub: isPublicBind(host) };
    });
}

/** Процент → цвет бара (как в метриках «Обзора»): >=90 danger, >=75 warn. */
function meterClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 90) return ' danger';
  if (pct >= 75) return ' warn';
  return '';
}

/** NaN (нет stats) → null, чтобы meterClass не считал его цветным. */
function numberOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** Ширина бара: NaN/отрицательное → 0, >100 → 100. */
function pctWidth(n: number): string {
  const v = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  return `${v}%`;
}

export function DockerPage({ profile, showError, visible, onExecContainer }: Props) {
  const [section, setSection] = useState<Section>('containers');
  const [containers, setContainers] = useState<DockerEntity[]>([]);
  const [images, setImages] = useState<DockerEntity[]>([]);
  const [volumes, setVolumes] = useState<DockerEntity[]>([]);
  const [networks, setNetworks] = useState<DockerEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [pullImageName, setPullImageName] = useState('');
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);
  const [stats, setStats] = useState<Record<string, DockerEntity>>({});
  const [statsFailed, setStatsFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | null>(null);
  const [composeStatus, setComposeStatus] = useState<ComposeStatus | null>(null);
  const [composePath, setComposePath] = useState(() => {
    try {
      return localStorage.getItem(`sc-compose-path:${profile.id}`) ?? '';
    } catch {
      return '';
    }
  });
  const [composeServices, setComposeServices] = useState<DockerEntity[]>([]);
  const [composeBusy, setComposeBusy] = useState(false);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 8000);
  }, []);

  const saveComposePath = (p: string) => {
    setComposePath(p);
    try {
      localStorage.setItem(`sc-compose-path:${profile.id}`, p);
    } catch {
      /* localStorage может быть недоступен */
    }
  };

  const loadComposePs = useCallback(
    async (path: string) => {
      if (!path.trim()) return;
      setLoading(true);
      try {
        setComposeServices(
          await api<DockerEntity[]>(
            `/api/docker/compose/ps${q(profile.id)}&path=${encodeURIComponent(path.trim())}`,
          ),
        );
      } catch (err) {
        setComposeServices([]);
        showError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [profile.id, showError],
  );

  const load = useCallback(
    async (sec: Section = section) => {
      if (sec === 'compose') {
        try {
          const status = composeStatus ?? (await api<ComposeStatus>(`/api/docker/compose/status${q(profile.id)}`));
          setComposeStatus(status);
          if (status.available && status.kind === 'v2' && composePath.trim()) {
            await loadComposePs(composePath);
          }
        } catch (err) {
          showError((err as Error).message);
        }
        return;
      }
      setLoading(true);
      try {
        if (sec === 'containers') {
          setContainers(await api<DockerEntity[]>(`/api/docker/containers${q(profile.id)}`));
        } else if (sec === 'images') {
          setImages(await api<DockerEntity[]>(`/api/docker/images${q(profile.id)}`));
        } else if (sec === 'volumes') {
          setVolumes(await api<DockerEntity[]>(`/api/docker/volumes${q(profile.id)}`));
        } else {
          setNetworks(await api<DockerEntity[]>(`/api/docker/networks${q(profile.id)}`));
        }
      } catch (err) {
        showError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [profile.id, section, showError, composeStatus, composePath, loadComposePs],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, section]);

  // Снимок docker stats polling'ом 3 с; только когда вкладка видима и
  // активна секция контейнеров. Если stats недоступен — отключаемся тихо.
  const statsActive = visible && section === 'containers' && !statsFailed;
  useEffect(() => {
    if (!statsActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const rows = await api<DockerEntity[]>(`/api/docker/stats${q(profile.id)}`);
        if (cancelled) return;
        const map: Record<string, DockerEntity> = {};
        for (const row of rows) {
          if (row.Name) map[String(row.Name)] = row;
          if (row.Container) map[String(row.Container)] = row;
        }
        setStats(map);
      } catch {
        if (!cancelled) setStatsFailed(true);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [statsActive, profile.id]);

  const runPrune = async (target: PruneTarget) => {
    if (!window.confirm(`Очистка удалит: ${PRUNE_LABELS[target]}.\nПродолжить?`)) return;
    try {
      const res = await api<{ output: string }>('/api/docker/prune', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, target }),
      });
      const reclaimed = /Total reclaimed space:\s*(.+)/.exec(res.output)?.[1];
      showNotice(reclaimed ? `Освобождено: ${reclaimed}` : res.output || 'Очистка завершена');
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const reconnect = async () => {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}/reconnect`, { method: 'POST' });
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const composeAction = async (action: 'up' | 'down') => {
    const path = composePath.trim();
    if (!path) {
      showError('Укажите путь к проекту (каталог с compose-файлом)');
      return;
    }
    if (action === 'down' && !window.confirm(`Остановить проект и удалить его контейнеры/сети (compose down) в ${path}?`)) return;
    setComposeBusy(true);
    try {
      await api(`/api/docker/compose/${action}`, {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, path }),
      });
      showNotice(action === 'up' ? 'Проект запущен (up -d)' : 'Проект остановлен (down)');
      await loadComposePs(path);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setComposeBusy(false);
    }
  };

  const containerAction = async (id: string, action: ContainerAction, name: string) => {
    const labels: Record<ContainerAction, string> = {
      start: 'Запустить',
      stop: 'Остановить',
      restart: 'Перезапустить',
      rm: 'Удалить (rm -f)',
    };
    if (!window.confirm(`${labels[action]} контейнер «${name}»?`)) return;
    try {
      await api(`/api/docker/containers/${encodeURIComponent(id)}/${action}${q(profile.id)}`, { method: 'POST' });
      void load('containers');
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const pullImage = async () => {
    if (!pullImageName.trim()) return;
    try {
      await api('/api/docker/images/pull', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, image: pullImageName.trim() }),
      });
      setPullImageName('');
      void load('images');
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const removeImage = async (id: string, tag: string) => {
    if (!window.confirm(`Удалить образ ${tag}?`)) return;
    try {
      await api(`/api/docker/images/${encodeURIComponent(id)}/remove${q(profile.id)}`, { method: 'POST' });
      void load('images');
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const removeVolume = async (name: string) => {
    if (!window.confirm(`Удалить volume «${name}»? Данные будут потеряны.`)) return;
    try {
      await api(`/api/docker/volumes/${encodeURIComponent(name)}/remove${q(profile.id)}`, { method: 'POST' });
      void load('volumes');
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const removeNetwork = async (name: string) => {
    if (!window.confirm(`Удалить сеть «${name}»?`)) return;
    try {
      await api(`/api/docker/networks/${encodeURIComponent(name)}/remove${q(profile.id)}`, { method: 'POST' });
      void load('networks');
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const shortId = (id: unknown): string => String(id ?? '').slice(0, 12);

  const containerAccessors = useMemo(() => ({
    name: (c: DockerEntity) => String(c.Names ?? c.ID ?? '').replace(/^\//, '').toLowerCase(),
    ports: (c: DockerEntity) => String(c.Ports ?? ''),
  }), []);
  const { sort: containerSort, toggle: toggleContainerSort, sorted: sortedContainers } = useSortBy(containers, containerAccessors, { key: 'name', dir: 'asc' });

  return (
    <div className="page">
      <div className="toolbar">
        <div className="tabs">
          {(
            [
              ['containers', 'Контейнеры'],
              ['images', 'Образы'],
              ['volumes', 'Volumes'],
              ['networks', 'Сети'],
              ['compose', 'Compose'],
            ] as Array<[Section, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab ${section === id ? 'active' : ''}`}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          {section === 'containers' && (
            <button className="btn" onClick={() => setRunOpen(true)}>+ Запустить</button>
          )}
          {(section === 'containers' || section === 'images' || section === 'volumes') && (
            <button className="btn" onClick={() => void runPrune(section)}>Очистка</button>
          )}
          {section !== 'compose' && (
            <button
              className="btn btn-ghost"
              title="System prune: контейнеры, сети, dangling-образы, кэш сборки"
              onClick={() => void runPrune('system')}
            >
              Полная очистка
            </button>
          )}
          {section === 'images' && (
            <label className="inline-form">
              <input
                value={pullImageName}
                onChange={(e) => setPullImageName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void pullImage()}
                placeholder="nginx:latest"
              />
              <button className="btn" onClick={() => void pullImage()}>Pull</button>
            </label>
          )}
          <button className="btn btn-ghost" onClick={() => void load()}>Обновить</button>
          <button
            className="btn btn-ghost"
            title="Переустановить SSH-подключение (применить новые группы и права)"
            onClick={() => void reconnect()}
          >
            Переподключить
          </button>
        </div>
      </div>

      <div className="table-wrap">
        {section === 'containers' && (
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh sortKey="name" currentSort={containerSort} onToggle={toggleContainerSort}>Имя</SortableTh>
                <th>CPU</th>
                <th>Память</th>
                <SortableTh sortKey="ports" currentSort={containerSort} onToggle={toggleContainerSort}>Порты</SortableTh>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Загрузка…</td></tr>}
              {!loading && sortedContainers.length === 0 && <tr><td colSpan={5} className="muted">Контейнеров нет</td></tr>}
              {sortedContainers.map((c) => {
                const id = String(c.ID ?? c.ContainerID ?? '');
                const name = String(c.Names ?? id).replace(/^\//, '');
                const status = String(c.Status ?? '');
                const running = String(c.State ?? '').toLowerCase() === 'running' || /^Up /.test(status);
                const image = String(c.Image ?? '');
                const st = stats[name] ?? stats[shortId(id)];
                const cpuPct = st ? parseFloat(String(st.CPUPerc ?? '')) : NaN;
                const memPct = st ? parseFloat(String(st.MemPerc ?? '')) : NaN;
                const ports = parseDockerPorts(String(c.Ports ?? ''));
                const uptime = running ? containerUptimeLabel(status) : null;
                return (
                  <tr key={id}>
                    <td>
                      <div className="cell-main">
                        <div className="cell-top">
                          <span className={`status-dot ${containerDotClass(status, running)}`} title={status} />
                          <span className="uptime">{uptime ?? containerStatusLabel(status)}</span>
                          <span className="cell-id">ID: {shortId(id)}</span>
                        </div>
                        <span className="name">{name}</span>
                        <span className="image" title={image}>
                          {image.length > IMAGE_MAX_CHARS ? `${image.slice(0, IMAGE_MAX_CHARS)}…` : image}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="cell-metric">
                        <span className="num mono">{st ? String(st.CPUPerc ?? '—') : '—'}</span>
                        <div className="meter">
                          <div className={`meter-fill${meterClass(numberOrNull(cpuPct))}`} style={{ width: pctWidth(cpuPct) }} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="cell-metric">
                        <span className="num mono">{st ? String(st.MemUsage ?? '—') : '—'}</span>
                        <div className="meter">
                          <div className={`meter-fill${meterClass(numberOrNull(memPct))}`} style={{ width: pctWidth(memPct) }} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="port-list">
                        {ports.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          ports.map((p, i) => (
                            <span key={i} className={`port-chip${p.pub ? ' public' : ''}`}>{p.text}</span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button className="btn btn-mini icon-btn btn-primary" onClick={() => void containerAction(id, 'restart', name)} title="Перезапустить">↻</button>
                        <button className="btn btn-mini icon-btn btn-danger" onClick={() => void containerAction(id, 'stop', name)} title="Остановить">■</button>
                        <span className="action-sep" />
                        <button className="btn btn-mini icon-btn btn-ghost" onClick={() => onExecContainer(id, name)} title="Терминал в контейнере">❯</button>
                        <button className="btn btn-mini icon-btn btn-ghost" onClick={() => setLogsTarget({ id, name })} title="Логи">≡</button>
                        <button className="btn btn-mini icon-btn btn-ghost" onClick={() => void containerAction(id, 'rm', name)} title="Удалить">✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {section === 'images' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Репозиторий</th>
                <th>Тег</th>
                <th>Размер</th>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="muted">Загрузка…</td></tr>}
              {!loading && images.length === 0 && <tr><td colSpan={5} className="muted">Образов нет</td></tr>}
              {images.map((img) => {
                const id = String(img.ID ?? '');
                return (
                  <tr key={`${id}-${String(img.Tag ?? '')}`}>
                    <td className="mono">{shortId(id)}</td>
                    <td>{String(img.Repository ?? '')}</td>
                    <td>{String(img.Tag ?? '')}</td>
                    <td>{String(img.Size ?? '')}</td>
                    <td className="col-actions">
                      <button
                        className="btn btn-mini btn-danger"
                        onClick={() => void removeImage(id, `${String(img.Repository ?? '')}:${String(img.Tag ?? '')}`)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {section === 'volumes' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Driver</th>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={3} className="muted">Загрузка…</td></tr>}
              {!loading && volumes.length === 0 && <tr><td colSpan={3} className="muted">Volumes нет</td></tr>}
              {volumes.map((v) => (
                <tr key={String(v.Name ?? '')}>
                  <td>{String(v.Name ?? '')}</td>
                  <td>{String(v.Driver ?? '')}</td>
                  <td className="col-actions">
                    <button className="btn btn-mini btn-danger" onClick={() => void removeVolume(String(v.Name ?? ''))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {section === 'networks' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Driver</th>
                <th>Scope</th>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="muted">Загрузка…</td></tr>}
              {!loading && networks.length === 0 && <tr><td colSpan={4} className="muted">Сетей нет</td></tr>}
              {networks.map((n) => (
                <tr key={String(n.Name ?? '')}>
                  <td>{String(n.Name ?? '')}</td>
                  <td>{String(n.Driver ?? '')}</td>
                  <td>{String(n.Scope ?? '')}</td>
                  <td className="col-actions">
                    <button className="btn btn-mini btn-danger" onClick={() => void removeNetwork(String(n.Name ?? ''))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {section === 'compose' && (
          <div className="compose-section">
            {!composeStatus && <div className="muted">Проверка доступности Docker Compose…</div>}
            {composeStatus && !composeStatus.available && (
              <div className="compose-unavailable">
                Docker Compose не найден на сервере — секция недоступна.
              </div>
            )}
            {composeStatus?.available && composeStatus.kind === 'v1' && (
              <div className="compose-unavailable">
                Найден только docker-compose (v1). Поддерживается Compose v2
                (плагин <code>docker compose</code>) — обновите Docker на сервере.
              </div>
            )}
            {composeStatus?.available && composeStatus.kind === 'v2' && (
              <>
                <div className="compose-controls">
                  <input
                    className="compose-path"
                    value={composePath}
                    onChange={(e) => saveComposePath(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void loadComposePs(composePath)}
                    placeholder="/srv/my-project — каталог с compose-файлом"
                  />
                  <button
                    className="btn btn-primary"
                    disabled={composeBusy || !composePath.trim()}
                    onClick={() => void composeAction('up')}
                  >
                    Запустить (up -d)
                  </button>
                  <button
                    className="btn"
                    disabled={composeBusy || !composePath.trim()}
                    onClick={() => void composeAction('down')}
                  >
                    Остановить (down)
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={!composePath.trim()}
                    onClick={() => void loadComposePs(composePath)}
                  >
                    Обновить
                  </button>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Сервис</th>
                      <th>Имя</th>
                      <th>State</th>
                      <th>Статус</th>
                      <th>Порты</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && <tr><td colSpan={5} className="muted">Загрузка…</td></tr>}
                    {!loading && composeServices.length === 0 && (
                      <tr><td colSpan={5} className="muted">
                        {composePath.trim() ? 'Сервисов нет (проект не запущен?)' : 'Укажите путь к проекту'}
                      </td></tr>
                    )}
                    {composeServices.map((s) => (
                      <tr key={String(s.Name ?? s.ID ?? '')}>
                        <td>{String(s.Service ?? '')}</td>
                        <td className="mono">{String(s.Name ?? '')}</td>
                        <td>{String(s.State ?? '')}</td>
                        <td>{String(s.Status ?? '')}</td>
                        <td className="mono">{String(s.Ports ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>

      {runOpen && (
        <RunContainerModal
          profile={profile}
          onClose={() => setRunOpen(false)}
          onDone={() => {
            setRunOpen(false);
            void load('containers');
          }}
          showError={showError}
        />
      )}

      {logsTarget && (
        <LogsModal
          profile={profile}
          target={logsTarget}
          visible={visible}
          onClose={() => setLogsTarget(null)}
          showError={showError}
        />
      )}

      {notice && <div className="toast toast-notice">{notice}</div>}
    </div>
  );
}

function RunContainerModal({ profile, onClose, onDone, showError }: {
  profile: Profile;
  onClose: () => void;
  onDone: () => void;
  showError: (msg: string) => void;
}) {
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [ports, setPorts] = useState('');
  const [env, setEnv] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!image.trim()) {
      showError('Укажите образ');
      return;
    }
    setBusy(true);
    try {
      await api('/api/docker/containers', {
        method: 'POST',
        body: JSON.stringify({
          profileId: profile.id,
          image: image.trim(),
          name: name.trim() || undefined,
          ports: ports.split('\n').map((s) => s.trim()).filter(Boolean),
          env: env.split('\n').map((s) => s.trim()).filter(Boolean),
          command: command.trim() || undefined,
        }),
      });
      onDone();
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Запустить контейнер" onClose={onClose}>
      <div className="form-grid">
        <label className="span-2">
          Образ
          <input autoFocus value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:latest" />
        </label>
        <label className="span-2">
          Имя (необязательно)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
        </label>
        <label className="span-2">
          Порты (по одному на строку)
          <textarea rows={3} value={ports} onChange={(e) => setPorts(e.target.value)} placeholder={'8080:80\n127.0.0.1:3000:3000'} />
        </label>
        <label className="span-2">
          Переменные окружения (KEY=VALUE, по одной на строку)
          <textarea rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="MODE=production" />
        </label>
        <label className="span-2">
          Команда (необязательно)
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm start" />
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Запуск…' : 'Запустить -d'}
        </button>
        <button className="btn" onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

function LogsModal({ profile, target, visible, onClose, showError }: {
  profile: Profile;
  target: { id: string; name: string };
  visible: boolean;
  onClose: () => void;
  showError: (msg: string) => void;
}) {
  const [follow, setFollow] = useState(false);
  const [started, setStarted] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const append = (text: string) => {
    const el = preRef.current;
    if (!el) return;
    let next = (el.textContent ?? '') + text;
    // Буфер не растёт бесконечно: держим хвост ~500 КБ, отрезая по границе строки.
    if (next.length > LOG_BUFFER_LIMIT) {
      const nl = next.indexOf('\n', next.length - LOG_BUFFER_LIMIT);
      next = next.slice(nl >= 0 ? nl + 1 : next.length - LOG_BUFFER_LIMIT);
    }
    el.textContent = next;
    el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    // Вкладка скрыта (keep-alive) — стрим логов на паузе, возобновится при возврате.
    if (!visible) return;
    const params = new URLSearchParams({ profileId: profile.id, tail: '200' });
    if (follow) params.set('stream', '1');
    let cancelled = false;
    const controller = new AbortController();
    setStarted(true);
    // Перезапуск стрима (смена follow, возврат на вкладку) — начинаем с чистого буфера.
    if (preRef.current) preRef.current.textContent = '';

    void fetch(`/api/docker/containers/${encodeURIComponent(target.id)}/logs?${params}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          let message = res.statusText;
          try {
            message = (await res.json()).error ?? message;
          } catch {
            /* noop */
          }
          throw new Error(message);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          append(decoder.decode(value, { stream: true }));
        }
      })
      .catch((err) => {
        if (!cancelled && err.name !== 'AbortError') showError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setStarted(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [profile.id, target.id, follow, visible, showError]);

  return (
    <Modal title={`Логи: ${target.name}`} onClose={onClose} wide>
      <div className="logs-toolbar">
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Следовать за логами
        </label>
        {started && <span className="muted">подключено…</span>}
      </div>
      <pre className="logs-view" ref={preRef} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
    </Modal>
  );
}
