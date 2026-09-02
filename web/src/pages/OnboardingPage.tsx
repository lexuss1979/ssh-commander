import { useState } from 'react';
import { useT } from '../i18n';
import { submitSetup } from '../api';

interface Props {
  onComplete: () => Promise<void>;
  showError: (msg: string) => void;
}

type Provider = 'deepseek' | 'openai' | 'custom';

// Пресеты несут base и модель (docs/settings-model-plan.md): пресет без
// модели не работает. «Свой URL» — поля формы; срез хвостового '/' делает
// сервер. Эпик 23 вынесет таблицу в общий модуль вместе со страницей
// «Настройки».
const PROVIDERS: Record<Provider, { base: string; model: string }> = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  custom: { base: '', model: '' },
};

/**
 * Первичная настройка (docs/settings-model-plan.md): экран вместо LoginPage
 * при первом запуске (пароля в settings.json нет). Задаёт пароль веб-интерфейса
 * и опционально AI-конфиг (провайдер, ключ, модель); успех POST /api/setup —
 * авто-вход (cookie уже стоит), приложение открывается сразу.
 */
export function OnboardingPage({ onComplete, showError }: Props) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<Provider>('deepseek');
  const [model, setModel] = useState(PROVIDERS.deepseek.model);
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
    const modelName = model.trim();
    const base = provider === 'custom' ? customBase.trim() : PROVIDERS[provider].base;
    if (key && !modelName) {
      setError(t('onboarding.errorModelRequired'));
      return;
    }
    if (key && provider === 'custom' && !base) {
      // Иначе ключ молча ушёл бы на дефолтную базу OpenAI (getAiSettings).
      setError(t('onboarding.errorBaseUrlRequired'));
      return;
    }
    setBusy(true);
    try {
      // AI-поля уходят только вместе с непустым ключом: иначе setup затёр бы
      // посеянные env'ом AI-поля пустой формой (мерж на сервере, но честнее
      // не отправлять пустоту вовсе).
      await submitSetup({
        password,
        aiApiKey: key || undefined,
        aiProvider: key ? provider : undefined,
        aiApiBase: key ? base || undefined : undefined,
        aiModel: key ? modelName || undefined : undefined,
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
          onChange={(e) => {
            const p = e.target.value as Provider;
            setProvider(p);
            // Смена провайдера подставляет модель пресета — остаётся редактируемой.
            setModel(PROVIDERS[p].model);
          }}
        >
          <option value="deepseek">{t('onboarding.providerDeepseek')}</option>
          <option value="openai">{t('onboarding.providerOpenai')}</option>
          <option value="custom">{t('onboarding.providerCustom')}</option>
        </select>

        <p className="muted onboarding-hint">
          {provider === 'deepseek'
            ? t('onboarding.searchAvailable')
            : t('onboarding.searchUnavailable')}
        </p>

        <label className="field-label" htmlFor="ob-model">
          {t('onboarding.modelLabel')}
        </label>
        <input
          id="ob-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={PROVIDERS[provider].model || t('onboarding.modelPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />

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
