import { useState } from 'react';

interface Props {
  onLogin: (password: string) => Promise<void>;
  showError: (msg: string) => void;
}

export function LoginPage({ onLogin, showError }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onLogin(password);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>ssh-commander</h1>
        <p className="muted">Введите пароль для доступа к веб-интерфейсу</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
        />
        <button className="btn btn-primary btn-block" disabled={busy || !password}>
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}

