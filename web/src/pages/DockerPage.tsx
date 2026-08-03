import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { DockerEntity, Profile } from '../types';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
}

type Section = 'containers' | 'images' | 'volumes' | 'networks';
type ContainerAction = 'start' | 'stop' | 'restart' | 'rm';

function q(profileId: string): string {
  return `?profileId=${encodeURIComponent(profileId)}`;
}

export function DockerPage({ profile, showError }: Props) {
  const [section, setSection] = useState<Section>('containers');
  const [containers, setContainers] = useState<DockerEntity[]>([]);
  const [images, setImages] = useState<DockerEntity[]>([]);
  const [volumes, setVolumes] = useState<DockerEntity[]>([]);
  const [networks, setNetworks] = useState<DockerEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [pullImageName, setPullImageName] = useState('');
  const [logsTarget, setLogsTarget] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(
    async (sec: Section = section) => {
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
    [profile.id, section, showError],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, section]);

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
        </div>
      </div>

      <div className="table-wrap">
        {section === 'containers' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Имя</th>
                <th>Образ</th>
                <th>Статус</th>
                <th>Порты</th>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="muted">Загрузка…</td></tr>}
              {!loading && containers.length === 0 && <tr><td colSpan={6} className="muted">Контейнеров нет</td></tr>}
              {containers.map((c) => {
                const id = String(c.ID ?? c.ContainerID ?? '');
                const name = String(c.Names ?? id).replace(/^\//, '');
                const running = String(c.State ?? '').toLowerCase() === 'running' || /^Up /.test(String(c.Status ?? ''));
                return (
                  <tr key={id}>
                    <td className="mono">{shortId(id)}</td>
                    <td>{name}</td>
                    <td>{String(c.Image ?? '')}</td>
                    <td>
                      <span className={`status-chip ${running ? 'ok' : 'muted'}`}>{String(c.Status ?? '')}</span>
                    </td>
                    <td className="mono">{String(c.Ports ?? '')}</td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <button className="btn btn-mini" onClick={() => void containerAction(id, 'start', name)} title="Старт">▶</button>
                        <button className="btn btn-mini" onClick={() => void containerAction(id, 'stop', name)} title="Стоп">■</button>
                        <button className="btn btn-mini" onClick={() => void containerAction(id, 'restart', name)} title="Рестарт">↻</button>
                        <button className="btn btn-mini" onClick={() => setLogsTarget({ id, name })} title="Логи">📄</button>
                        <button className="btn btn-mini btn-danger" onClick={() => void containerAction(id, 'rm', name)} title="Удалить">✕</button>
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
          onClose={() => setLogsTarget(null)}
          showError={showError}
        />
      )}
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

function LogsModal({ profile, target, onClose, showError }: {
  profile: Profile;
  target: { id: string; name: string };
  onClose: () => void;
  showError: (msg: string) => void;
}) {
  const [follow, setFollow] = useState(false);
  const [started, setStarted] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const append = (text: string) => {
    if (preRef.current) {
      preRef.current.textContent += text;
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    const params = new URLSearchParams({ profileId: profile.id, tail: '200' });
    if (follow) params.set('stream', '1');
    let cancelled = false;
    const controller = new AbortController();
    setStarted(true);

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
  }, [profile.id, target.id, follow, showError]);

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

