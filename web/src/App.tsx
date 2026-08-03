import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import type { Profile } from './types';
import { LoginPage } from './pages/LoginPage';
import { TerminalPage } from './pages/TerminalPage';
import { FilesPage } from './pages/FilesPage';
import { DockerPage } from './pages/DockerPage';
import { AgentPage } from './pages/AgentPage';
import { ProfileModal } from './components/ProfileModal';

type Tab = 'terminal' | 'files' | 'docker' | 'agent';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'terminal', label: 'Терминал' },
  { id: 'files', label: 'Файлы' },
  { id: 'docker', label: 'Docker' },
  { id: 'agent', label: 'AI-агент' },
];

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [tab, setTab] = useState<Tab>('terminal');
  const [showProfiles, setShowProfiles] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | null>(null);

  const showError = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 6000);
  }, []);

  const applyProfiles = useCallback((list: Profile[]) => {
    setProfiles(list);
    setActiveProfileId((current) => (list.some((p) => p.id === current) ? current : (list[0]?.id ?? '')));
  }, []);

  const loadProfiles = useCallback(async () => {
    const list = await api<Profile[]>('/api/profiles');
    applyProfiles(list);
  }, [applyProfiles]);

  useEffect(() => {
    api<Profile[]>('/api/profiles')
      .then((list) => {
        applyProfiles(list);
        setAuthed(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setAuthed(false);
        } else {
          setAuthed(false);
        }
      });
  }, [applyProfiles]);

  const handleLogin = useCallback(
    async (password: string) => {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      await loadProfiles();
      setAuthed(true);
    },
    [loadProfiles],
  );

  const handleLogout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAuthed(false);
    setProfiles([]);
    setActiveProfileId('');
    setTab('terminal');
  }, []);

  if (authed === null) {
    return <div className="boot">Загрузка…</div>;
  }

  if (!authed) {
    return <LoginPage onLogin={handleLogin} showError={showError} />;
  }

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">ssh-commander</div>

        <div className="sidebar-section">
          <label className="sidebar-label">Сервер</label>
          <select
            value={activeProfileId}
            onChange={(e) => setActiveProfileId(e.target.value)}
            className="profile-select"
          >
            {profiles.length === 0 && <option value="">Нет серверов</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.host})
              </option>
            ))}
          </select>
          <button className="btn btn-ghost btn-block" onClick={() => setShowProfiles(true)}>
            Управление серверами
          </button>
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="btn btn-ghost btn-block" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </aside>

      <main className="main">
        {!activeProfile && (
          <div className="empty-state">
            <p>Сначала добавьте SSH-сервер.</p>
            <button className="btn btn-primary" onClick={() => setShowProfiles(true)}>
              Добавить сервер
            </button>
          </div>
        )}
        {activeProfile && tab === 'terminal' && <TerminalPage profile={activeProfile} showError={showError} />}
        {activeProfile && tab === 'files' && <FilesPage profile={activeProfile} showError={showError} />}
        {activeProfile && tab === 'docker' && <DockerPage profile={activeProfile} showError={showError} />}
        {activeProfile && tab === 'agent' && <AgentPage profile={activeProfile} showError={showError} />}
      </main>

      {showProfiles && (
        <ProfileModal
          profiles={profiles}
          onClose={() => setShowProfiles(false)}
          onSaved={async () => {
            try {
              await loadProfiles();
            } catch (err) {
              showError((err as Error).message);
            }
          }}
          showError={showError}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

