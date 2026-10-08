import { useCallback, useEffect, useState } from 'react';
import { fetchSettings, updateSettings } from '../api';
import type { AiSettingsStatus } from '../api';
import { PROVIDERS, type AiProvider } from '../ai-providers';
import type { AlertsSettings } from '../alerts';
import { AiCostsPage } from '../pages/AiCostsPage';
import { AlertsSettingsForm } from './AlertsSettingsForm';
import { Modal } from './Modal';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';

// Theme toggle icons (moon/sun) in the project's SVG style.
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

type SettingsSection = 'interface' | 'security' | 'ai' | 'ai-costs' | 'alerts';

const SECTIONS: Array<{ id: SettingsSection; labelKey: I18nKey }> = [
  { id: 'interface', labelKey: 'settings.sectionInterface' },
  { id: 'security', labelKey: 'settings.sectionSecurity' },
  { id: 'ai', labelKey: 'settings.aiTitle' },
  { id: 'ai-costs', labelKey: 'app.aiCosts' },
  { id: 'alerts', labelKey: 'alerts.panelTitle' },
];

interface Props {
  theme: 'dark' | 'light';
  setTheme: React.Dispatch<React.SetStateAction<'dark' | 'light'>>;
  alertsSettings: AlertsSettings;
  onSaveAlertsSettings: (s: AlertsSettings) => void;
  showError: (msg: string) => void;
  showSuccess: (msg: string) => void;
  onClose: () => void;
}

/**
 * The "Settings" modal — everything configurable in one window: interface
 * (theme/language), the web interface password, the AI config, AI costs and
 * alert thresholds. Opened by the gear in the sidebar footer. No keep-alive:
 * the modal and its sections mount on open, GET /api/settings goes out on
 * every opening of the "AI agent" section (like the old "Settings" page).
 * The agent access level lives on the dialogue and is switched in the agent
 * panel (docs/agent-access-levels-plan.md, revision v2) — not here.
 */
export function SettingsModal({
  theme,
  setTheme,
  alertsSettings,
  onSaveAlertsSettings,
  showError,
  showSuccess,
  onClose,
}: Props) {
  const { lang, setLang, t } = useT();
  const [section, setSection] = useState<SettingsSection>('interface');

  // Close on Escape (✕ and overlay clicks are handled by the shared Modal).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <Modal title={t('app.settings')} onClose={onClose} wide className="settings-modal">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`settings-nav-item${section === s.id ? ' active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'interface' && (
          <section className="settings-section">
            <h2>{t('settings.sectionInterface')}</h2>
            <div className="theme-switch-row">
              <span className="theme-switch-label">{t('app.theme')}</span>
              <button
                className={`theme-switch ${theme}`}
                onClick={() => setTheme((cur) => (cur === 'dark' ? 'light' : 'dark'))}
                title={theme === 'dark' ? t('app.themeToLight') : t('app.themeToDark')}
                aria-label={t('app.themeToggleAria')}
              >
                <span className="ts-icon ts-moon">{MOON_ICON}</span>
                <span className="ts-icon ts-sun">{SUN_ICON}</span>
                <span className="ts-knob" />
              </button>
            </div>
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
          </section>
        )}
        {section === 'security' && <PasswordSection showError={showError} showSuccess={showSuccess} />}
        {section === 'ai' && <AiSection showError={showError} showSuccess={showSuccess} />}
        {section === 'ai-costs' && <AiCostsPage visible />}
        {section === 'alerts' && (
          <section className="settings-section">
            <h2>{t('alerts.settingsTitle')}</h2>
            <AlertsSettingsForm
              settings={alertsSettings}
              onSave={onSaveAlertsSettings}
              showError={showError}
              showSuccess={showSuccess}
            />
          </section>
        )}
      </div>
    </Modal>
  );
}

/** The "Security" section: changing the web interface password (epic 23). */
function PasswordSection({ showError, showSuccess }: { showError: (msg: string) => void; showSuccess: (msg: string) => void }) {
  const { t } = useT();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      showError(t('settings.errorNewPasswordShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      showError(t('settings.errorPasswordMismatch'));
      return;
    }
    setPasswordBusy(true);
    try {
      // Sessions are not invalidated: the cookie lives until its TTL expires (see the plan).
      await updateSettings({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      showSuccess(t('settings.passwordChanged'));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>{t('settings.passwordTitle')}</h2>
      <form onSubmit={submitPassword}>
        <label className="field-label" htmlFor="settings-current-password">
          {t('settings.currentPasswordLabel')}
        </label>
        <input
          id="settings-current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
        />
        <label className="field-label" htmlFor="settings-new-password">
          {t('settings.newPasswordLabel')}
        </label>
        <input
          id="settings-new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t('onboarding.passwordPlaceholder')}
          autoComplete="new-password"
        />
        <label className="field-label" htmlFor="settings-confirm-password">
          {t('settings.confirmNewPasswordLabel')}
        </label>
        <input
          id="settings-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
        <p className="muted settings-hint">{t('settings.passwordHint')}</p>
        <button className="btn btn-primary" disabled={passwordBusy}>
          {passwordBusy ? t('settings.saving') : t('settings.changePassword')}
        </button>
      </form>
    </section>
  );
}

/**
 * The "AI agent" section: replacing the AI config (epic 23). The status is
 * fetched with GET on mount (every opening of the section — a fresh
 * snapshot), the PUT response refreshes the status. The key is write-only:
 * an empty field keeps it on a model change; typing replaces it, and
 * "Clear key" sends aiApiKey: null (the agent becomes unavailable).
 */
function AiSection({ showError, showSuccess }: { showError: (msg: string) => void; showSuccess: (msg: string) => void }) {
  const { t } = useT();
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // AI: the key field is always empty (the value is never returned by the server).
  const [provider, setProvider] = useState<AiProvider>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [customBase, setCustomBase] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  // Server status → form (preset, model, base for custom).
  const applyStatus = useCallback((ai: AiSettingsStatus) => {
    setStatus(ai);
    const p = ai.provider ?? 'deepseek';
    setProvider(p);
    // Without a provider, the server base/model are runtime defaults
    // (OpenAI-oriented), not a hint for the form: for the selected preset we
    // fill in the preset's model, otherwise "DeepSeek + gpt-4.1-mini" would
    // go to the server silently as a broken pairing.
    setModel(ai.provider ? ai.model : PROVIDERS[p].model);
    setCustomBase(p === 'custom' ? ai.apiBase : '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchSettings();
        if (cancelled) return;
        applyStatus(s.ai);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyStatus, reloadKey]);

  // Changing the model does not change the saved preset's address, including a proxy.
  const base = provider === 'custom' ? customBase.trim()
    : provider === status?.provider ? status.apiBase : PROVIDERS[provider].base;
  const canKeepKey = Boolean(status?.apiKeySet && provider === status.provider
    && base.replace(/\/+$/, '') === status.apiBase.replace(/\/+$/, ''));

  const submitAi = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    const modelName = model.trim();
    if (!key && !canKeepKey) {
      showError(t('settings.errorKeyRequired'));
      return;
    }
    if (!modelName) {
      showError(t('settings.errorModelRequired'));
      return;
    }
    if (!base) {
      showError(t('settings.errorBaseUrlRequired'));
      return;
    }
    setAiBusy(true);
    try {
      const res = await updateSettings(key ? {
        aiApiKey: key,
        aiProvider: provider,
        aiApiBase: base,
        aiModel: modelName,
      } : { aiModel: modelName });
      applyStatus(res.ai);
      setApiKey('');
      showSuccess(t('settings.aiSaved'));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const clearKey = async () => {
    if (!window.confirm(t('settings.clearKeyConfirm'))) return;
    setAiBusy(true);
    try {
      const res = await updateSettings({ aiApiKey: null });
      applyStatus(res.ai);
      setApiKey('');
      showSuccess(t('settings.keyCleared'));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="empty-state">
        <p>{t('settings.loadFailed', { error: loadError })}</p>
        <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!status) {
    return <p className="muted settings-loading">{t('common.loading')}</p>;
  }

  return (
    <section className="settings-section">
      <h2>{t('settings.aiTitle')}</h2>
      <form onSubmit={submitAi}>
        <label className="field-label" htmlFor="settings-provider">
          {t('settings.providerLabel')}
        </label>
        <select
          id="settings-provider"
          value={provider}
          onChange={(e) => {
            const p = e.target.value as AiProvider;
            setProvider(p);
            // Switching the provider fills in the preset's model — it stays
            // editable (as in onboarding).
            setModel(PROVIDERS[p].model);
          }}
        >
          <option value="deepseek">{t('settings.providerDeepseek')}</option>
          <option value="openai">{t('settings.providerOpenai')}</option>
          <option value="opencode-go">{t('settings.providerOpencodeGo')}</option>
          <option value="custom">{t('settings.providerCustom')}</option>
        </select>
        <p className="muted settings-hint">
          {status.searchAvailable
            ? t('settings.searchAvailable')
            : t('settings.searchUnavailable')}
        </p>

        <label className="field-label" htmlFor="settings-api-key">
          {t('settings.aiKeyLabel')}
        </label>
        <input
          id="settings-api-key"
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            canKeepKey
              ? t('settings.keySetPlaceholder')
              : t('settings.keyUnsetPlaceholder')
          }
          autoComplete="off"
          spellCheck={false}
        />
        <p className="muted settings-hint">
          {canKeepKey ? t('settings.keyKeepHint') : t('settings.keyRequiredHint')}
        </p>

        {provider === 'custom' && (
          <>
            <label className="field-label" htmlFor="settings-base-url">
              {t('settings.baseUrlLabel')}
            </label>
            <input
              id="settings-base-url"
              type="text"
              value={customBase}
              onChange={(e) => setCustomBase(e.target.value)}
              placeholder={t('onboarding.baseUrlPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
          </>
        )}

        <label className="field-label" htmlFor="settings-model">
          {t('settings.modelLabel')}
        </label>
        <input
          id="settings-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={PROVIDERS[provider].model || t('onboarding.modelPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />

        {provider === 'opencode-go' && <p className="muted settings-hint">{t('ai.opencodeGoModelHint')}</p>}

        <div className="settings-actions">
          <button className="btn btn-primary" disabled={aiBusy}>
            {aiBusy ? t('settings.saving') : t('settings.saveAi')}
          </button>
          {status.apiKeySet && (
            <button type="button" className="btn btn-danger" disabled={aiBusy} onClick={clearKey}>
              {t('settings.clearKey')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
