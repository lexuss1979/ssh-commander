import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, fetchAlerts, fetchOverview, setUnauthorizedHandler } from './api';
import type { AgentAskMode, AlertRuleState, Profile } from './types';
import {
  loadAlertsSettings,
  mergeAlertStates,
  saveAlertsSettings,
  type ActiveAlert,
  type AlertsSettings,
} from './alerts';
import { LoginPage } from './pages/LoginPage';
import { ServersPage } from './pages/ServersPage';
import { OverviewPage } from './pages/OverviewPage';
import { PortsPage } from './pages/PortsPage';
import { CronPage } from './pages/CronPage';
import { ServicesPage } from './pages/ServicesPage';
import { NginxPage } from './pages/NginxPage';
import { DatabasesPage } from './pages/DatabasesPage';
import { AiCostsPage } from './pages/AiCostsPage';
import { TerminalPage } from './pages/TerminalPage';
import { FilesPage } from './pages/FilesPage';
import { DockerPage } from './pages/DockerPage';
import { AgentPage } from './pages/AgentPage';
import { ProfileModal } from './components/ProfileModal';
import { AlertsBell } from './components/AlertsBell';
import { useT } from './i18n';

// Иконки футера сайдбара (луна/солнце/выход) — в фирменном SVG-стиле.
const MOON_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const SUN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const LOGOUT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);

type Tab =
  | 'servers'
  | 'ai-costs'
  | 'overview'
  | 'terminal'
  | 'files'
  | 'docker'
  | 'databases'
  | 'nginx'
  | 'ports'
  | 'cron'
  | 'services';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Обзор' },
  { id: 'terminal', label: 'Терминал' },
  { id: 'files', label: 'Файлы' },
  { id: 'docker', label: 'Docker' },
  { id: 'databases', label: 'Базы данных' },
  { id: 'nginx', label: 'Nginx' },
  { id: 'ports', label: 'Порты' },
  { id: 'cron', label: 'Cron' },
  { id: 'services', label: 'Службы' },
];

const AGENT_MIN_WIDTH = 360;
const AGENT_MAX_WIDTH = 720;
const AGENT_DEFAULT_WIDTH = 420;
const SERVER_STATUS_POLL_MS = 10000;

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
  const { lang, setLang, t } = useT();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [tab, setTab] = useState<Tab>('servers');
  // Одноразовый запрос «терминал в контейнер» из Docker Explorer (эпик 15):
  // TerminalPage добавляет/активирует вкладку контейнера и сбрасывает через
  // onOpenContainerConsumed (паттерн sqlInsert). Сбрасывается и при смене
  // профиля — запрос мог остаться от контейнера чужого сервера.
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    containerId: string;
    name: string;
  } | null>(null);
  // Одноразовый запрос «Открыть в терминале cd <путь>» из файлового менеджера:
  // TerminalPage открывает/активирует host-вкладку и сбрасывает через
  // onOpenInTerminalConsumed.
  const [hostTerminalRequest, setHostTerminalRequest] = useState<{ cwd: string } | null>(null);
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
  // Одноразовый запрос «Спросить агента» (терминал, меню «В чат», SQL-консоль
  // вкладки «Базы данных»): AgentPage расходует его и сбрасывает через
  // onAgentRequestConsumed. profileId — панель агента того профиля, откуда
  // пришёл запрос; mode — что делать с текстом (по умолчанию 'explain');
  // source === 'db' включает кнопку «→ SQL» на sql-блоках ответов.
  const [agentRequest, setAgentRequest] = useState<
    { id: number; text: string; profileId: string; mode: AgentAskMode; source?: string } | null
  >(null);
  // Обратный ход «→ SQL»: AgentPage просит вставить SQL в редактор консоли,
  // DatabasesPage расходует и сбрасывает через onSqlInsertConsumed.
  const [sqlInsert, setSqlInsert] = useState<{ id: number; sql: string } | null>(null);
  // «Открыть в файлах» из навигатора «Что занимает» (эпик 16): одноразовый
  // путь для FilesPage; сбрасывается через onFilesPathConsumed.
  const [filesOpenPath, setFilesOpenPath] = useState<string | null>(null);
  // Keep-alive панели агента: монтируются для всех посещённых за сессию
  // профилей, неактивные скрываются display:none — WS и чат-стейт живут.
  const [visitedProfileIds, setVisitedProfileIds] = useState<string[]>([]);
  // Активность агента по профилям для индикатора в сайдбаре:
  // 'pending' (ждёт подтверждения) важнее 'running'.
  const [agentActivity, setAgentActivity] = useState<Record<string, 'running' | 'pending'>>({});
  // Алерты по порогам (эпик 20): правила считает сервер поверх кэша
  // overview, переходы/гистерезис/уведомления — здесь. Настройки —
  // настройка клиента (localStorage 'sc-alerts').
  const [alertsSettings, setAlertsSettings] = useState<AlertsSettings>(loadAlertsSettings);
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const activeAlertsRef = useRef<Map<string, ActiveAlert>>(new Map());
  const syncedOnceRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  // Пороги читаются из ref: в deps эффекта опроса — только тумблеры, иначе
  // каждое изменение числа в модалке пересоздавало бы таймер. Синхронизация —
  // эффектом, не в теле рендера; сохранение настроек пишет ref напрямую,
  // чтобы тик между setState и коммитом не прочитал старые пороги.
  const alertsSettingsRef = useRef(alertsSettings);
  const profilesRef = useRef(profiles);
  useEffect(() => {
    alertsSettingsRef.current = alertsSettings;
  }, [alertsSettings]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

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

  // После пиннинга логов из FilesPage: стабильная ссылка, чтобы useCallback
  // у putLogPaths не пересоздавался каждый рендер.
  const handleProfilesChanged = useCallback(() => {
    void loadProfiles();
  }, [loadProfiles]);

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

  // Точки доступности серверов в сайдбаре + алерты: один тик — два запроса
  // параллельно (общий кэш overview на сервере 4 с; /api/alerts должен
  // прийти, пока кэш жив, — последовательный вызов порождал бы второй опрос
  // SSH). В скрытой вкладке опрос идёт только когда включены и алерты, и
  // браузерные уведомления (см. guard эффекта), иначе — прежняя пауза.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [serverStatus, setServerStatus] = useState<Record<string, { ok: boolean; error?: string }>>({});

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // Слияние состояний правил: держащиеся/новые/снятые + браузерные
  // уведомления на новые (после первой тихой синхронизации, только когда
  // вкладка неактивна — в приложении хватает колокольчика).
  const applyAlertRules = useCallback((rules: AlertRuleState[]) => {
    const { next, fired } = mergeAlertStates(activeAlertsRef.current, rules, Date.now());
    activeAlertsRef.current = next;
    setActiveAlerts([...next.values()]);
    const first = !syncedOnceRef.current;
    syncedOnceRef.current = true;
    if (first) return; // F5 не спамит уведомлениями по уже активным алертам
    const s = alertsSettingsRef.current;
    if (
      !s.notify ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted' ||
      !document.hidden
    ) {
      return;
    }
    for (const a of fired) {
      try {
        const n = new Notification(
          profilesRef.current.find((p) => p.id === a.profileId)?.name ?? 'ssh-commander',
          { body: a.message, tag: a.key },
        );
        n.onclick = () => {
          window.focus();
          setActiveProfileId(a.profileId);
          setTab('overview');
        };
      } catch {
        /* браузер может отказаться создавать уведомление — не критично */
      }
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    // Скрытая вкладка не опрашивает, пока не включены браузерные уведомления
    // — единственный сценарий, где фоновый опрос что-то даёт (колокольчик в
    // скрытой вкладке не видно, уведомления по умолчанию выключены — иначе
    // опрос даром дёргал бы SSH-зонды круглосуточно). Браузер троттлит
    // скрытые таймеры до ~1/мин — честный ритм фоновой проверки.
    const s0 = alertsSettingsRef.current;
    if (!pageVisible && !(s0.enabled && s0.notify)) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const s = alertsSettingsRef.current;
      const [overviewRes, alertsRes] = await Promise.allSettled([
        fetchOverview(),
        s.enabled ? fetchAlerts({ disk: s.disk, mem: s.mem, load: s.load }) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (overviewRes.status === 'fulfilled') {
        const next: Record<string, { ok: boolean; error?: string }> = {};
        for (const srv of overviewRes.value.servers) next[srv.id] = { ok: srv.ok, error: srv.error };
        setServerStatus(next);
      }
      // Отказ любого из запросов — оставляем последний снимок без mass-resolve;
      // 401 уводит на логин глобальным обработчиком.
      if (alertsRes.status === 'fulfilled' && alertsRes.value) {
        applyAlertRules(alertsRes.value.rules);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, SERVER_STATUS_POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [authed, pageVisible, alertsSettings.enabled, alertsSettings.notify, applyAlertRules]);

  // Сохранение настроек алертов — тихий re-baseline: активный набор строится
  // заново на следующем тике с новыми порогами (иначе гистерезис держал бы
  // алерты по старым порогам, а смена настроек давала бы залп уведомлений).
  const handleAlertsSettingsSaved = useCallback((s: AlertsSettings) => {
    setAlertsSettings(s);
    alertsSettingsRef.current = s;
    saveAlertsSettings(s);
    activeAlertsRef.current = new Map();
    syncedOnceRef.current = false;
    setActiveAlerts([]);
  }, []);

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
    setVisitedProfileIds([]);
    setAgentActivity({});
    setActiveAlerts([]);
    activeAlertsRef.current = new Map();
    syncedOnceRef.current = false;
  }, []);

  // Панель агента монтируется при первом посещении профиля и дальше живёт.
  useEffect(() => {
    if (!activeProfileId) return;
    setVisitedProfileIds((prev) => (prev.includes(activeProfileId) ? prev : [...prev, activeProfileId]));
  }, [activeProfileId]);

  // Смена профиля гасит зависший запрос терминала контейнера — контейнер
  // принадлежал прошлому серверу.
  useEffect(() => {
    setTerminalOpenRequest(null);
  }, [activeProfileId]);

  // AgentPage сообщает о своей активности; null — снять индикатор.
  const handleAgentActivity = useCallback((profileId: string, state: 'running' | 'pending' | null) => {
    setAgentActivity((prev) => {
      if (state === null) {
        if (!(profileId in prev)) return prev;
        const next = { ...prev };
        delete next[profileId];
        return next;
      }
      if (prev[profileId] === state) return prev;
      return { ...prev, [profileId]: state };
    });
  }, []);

  // Кнопка «Спросить агента», меню «В чат» в терминале и кнопка SQL-консоли:
  // раскрывает панель и передаёт контекст панели того профиля, откуда пришёл
  // запрос. mode задаёт действие над текстом в AgentPage.
  const handleAskAgent = useCallback(
    (text: string, mode: AgentAskMode = 'explain', source?: string) => {
      setAgentOpen(true);
      setAgentRequest({ id: Date.now(), text, profileId: activeProfileId, mode, source });
    },
    [activeProfileId],
  );

  // «→ SQL» на sql-блоке в чате агента: вставить в редактор консоли профиля
  // и вернуться на вкладку «Базы данных» (DatabasesPage расходует sqlInsert).
  const handleSqlInsert = useCallback((profileId: string, sql: string) => {
    setActiveProfileId(profileId);
    setTab('databases');
    setSqlInsert({ id: Date.now(), sql });
  }, []);

  // «Открыть в файлах» из навигатора «Что занимает»: переход на путь во
  // вкладке «Файлы» (профиль уже активный — «Обзор» рендерится только для
  // activeProfile, FilesPage смонтирован keep-alive и реагирует на openPath).
  const handleOpenInFiles = useCallback((path: string) => {
    setFilesOpenPath(path);
    setTab('files');
  }, []);

  // «Открыть в терминале» из файлового менеджера: открыть terminal-вкладку
  // профиля с cd в директорию пути (профиль уже активный — FilesPage для
  // activeProfile, TerminalPage смонтирован keep-alive).
  const handleOpenInTerminal = useCallback((cwd: string) => {
    setHostTerminalRequest({ cwd });
    setTab('terminal');
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

  // Чипы проблемных профилей в сайдбаре: счётчик алертов и худшая severity.
  const profileAlerts = useMemo(() => {
    const map = new Map<string, { count: number; crit: boolean; messages: string[] }>();
    for (const a of activeAlerts) {
      const cur = map.get(a.profileId) ?? { count: 0, crit: false, messages: [] };
      cur.count += 1;
      cur.crit = cur.crit || a.severity === 'crit';
      cur.messages.push(a.message);
      map.set(a.profileId, cur);
    }
    return map;
  }, [activeAlerts]);

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
        <div className="sidebar-head">
          <div className="logo">ssh-commander</div>
          <AlertsBell
            alerts={activeAlerts}
            settings={alertsSettings}
            profiles={profiles}
            onOpenProfile={(id) => {
              setActiveProfileId(id);
              setTab('overview');
            }}
            onSaveSettings={handleAlertsSettingsSaved}
            showError={showError}
          />
        </div>

        <div className="sidebar-section sidebar-profiles">
          <button
            type="button"
            className={`profile-list-item${tab === 'servers' ? ' active' : ''}`}
            onClick={() => setTab('servers')}
          >
            <strong>Серверы</strong>
            <span className="muted">Сводный дашборд</span>
          </button>

          <button
            type="button"
            className={`profile-list-item${tab === 'ai-costs' ? ' active' : ''}`}
            onClick={() => setTab('ai-costs')}
          >
            <strong>ИИ-расходы</strong>
            <span className="muted">Расходы по проектам</span>
          </button>

          <div className="sidebar-divider" />

          <label className="sidebar-label">Площадки</label>
          <div className="profile-list">
            {profiles.length === 0 && (
              <div className="profile-list-empty muted">Нет серверов</div>
            )}
            {profiles.map((p) => {
              const st = serverStatus[p.id];
              const dotClass = st ? (st.ok ? 'connected' : 'error') : '';
              const statusText = st
                ? st.ok
                  ? 'доступен'
                  : `недоступен: ${st.error ?? 'нет данных'}`
                : 'статус проверяется';
              const activity = agentActivity[p.id];
              const pAlerts = profileAlerts.get(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`profile-list-item${p.id === activeProfileId ? ' active' : ''}`}
                  onClick={() => {
                    setActiveProfileId(p.id);
                    if (tab === 'servers') setTab('overview');
                  }}
                  title={`${p.username}@${p.host}:${p.port} — ${statusText}`}
                >
                  <span className="profile-item-head">
                    <span className={`status-dot${dotClass ? ` ${dotClass}` : ''}`} />
                    <strong>{p.name}</strong>
                    {activity && (
                      <span
                        className={`agent-dot ${activity}`}
                        title={
                          activity === 'pending'
                            ? 'Агент ждёт подтверждения действия'
                            : 'Агент выполняет задачу'
                        }
                      />
                    )}
                    {pAlerts && (
                      <span
                        className={`profile-alert-chip${pAlerts.crit ? ' crit' : ''}`}
                        title={pAlerts.messages.join('\n')}
                      >
                        ⚠ {pAlerts.count}
                      </span>
                    )}
                  </span>
                  <span className="muted">
                    {p.username}@{p.host}
                  </span>
                </button>
              );
            })}
          </div>
          <button className="btn btn-ghost btn-block" onClick={() => setShowProfiles(true)}>
            Управление серверами
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="theme-switch-row">
            <span className="theme-switch-label">{t('common.language')}</span>
            <div className="lang-switch" role="group" aria-label={t('common.language')}>
              <button
                className={`lang-switch-btn ${lang === 'ru' ? 'active' : ''}`}
                onClick={() => setLang('ru')}
              >
                RU
              </button>
              <button
                className={`lang-switch-btn ${lang === 'en' ? 'active' : ''}`}
                onClick={() => setLang('en')}
              >
                EN
              </button>
            </div>
          </div>
          <div className="theme-switch-row">
            <span className="theme-switch-label">Тема</span>
            <button
              className={`theme-switch ${theme}`}
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Переключить на светлую' : 'Переключить на тёмную'}
              aria-label="Переключить тему"
            >
              <span className="ts-icon ts-moon">{MOON_ICON}</span>
              <span className="ts-icon ts-sun">{SUN_ICON}</span>
              <span className="ts-knob" />
            </button>
          </div>
          <button className="btn btn-block" onClick={handleLogout}>
            <span className="logout-label">
              <span className="logout-ic">{LOGOUT_ICON}</span> Выйти
            </span>
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
                onAskAgent={handleAskAgent}
                profiles={profiles}
              />
            </div>
            {/* Глобальная страница вне таббара профиля (как «Серверы»): расходы
                AI кросс-профильные, профиль не нужен. */}
            <div className={`tab-page ${tab === 'ai-costs' ? '' : 'hidden'}`}>
              <AiCostsPage visible={tab === 'ai-costs'} />
            </div>
            {!activeProfile && tab !== 'servers' && tab !== 'ai-costs' && (
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
                    onOpenInFiles={handleOpenInFiles}
                    onAskAgent={handleAskAgent}
                  />
                </div>
                <div className={`tab-page ${tab === 'terminal' ? '' : 'hidden'}`}>
                  <TerminalPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'terminal'}
                    openContainerRequest={terminalOpenRequest}
                    onOpenContainerConsumed={() => setTerminalOpenRequest(null)}
                    openInTerminalRequest={hostTerminalRequest}
                    onOpenInTerminalConsumed={() => setHostTerminalRequest(null)}
                    onAskAgent={handleAskAgent}
                  />
                </div>
                <div className={`tab-page ${tab === 'files' ? '' : 'hidden'}`}>
                  <FilesPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'files'}
                    onAskAgent={handleAskAgent}
                    onProfilesChanged={handleProfilesChanged}
                    openPath={filesOpenPath}
                    onFilesPathConsumed={() => setFilesOpenPath(null)}
                    onOpenInTerminal={handleOpenInTerminal}
                  />
                </div>
                <div className={`tab-page ${tab === 'docker' ? '' : 'hidden'}`}>
                  <DockerPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'docker'}
                    onExecContainer={(id, name) => {
                      setTerminalOpenRequest({ containerId: id, name });
                      setTab('terminal');
                    }}
                  />
                </div>
                <div className={`tab-page ${tab === 'databases' ? '' : 'hidden'}`}>
                  <DatabasesPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'databases'}
                    onAskAgent={handleAskAgent}
                    sqlInsert={sqlInsert}
                    onSqlInsertConsumed={() => setSqlInsert(null)}
                  />
                </div>
                <div className={`tab-page ${tab === 'nginx' ? '' : 'hidden'}`}>
                  <NginxPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'nginx'}
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
                <div className={`tab-page ${tab === 'cron' ? '' : 'hidden'}`}>
                  <CronPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'cron'}
                  />
                </div>
                <div className={`tab-page ${tab === 'services' ? '' : 'hidden'}`}>
                  <ServicesPage
                    key={activeProfile.id}
                    profile={activeProfile}
                    showError={showError}
                    visible={tab === 'services'}
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
              {visitedProfileIds.map((id) => {
                const p = profiles.find((pr) => pr.id === id);
                if (!p) return null;
                return (
                  <div
                    key={id}
                    className={`agent-page-slot${id === activeProfileId ? '' : ' hidden'}`}
                  >
                    <AgentPage
                      profile={p}
                      showError={showError}
                      agentRequest={agentRequest?.profileId === id ? agentRequest : null}
                      onAgentRequestConsumed={() => setAgentRequest(null)}
                      onActivity={handleAgentActivity}
                      onSqlInsert={handleSqlInsert}
                    />
                  </div>
                );
              })}
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
          onProfileCreated={(id) => setActiveProfileId(id)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
