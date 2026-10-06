import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, fetchAlerts, fetchOverview, fetchSetupStatus, setUnauthorizedHandler } from './api';
import type { AgentAskMode, AlertRuleState, Profile } from './types';
import {
  loadAlertsSettings,
  mergeAlertStates,
  saveAlertsSettings,
  type ActiveAlert,
  type AlertsSettings,
} from './alerts';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { ServersPage } from './pages/ServersPage';
import { OverviewPage } from './pages/OverviewPage';
import { PortsPage } from './pages/PortsPage';
import { CronPage } from './pages/CronPage';
import { ServicesPage } from './pages/ServicesPage';
import { NginxPage } from './pages/NginxPage';
import { DatabasesPage } from './pages/DatabasesPage';
import { TerminalPage } from './pages/TerminalPage';
import { FilesPage } from './pages/FilesPage';
import { DockerPage } from './pages/DockerPage';
import { AgentPage } from './pages/AgentPage';
import { ProfileModal } from './components/ProfileModal';
import { SettingsModal } from './components/SettingsModal';
import { AlertsBell } from './components/AlertsBell';
import { useT } from './i18n';
import type { I18nKey } from './i18n';

// Sidebar footer icons (settings/logout) in the project's SVG style.
const SETTINGS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
  | 'overview'
  | 'terminal'
  | 'files'
  | 'docker'
  | 'databases'
  | 'nginx'
  | 'ports'
  | 'cron'
  | 'services';

const TABS: Array<{ id: Tab; labelKey: I18nKey }> = [
  { id: 'overview', labelKey: 'tabs.overview' },
  { id: 'terminal', labelKey: 'tabs.terminal' },
  { id: 'files', labelKey: 'tabs.files' },
  { id: 'docker', labelKey: 'tabs.docker' },
  { id: 'databases', labelKey: 'tabs.databases' },
  { id: 'nginx', labelKey: 'tabs.nginx' },
  { id: 'ports', labelKey: 'tabs.ports' },
  { id: 'cron', labelKey: 'tabs.cron' },
  { id: 'services', labelKey: 'tabs.services' },
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
    /* localStorage may be unavailable */
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
  const { t } = useT();
  const [authed, setAuthed] = useState<boolean | null>(null);
  // First-run setup (docs/onboarding-plan.md): true renders OnboardingPage
  // instead of LoginPage until a password is set in the UI.
  const [onboarding, setOnboarding] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [tab, setTab] = useState<Tab>('servers');
  // One-shot "open a container terminal" request from Docker Explorer
  // (epic 15): TerminalPage adds/activates the container tab and resets it
  // via onOpenContainerConsumed (the sqlInsert pattern). Also reset on
  // profile change — the request may be left over from another server's
  // container.
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    containerId: string;
    name: string;
  } | null>(null);
  // One-shot "Open in terminal (cd <path>)" request from the file manager:
  // TerminalPage opens/activates the host tab and resets it via
  // onOpenInTerminalConsumed.
  const [hostTerminalRequest, setHostTerminalRequest] = useState<{ cwd: string } | null>(null);
  const [showProfiles, setShowProfiles] = useState(false);
  // The "Settings" modal (gear in the sidebar footer) — no keep-alive:
  // mounted on open, sections fetch fresh data themselves.
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('sc-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [agentWidth, setAgentWidth] = useState<number>(loadAgentWidth);
  const [agentOpen, setAgentOpen] = useState<boolean>(loadAgentOpen);
  // One-shot "Ask the agent" request (terminal, the "To chat" menu, the SQL
  // console of the "Databases" tab): AgentPage consumes it and resets it via
  // onAgentRequestConsumed. profileId targets the agent panel of the profile
  // the request came from; mode says what to do with the text (default
  // 'explain'); source === 'db' enables the "→ SQL" button on sql blocks in
  // replies.
  const [agentRequest, setAgentRequest] = useState<
    { id: number; text: string; profileId: string; mode: AgentAskMode; source?: string } | null
  >(null);
  // The reverse of "→ SQL": AgentPage asks to insert SQL into the console
  // editor, DatabasesPage consumes and resets it via onSqlInsertConsumed.
  const [sqlInsert, setSqlInsert] = useState<{ id: number; sql: string } | null>(null);
  // "Open in files" from the "What takes space" navigator (epic 16): a
  // one-shot path for FilesPage; reset via onFilesPathConsumed.
  const [filesOpenPath, setFilesOpenPath] = useState<string | null>(null);
  // Agent panel keep-alive: panels mount for every profile visited in the
  // session, inactive ones are hidden with display:none — WS and chat
  // state stay alive.
  const [visitedProfileIds, setVisitedProfileIds] = useState<string[]>([]);
  // Per-profile agent activity for the sidebar indicator:
  // 'pending' (awaiting approval) outranks 'running'.
  const [agentActivity, setAgentActivity] = useState<Record<string, 'running' | 'pending'>>({});
  // Threshold alerts (epic 20): the server evaluates the rules on top of
  // the overview cache; transitions/hysteresis/notifications live here.
  // Settings are a client-side concern (localStorage 'sc-alerts').
  const [alertsSettings, setAlertsSettings] = useState<AlertsSettings>(loadAlertsSettings);
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const activeAlertsRef = useRef<Map<string, ActiveAlert>>(new Map());
  const syncedOnceRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  // Thresholds are read from a ref: the poll effect deps hold only the
  // toggles, otherwise every number change in the modal would recreate the
  // timer. Sync runs as an effect, not in the render body; saving settings
  // writes the ref directly so a tick landing between setState and commit
  // does not read stale thresholds.
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
      /* localStorage may be unavailable */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem('sc-agent-width', String(agentWidth));
      localStorage.setItem('sc-agent-open', agentOpen ? '1' : '0');
    } catch {
      /* localStorage may be unavailable */
    }
  }, [agentWidth, agentOpen]);

  const showError = useCallback((msg: string) => {
    setToast({ message: msg, kind: 'error' });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  const showSuccess = useCallback((msg: string) => {
    setToast({ message: msg, kind: 'success' });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  const toastView = toast && (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.kind === 'success' && <span aria-hidden>✓ </span>}{toast.message}
    </div>
  );

  const applyProfiles = useCallback((list: Profile[]) => {
    setProfiles(list);
    setActiveProfileId((current) => (list.some((p) => p.id === current) ? current : (list[0]?.id ?? '')));
  }, []);

  const loadProfiles = useCallback(async () => {
    const list = await api<Profile[]>('/api/profiles');
    applyProfiles(list);
  }, [applyProfiles]);

  // After log pinning from FilesPage: a stable identity so the putLogPaths
  // useCallback is not recreated on every render.
  const handleProfilesChanged = useCallback(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Expired session (401 on any request) — back to the login page.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Bootstrap (docs/onboarding-plan.md): first the public first-run setup
  // status, then the regular session check via /api/profiles. Until the
  // status arrives — the previous loading screen; required → OnboardingPage
  // (auto-login after POST /api/setup, the server sets the cookie).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let required = false;
      try {
        const status = await fetchSetupStatus();
        required = status.required;
      } catch {
        // Probe request: a failure (network/old server) must not show an
        // error — just fall through to the regular bootstrap (401 would
        // send us to login via the global handler).
      }
      if (cancelled) return;
      if (required) {
        setOnboarding(true);
        // authed=false, not true: otherwise the sidebar poll would start,
        // and its unauthorized /api/overview → 401 → the global handler
        // would kick us to login right after a successful setup. The
        // screen does not change — the `if (onboarding)` guard in the
        // render stands before `if (!authed)`.
        setAuthed(false);
        return;
      }
      try {
        const list = await api<Profile[]>('/api/profiles');
        if (cancelled) return;
        applyProfiles(list);
        setAuthed(true);
      } catch (err) {
        if (cancelled) return;
        // Only 401 sends to login (the global handler fires for it too);
        // other errors (network, 5xx) show a toast and the user stays.
        if (!(err instanceof ApiError && err.status === 401)) {
          showError((err as Error).message);
          return;
        }
        setAuthed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyProfiles, showError]);

  // Server availability dots in the sidebar + alerts: one tick fires both
  // requests in parallel (the shared overview cache on the server lasts
  // 4 s; /api/alerts must arrive while the cache is alive — a sequential
  // call would trigger a second SSH poll). In a hidden tab the poll runs
  // only when both alerts and browser notifications are enabled (see the
  // effect guard), otherwise — the usual pause.
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [serverStatus, setServerStatus] = useState<Record<string, { ok: boolean; error?: string }>>({});

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // Rule state merge: held/new/cleared + browser notifications for new
  // ones (after the first silent sync, and only while the tab is hidden —
  // the in-app bell is enough otherwise).
  const applyAlertRules = useCallback((rules: AlertRuleState[]) => {
    const { next, fired } = mergeAlertStates(activeAlertsRef.current, rules, Date.now());
    activeAlertsRef.current = next;
    setActiveAlerts([...next.values()]);
    const first = !syncedOnceRef.current;
    syncedOnceRef.current = true;
    if (first) return; // F5 must not spam notifications for already active alerts
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
        /* the browser may refuse to create a notification — not critical */
      }
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    // A hidden tab does not poll until browser notifications are enabled —
    // the only scenario where background polling pays off (the bell is not
    // visible in a hidden tab, notifications are off by default — otherwise
    // the poll would fire SSH probes around the clock for nothing). The
    // browser throttles hidden timers to ~1/min — an honest background
    // check rate.
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
      // If either request fails — keep the last snapshot without
      // mass-resolving; 401 goes to login via the global handler.
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

  // Saving alert settings — a silent re-baseline: the active set is rebuilt
  // on the next tick with the new thresholds (otherwise hysteresis would
  // keep alerts against the old thresholds, and a settings change would
  // fire a salvo of notifications).
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

  // Onboarding complete: the session is already in place (POST /api/setup
  // set the cookie) — load the profiles and open the app.
  const handleOnboardingComplete = useCallback(async () => {
    await loadProfiles();
    setAuthed(true);
    setOnboarding(false);
  }, [loadProfiles]);

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

  // The agent panel mounts on the first visit of a profile and stays alive afterwards.
  useEffect(() => {
    if (!activeProfileId) return;
    setVisitedProfileIds((prev) => (prev.includes(activeProfileId) ? prev : [...prev, activeProfileId]));
  }, [activeProfileId]);

  // A profile change cancels a dangling container terminal request — the
  // container belonged to the previous server.
  useEffect(() => {
    setTerminalOpenRequest(null);
  }, [activeProfileId]);

  // AgentPage reports its activity; null clears the indicator.
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

  // The "Ask the agent" button, the "To chat" menu in the terminal and the
  // SQL console button: expand the panel and pass the request to the panel
  // of the profile it came from. mode picks what AgentPage does with the
  // text.
  const handleAskAgent = useCallback(
    (text: string, mode: AgentAskMode = 'explain', source?: string) => {
      setAgentOpen(true);
      setAgentRequest({ id: Date.now(), text, profileId: activeProfileId, mode, source });
    },
    [activeProfileId],
  );

  // "→ SQL" on a sql block in the agent chat: insert into the console
  // editor of the profile and switch back to the "Databases" tab
  // (DatabasesPage consumes sqlInsert).
  const handleSqlInsert = useCallback((profileId: string, sql: string) => {
    setActiveProfileId(profileId);
    setTab('databases');
    setSqlInsert({ id: Date.now(), sql });
  }, []);

  // "Open in files" from the "What takes space" navigator: navigate to the
  // path in the "Files" tab (the profile is already active — "Overview" is
  // rendered only for activeProfile, and FilesPage is mounted keep-alive
  // and reacts to openPath).
  const handleOpenInFiles = useCallback((path: string) => {
    setFilesOpenPath(path);
    setTab('files');
  }, []);

  // "Open in terminal" from the file manager: open the profile's terminal
  // tab with a cd into the path directory (the profile is already active —
  // FilesPage is for activeProfile, TerminalPage is mounted keep-alive).
  const handleOpenInTerminal = useCallback((cwd: string) => {
    setHostTerminalRequest({ cwd });
    setTab('terminal');
  }, []);

  // Agent panel drag separator: the width is measured from the right edge of the window.
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

  // Problem profile chips in the sidebar: the alert count and the worst severity.
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
        <div className="boot">{t('common.loading')}</div>
        {toastView}
      </>
    );
  }

  // First-run setup — instead of the login page (no password set yet).
  if (onboarding) {
    return (
      <>
        <OnboardingPage onComplete={handleOnboardingComplete} showError={showError} />
        {toastView}
      </>
    );
  }

  if (!authed) {
    return (
      <>
        <LoginPage onLogin={handleLogin} showError={showError} />
        {toastView}
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
          />
        </div>

        <div className="sidebar-section sidebar-profiles">
          <button
            type="button"
            className={`profile-list-item${tab === 'servers' ? ' active' : ''}`}
            onClick={() => setTab('servers')}
          >
            <strong>{t('app.servers')}</strong>
            <span className="muted">{t('app.serversSubtitle')}</span>
          </button>

          <div className="sidebar-divider" />

          <label className="sidebar-label">{t('app.sites')}</label>
          <div className="profile-list">
            {profiles.length === 0 && (
              <div className="profile-list-empty muted">{t('app.noServers')}</div>
            )}
            {profiles.map((p) => {
              const st = serverStatus[p.id];
              const dotClass = st ? (st.ok ? 'connected' : 'error') : '';
              const statusText = st
                ? st.ok
                  ? t('app.statusAvailable')
                  : t('app.statusUnavailable', { error: st.error ?? t('app.statusNoData') })
                : t('app.statusChecking');
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
                            ? t('app.agentPending')
                            : t('app.agentRunning')
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
            {t('app.manageServers')}
          </button>
        </div>

        <div className="sidebar-footer">
          <button className="btn btn-block" onClick={() => setShowSettings(true)}>
            <span className="footer-btn-label">
              <span className="footer-btn-ic">{SETTINGS_ICON}</span> {t('app.settings')}
            </span>
          </button>
          <button className="btn btn-block" onClick={handleLogout}>
            <span className="footer-btn-label">
              <span className="footer-btn-ic">{LOGOUT_ICON}</span> {t('app.logout')}
            </span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <div className="topbar">
          <nav className="topbar-tabs">
            {TABS.map((tabDef) => (
              <button
                key={tabDef.id}
                className={`topbar-tab ${tab === tabDef.id ? 'active' : ''}`}
                onClick={() => setTab(tabDef.id)}
              >
                {t(tabDef.labelKey)}
              </button>
            ))}
          </nav>
          {activeProfile && (
            <button
              className={`btn btn-ghost topbar-agent-toggle ${agentOpen ? 'active' : ''}`}
              onClick={() => setAgentOpen((o) => !o)}
              title={agentOpen ? t('app.hideAgentPanel') : t('app.showAgentPanel')}
            >
              {t('app.agent')}
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
            {!activeProfile && tab !== 'servers' && (
              <div className="empty-state">
                <p>{t('app.addServerFirst')}</p>
                <button className="btn btn-primary" onClick={() => setShowProfiles(true)}>
                  {t('app.addServer')}
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
                <span className="sidebar-label">{t('app.agent')}</span>
                <button
                  className="btn btn-ghost btn-mini"
                  onClick={() => setAgentOpen(false)}
                  title={t('app.collapsePanel')}
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

      {showSettings && (
        <SettingsModal
          theme={theme}
          setTheme={setTheme}
          alertsSettings={alertsSettings}
          onSaveAlertsSettings={handleAlertsSettingsSaved}
          showError={showError}
          showSuccess={showSuccess}
          onClose={() => setShowSettings(false)}
        />
      )}

      {toastView}
    </div>
  );
}
