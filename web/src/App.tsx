import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, setUnauthorizedHandler } from './api';
import type { Profile } from './types';
import { LoginPage } from './pages/LoginPage';
import { ServersPage } from './pages/ServersPage';
import { OverviewPage } from './pages/OverviewPage';
import { PortsPage } from './pages/PortsPage';
import { TerminalPage } from './pages/TerminalPage';
import { FilesPage } from './pages/FilesPage';
import { DockerPage } from './pages/DockerPage';
import { AgentPage } from './pages/AgentPage';
import { ProfileModal } from './components/ProfileModal';

type Tab = 'servers' | 'overview' | 'terminal' | 'files' | 'docker' | 'ports';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Обзор' },
  { id: 'terminal', label: 'Терминал' },
  { id: 'files', label: 'Файлы' },
  { id: 'docker', label: 'Docker' },
  { id: 'ports', label: 'Порты' },
];

const AGENT_MIN_WIDTH = 360;
const AGENT_MAX_WIDTH = 720;
const AGENT_DEFAULT_WIDTH = 420;

function loadAgentWidth(): number {
  try {
    const v = Number(localStorage.getItem('sc-agent-width'));
    if (v >= AGENT_MIN_WIDTH && v <= AGENT_MAX_WIDTH) return v;
  } catch {
    /* localStorage может быть недоступен */
  }
  return AGENT_DEFAULT_WIDTH;
}

function loadAgentOpen(): boolean {
  try {
    return localStorage.getItem('sc-agent-open') !== '0';
  } catch {
    return true;
  }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [tab, setTab] = useState<Tab>('servers');
  const [terminalContainer, setTerminalContainer] = useState<{ id: string; name: string } | null>(null);
  const [showProfiles, setShowProfiles] = useState(false);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('sc-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [agentWidth, setAgentWidth] = useState<number>(loadAgentWidth);
  const [agentOpen, setAgentOpen] = useState<boolean>(loadAgentOpen);
  // Одноразовый запрос из терминала («Спросить агента»): AgentPage расходует
  // его и сбрасывает через onAgentRequestConsumed.
  const [agentRequest, setAgentRequest] = useState<{ id: number; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('sc-theme', theme);
    } catch {
      /* localStorage может быть недоступен */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('sc-agent-width', String(agentWidth));
      localStorage.setItem('sc-agent-open', agentOpen ? '1' : '0');
    } catch {
      /* localStorage может быть недоступен */
    }
  }, [agentWidth, agentOpen]);

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

  // Истёкшая сессия (401 на любом запросе) — возвращаемся на страницу логина.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    api<Profile[]>('/api/profiles')
      .then((list) => {
        applyProfiles(list);
        setAuthed(true);
      })
      .catch((err) => {
        // На логин уводит только 401 (сработает и глобальный обработчик);
        // прочие ошибки (сеть, 5xx) — показываем toast, пользователь остаётся.
        if (!(err instanceof ApiError && err.status === 401)) {
          showError((err as Error).message);
          return;
        }
        setAuthed(false);
      });
  }, [applyProfiles, showError]);

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
    setTab('servers');
  }, []);

  // Кнопка «Спросить агента» в терминале: раскрывает панель и передаёт контекст.
  const handleAskAgent = useCallback((text: string) => {
    setAgentOpen(true);
    setAgentRequest({ id: Date.now(), text });
  }, []);

  // Drag-разделитель панели агента: ширина считается от правого края окна.
  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = agentWidth;
      const onMove = (ev: MouseEvent) => {
        const next = startWidth + (startX - ev.clientX);
        setAgentWidth(Math.min(AGENT_MAX_WIDTH, Math.max(AGENT_MIN_WIDTH, next)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing-agent');
      };
      document.body.classList.add('resizing-agent');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [agentWidth],
  );

  if (authed === null) {
    return (
      <>
        <div className="boot">Загрузка…</div>
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  if (!authed) {
    return (
      <>
        <LoginPage onLogin={handleLogin} showError={showError} />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">ssh-commander</div>

        <div className="sidebar-section sidebar-profiles">
          <button
            type="button"
            className={`profile-list-item${tab === 'servers' ? ' active' : ''}`}
            onClick={() => setTab('servers')}
          >
            <strong>Серверы</strong>
            <span className="muted">Сводный дашборд</span>
          </button>

          <div className="sidebar-divider" />

          <label className="sidebar-label">Площадки</label>
          <div className="profile-list">
            {profiles.length === 0 && (
              <div className="profile-list-empty muted">Нет серверов</div>
            )}
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`profile-list-item${p.id === activeProfileId ? ' active' : ''}`}
                onClick={() => {
                  setActiveProfileId(p.id);
                  if (tab === 'servers') setTab('overview');
                }}
                title={`${p.username}@${p.host}:${p.port}`}
              >
                <strong>{p.name}</strong>
                <span className="muted">
                  {p.username}@{p.host}
                </span>
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-block" onClick={() => setShowProfiles(true)}>
            Управление серверами
          </button>
        </div>

        <div className="sidebar-footer">
          <button
            className="btn btn-ghost btn-block"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема'}
          </button>
          <button className="btn btn-ghost btn-block" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </aside>

      <div className="app-main">
        <div className="topbar">
          <nav className="topbar-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`topbar-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {activeProfile && (
            <button
              className={`btn btn-ghost topbar-agent-toggle ${agentOpen ? 'active' : ''}`}
              onClick={() => setAgentOpen((o) => !o)}
              title={agentOpen ? 'Скрыть панель агента' : 'Показать панель агента'}
            >
              AI-агент
            </button>
          )}
        </div>

        <div className="app-body">
          <main className="main">
            <div className={`tab-page ${tab === 'servers' ? '' : 'hidden'}`}>
              <ServersPage
                showError={showError}
                visible={tab === 'servers'}
                onOpenProfile={(id) => {
                  setActiveProfileId(id);
                  setTab('overview');
                }}
              />
            </div>
            {!activeProfile && tab !== 'servers' && (
              <div className="empty-state">
                <p>Сначала добавьте SSH-сервер.</p>
                <button className="btn btn-primary" onClick={() => setShowProfiles(true)}>
                  Добавить сервер
                </button>
              </div>
            )}
            {activeProfile && (
              <>
                <div className={`tab-page ${tab === 'overview' ? '' : 'hidden'}`}>
                  <OverviewPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'overview'}
                  />
                </div>
                <div className={`tab-page ${tab === 'terminal' ? '' : 'hidden'}`}>
                  <TerminalPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'terminal'}
                    container={terminalContainer}
                    onExitContainer={() => setTerminalContainer(null)}
                    onAskAgent={handleAskAgent}
                  />
                </div>
                <div className={`tab-page ${tab === 'files' ? '' : 'hidden'}`}>
                  <FilesPage key={activeProfile.id} profile={activeProfile} showError={showError} />
                </div>
                <div className={`tab-page ${tab === 'docker' ? '' : 'hidden'}`}>
                  <DockerPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'docker'}
                    onExecContainer={(id, name) => {
                      setTerminalContainer({ id, name });
                      setTab('terminal');
                    }}
                  />
                </div>
                <div className={`tab-page ${tab === 'ports' ? '' : 'hidden'}`}>
                  <PortsPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'ports'}
                  />
                </div>
              </>
            )}
          </main>

          {activeProfile && agentOpen && (
            <div className="agent-resizer" onMouseDown={onResizerMouseDown} />
          )}
          {activeProfile && (
            <aside
              className={`agent-panel ${agentOpen ? '' : 'collapsed'}`}
              style={agentOpen ? { width: agentWidth } : undefined}
            >
              <div className="agent-panel-head">
                <span className="sidebar-label">AI-агент</span>
                <button
                  className="btn btn-ghost btn-mini"
                  onClick={() => setAgentOpen(false)}
                  title="Свернуть панель"
                >
                  »
                </button>
              </div>
              <AgentPage
                key={activeProfile.id}
                profile={activeProfile}
                showError={showError}
                agentRequest={agentRequest}
                onAgentRequestConsumed={() => setAgentRequest(null)}
              />
            </aside>
          )}
        </div>
      </div>

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
