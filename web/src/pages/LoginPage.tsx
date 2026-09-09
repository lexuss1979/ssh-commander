import { useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../api';

interface Props {
  onLogin: (password: string) => Promise<void>;
  showError: (msg: string) => void;
}

export function LoginPage({ onLogin, showError }: Props) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onLogin(password);
    } catch (err) {
      // Тексты ошибок входа переводим на клиенте по статус-коду: серверные
      // строки захардкожены на русском, а язык UI к этому моменту уже известен.
      if (err instanceof ApiError && err.status === 401) {
        showError(t('login.wrongPassword'));
      } else if (err instanceof ApiError && err.status === 429) {
        showError(t('login.tooManyAttempts'));
      } else {
        showError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>ssh-commander</h1>
        <p className="muted">{t('login.hint')}</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('login.passwordPlaceholder')}
        />
        <button className="btn btn-primary btn-block" disabled={busy || !password}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}

