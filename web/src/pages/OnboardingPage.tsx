import { useState } from 'react';
import { useT } from '../i18n';
import { submitSetup } from '../api';

interface Props {
  onComplete: () => Promise<void>;
  showError: (msg: string) => void;
}

type Provider = 'deepseek' | 'openai' | 'custom';

// Base URL по умолчанию для пресетов провайдеров (docs/onboarding-plan.md);
// «свой URL» — поле формы. Срез хвостового '/' делает сервер.
const PROVIDER_BASE: Record<Exclude<Provider, 'custom'>, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

/**
 * Первичная настройка (docs/onboarding-plan.md): экран вместо LoginPage при
 * первом запуске (чистый data/, пароль не задан). Задаёт пароль веб-интерфейса
 * и опционально ключ AI-API; успех POST /api/setup — авто-вход (cookie уже
 * стоит), приложение открывается сразу.
 */
export function OnboardingPage({ onComplete, showError }: Props) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<Provider>('deepseek');
  const [customBase, setCustomBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError(t('onboarding.errorPasswordShort'));
      return;
    }
    if (password !== confirm) {
      setError(t('onboarding.errorPasswordMismatch'));
      return;
    }
    const key = apiKey.trim();
    const base = provider === 'custom' ? customBase.trim() : PROVIDER_BASE[provider];
    setBusy(true);
    try {
      // AI-поля уходят только вместе с непустым ключом: иначе onboarding
      // записал бы aiApiBase без ключа и перекрыл env-конфиг AI (баг ревью 1).
      await submitSetup({
        password,
        aiApiKey: key || undefined,
        aiApiBase: key ? base || undefined : undefined,
      });
      await onComplete();
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card onboarding" onSubmit={submit}>
        <h1>ssh-commander</h1>
        <p className="muted">{t('onboarding.subtitle')}</p>

        <label className="field-label" htmlFor="ob-password">
          {t('onboarding.passwordLabel')}
        </label>
        <input
          id="ob-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('onboarding.passwordPlaceholder')}
          autoComplete="new-password"
        />

        <label className="field-label" htmlFor="ob-confirm">
          {t('onboarding.confirmLabel')}
        </label>
        <input
          id="ob-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={t('onboarding.confirmPlaceholder')}
          autoComplete="new-password"
        />

        <label className="field-label" htmlFor="ob-apikey">
          {t('onboarding.apiKeyLabel')}
        </label>
        <input
          id="ob-apikey"
          type="text"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('onboarding.apiKeyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />

        <label className="field-label" htmlFor="ob-provider">
          {t('onboarding.providerLabel')}
        </label>
        <select
          id="ob-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
        >
          <option value="deepseek">{t('onboarding.providerDeepseek')}</option>
          <option value="openai">{t('onboarding.providerOpenai')}</option>
          <option value="custom">{t('onboarding.providerCustom')}</option>
        </select>

        {provider === 'custom' && (
          <>
            <label className="field-label" htmlFor="ob-baseurl">
              {t('onboarding.baseUrlLabel')}
            </label>
            <input
              id="ob-baseurl"
              type="text"
              value={customBase}
              onChange={(e) => setCustomBase(e.target.value)}
              placeholder={t('onboarding.baseUrlPlaceholder')}
              spellCheck={false}
            />
          </>
        )}

        <p className="muted onboarding-hint">{t('onboarding.apiHint')}</p>

        {error && <div className="onboarding-error">{error}</div>}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('onboarding.submitting') : t('onboarding.submit')}
        </button>
      </form>
    </div>
  );
}
