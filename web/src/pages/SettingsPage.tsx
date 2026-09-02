import { useCallback, useEffect, useState } from 'react';
import { fetchSettings, updateSettings } from '../api';
import type { AiSettingsStatus } from '../api';
import { PROVIDERS, type AiProvider } from '../ai-providers';
import { useT } from '../i18n';

interface Props {
  showError: (msg: string) => void;
}

/**
 * Страница «Настройки» (эпик 23, docs/settings-model-plan.md): смена пароля
 * веб-интерфейса и AI-конфига после первого запуска — вместо правки
 * data/settings.json + рестарта. Глобальная страница вне таббара профиля
 * (как «Расходы AI»), без keep-alive: данные — GET при монтировании, ответ
 * PUT освежает статус. Ключ write-only: поле всегда пустое, ввод заменяет,
 * «Очистить ключ» шлёт aiApiKey: null (агент становится недоступен).
 */
export function SettingsPage({ showError }: Props) {
  const { t } = useT();
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // Пароль
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  // AI: поле ключа всегда пустое (значение сервером не отдаётся).
  const [provider, setProvider] = useState<AiProvider>('deepseek');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [customBase, setCustomBase] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  // Статус с сервера → форма (пресет, модель, base для custom).
  const applyStatus = useCallback((ai: AiSettingsStatus) => {
    setStatus(ai);
    const p = ai.provider ?? 'deepseek';
    setProvider(p);
    // Без провайдера серверные base/model — рантайм-дефолты (OpenAI-ориентированные),
    // а не подсказка форме: под выбранный пресет подставляем модель пресета,
    // иначе «DeepSeek + gpt-4.1-mini» ушло бы на сервер молча сломанной связкой.
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
      // Сессия не прерывается: cookie живёт до истечения TTL (см. план).
      await updateSettings({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      showError(t('settings.passwordChanged'));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setPasswordBusy(false);
    }
  };

  const submitAi = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    const modelName = model.trim();
    const base = provider === 'custom' ? customBase.trim() : PROVIDERS[provider].base;
    if (!key) {
      // Частичной замены нет (ключ write-only): без ключа конфиг не сохранить.
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
      const res = await updateSettings({
        aiApiKey: key,
        aiProvider: provider,
        aiApiBase: base,
        aiModel: modelName,
      });
      applyStatus(res.ai);
      setApiKey('');
      showError(t('settings.aiSaved'));
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
      showError(t('settings.keyCleared'));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>{t('settings.loadFailed', { error: loadError })}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page settings-page">
      {!status && <p className="muted settings-loading">{t('common.loading')}</p>}
      {status && (
        <>
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
                  // Смена провайдера подставляет модель пресета — остаётся
                  // редактируемой (как в onboarding).
                  setModel(PROVIDERS[p].model);
                }}
              >
                <option value="deepseek">{t('settings.providerDeepseek')}</option>
                <option value="openai">{t('settings.providerOpenai')}</option>
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
                  status.apiKeySet
                    ? t('settings.keySetPlaceholder')
                    : t('settings.keyUnsetPlaceholder')
                }
                autoComplete="off"
                spellCheck={false}
              />

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
        </>
      )}
    </div>
  );
}
