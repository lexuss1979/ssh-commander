import { useEffect, useRef, useState } from 'react';
import { api, exportProfilesBackup, importKey, importProfilesBackup, type KeyEntry } from '../api';
import type { Profile } from '../types';
import { Modal } from './Modal';

interface Props {
  profiles: Profile[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  showError: (msg: string) => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authType: 'key' | 'password';
  keyPath: string;
  keyPassphrase: string;
  password: string;
  dockerCommand: string;
  note: string;
}

const emptyForm: FormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authType: 'password',
  keyPath: '',
  keyPassphrase: '',
  password: '',
  dockerCommand: 'docker',
  note: '',
};

export function ProfileModal({ profiles, onClose, onSaved, showError }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [keysError, setKeysError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const keyFileRef = useRef<HTMLInputElement>(null);
  // Перенос профилей: общий пароль шифрования для экспорта/импорта.
  const [transferPassword, setTransferPassword] = useState('');
  const [transferNoSecrets, setTransferNoSecrets] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMsg, setTransferMsg] = useState('');
  const backupFileRef = useRef<HTMLInputElement>(null);
  // Результат «Проверить подключение»: ok/error с сообщением.
  const [testResult, setTestResult] = useState<
    { phase: 'idle' } | { phase: 'testing' } | { phase: 'ok'; banner: string } | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  const loadKeys = async () => {
    try {
      const data = await api<{ keys: KeyEntry[] }>('/api/keys');
      setKeys(data.keys);
      setKeysError('');
    } catch (err) {
      setKeysError((err as Error).message);
    }
  };

  // Импорт ключа с диска: файл уходит на сервер в keys/ (0600),
  // после загрузки он сразу выбирается в форме.
  const importKeyFile = async (file: File) => {
    setImportBusy(true);
    try {
      let overwrite = false;
      if (keys.some((k) => k.name === file.name)) {
        overwrite = window.confirm(`Ключ «${file.name}» уже есть в хранилище. Перезаписать?`);
        if (!overwrite) return;
      }
      const content = await file.text();
      const key = await importKey(file.name, content, overwrite);
      await loadKeys();
      set('keyPath', key.path);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const startEdit = (p: Profile) => {
    setEditingId(p.id);
    setTestResult({ phase: 'idle' });
    setForm({
      name: p.name,
      host: p.host,
      port: String(p.port),
      username: p.username,
      authType: p.authType,
      keyPath: p.keyPath ?? '',
      keyPassphrase: p.keyPassphrase ?? '',
      password: p.password ?? '',
      dockerCommand: p.dockerCommand ?? 'docker',
      note: p.note ?? '',
    });
  };

  const startCreate = () => {
    setEditingId(null);
    setTestResult({ phase: 'idle' });
    setForm(emptyForm);
  };

  const save = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setBusy(true);
    try {
      if (editingId) {
        await api(`/api/profiles/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/profiles', { method: 'POST', body: JSON.stringify(payload) });
      }
      await onSaved();
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Общая валидация формы и сборка payload (для сохранения и теста соединения).
  function buildPayload(): Record<string, unknown> | null {
    if (!form.name || !form.host || !form.username) {
      showError('Заполните имя, хост и пользователя');
      return null;
    }
    if (form.authType === 'key' && !form.keyPath) {
      showError('Укажите путь к SSH-ключу внутри контейнера (например /keys/id_rsa)');
      return null;
    }
    if (form.authType === 'password' && !form.password) {
      showError('Укажите пароль');
      return null;
    }
    return {
      name: form.name,
      host: form.host,
      port: Number(form.port) || 22,
      username: form.username,
      authType: form.authType,
      keyPath: form.authType === 'key' ? form.keyPath : undefined,
      // Пустое поле passphrase = «не менять» при редактировании / «без passphrase» при создании.
      keyPassphrase: form.authType === 'key' ? form.keyPassphrase || undefined : undefined,
      password: form.authType === 'password' ? form.password : undefined,
      dockerCommand: form.dockerCommand || 'docker',
      note: form.note || undefined,
    };
  }

  // «Проверить подключение»: разовое SSH-подключение по текущим полям формы,
  // профиль сохранять не нужно.
  const testConn = async () => {
    const payload = buildPayload();
    if (!payload) return;
    setTestResult({ phase: 'testing' });
    try {
      const res = await api<{ ok: boolean; banner: string }>('/api/profiles/test-connection', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTestResult({ phase: 'ok', banner: res.banner ?? '' });
    } catch (err) {
      setTestResult({ phase: 'error', message: (err as Error).message });
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить профиль?')) return;
    try {
      await api(`/api/profiles/${id}`, { method: 'DELETE' });
      await onSaved();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  // Экспорт бэкапа: без пароля и с секретами — спрашиваем подтверждение,
  // файл окажется открытым текстом.
  const exportBackup = async () => {
    if (!transferNoSecrets && !transferPassword) {
      const ok = window.confirm(
        'Бэкап с секретами без пароля шифрования сохранит пароли открытым текстом. Продолжить?',
      );
      if (!ok) return;
    }
    setTransferBusy(true);
    setTransferMsg('');
    try {
      const blob = await exportProfilesBackup({
        passphrase: transferPassword || undefined,
        includeSecrets: !transferNoSecrets,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ssh-commander-profiles.json';
      a.click();
      URL.revokeObjectURL(url);
      setTransferMsg('Бэкап сохранён.');
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setTransferBusy(false);
    }
  };

  // Импорт бэкапа: файл читается локально и уходит на сервер текстом.
  const importBackup = async (file: File) => {
    setTransferBusy(true);
    setTransferMsg('');
    try {
      const text = await file.text();
      const summary = await importProfilesBackup(text, transferPassword || undefined);
      await onSaved();
      const parts = [`Импортировано профилей: ${summary.imported}`];
      if (summary.keysSaved) parts.push(`ключей сохранено: ${summary.keysSaved}`);
      if (summary.keysSkipped.length) {
        parts.push(`ключей пропущено (уже есть): ${summary.keysSkipped.length}`);
      }
      if (summary.renamed.length) {
        parts.push(
          `переименованы: ${summary.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}`,
        );
      }
      if (summary.needSecrets.length) {
        parts.push(
          `задайте секреты вручную: ${summary.needSecrets.join(', ')}`,
        );
      }
      setTransferMsg(parts.join('; '));
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setTransferBusy(false);
    }
  };

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Modal title="Управление серверами" onClose={onClose} wide>
      <div className="profiles-layout">
        <div className="profiles-list">
          <button className="btn btn-primary btn-block" onClick={startCreate}>
            + Новый сервер
          </button>
          {profiles.map((p) => (
            <div key={p.id} className={`profile-item ${editingId === p.id ? 'active' : ''}`}>
              <button className="profile-item-main" onClick={() => startEdit(p)}>
                <strong>{p.name}</strong>
                <span className="muted">{p.username}@{p.host}:{p.port}</span>
              </button>
              <button className="btn btn-danger" onClick={() => remove(p.id)} title="Удалить">
                ✕
              </button>
            </div>
          ))}

          <div className="transfer-block">
            <label className="sidebar-label">Перенос на другую машину</label>
            <input
              type="password"
              value={transferPassword}
              onChange={(e) => setTransferPassword(e.target.value)}
              placeholder="Пароль шифрования (опционально)"
            />
            <label className="transfer-check">
              <input
                type="checkbox"
                checked={transferNoSecrets}
                onChange={(e) => setTransferNoSecrets(e.target.checked)}
              />
              Без секретов (пароли и ключи не включать)
            </label>
            <div className="transfer-actions">
              <button className="btn" onClick={() => void exportBackup()} disabled={transferBusy}>
                Экспорт
              </button>
              <button
                className="btn"
                onClick={() => backupFileRef.current?.click()}
                disabled={transferBusy}
              >
                Импорт…
              </button>
              <input
                ref={backupFileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importBackup(file);
                }}
              />
            </div>
            {transferMsg && <p className="field-hint">{transferMsg}</p>}
          </div>
        </div>

        <div className="profile-form">
          <h3>{editingId ? 'Редактирование сервера' : 'Новый сервер'}</h3>
          <div className="form-grid">
            <label>
              Имя
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="prod-01" />
            </label>
            <label>
              Хост
              <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="example.com" />
            </label>
            <label>
              Порт
              <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </label>
            <label>
              Пользователь
              <input value={form.username} onChange={(e) => set('username', e.target.value)} />
            </label>
            <label>
              Аутентификация
              <select
                value={form.authType}
                onChange={(e) => set('authType', e.target.value as 'key' | 'password')}
              >
                <option value="password">Пароль</option>
                <option value="key">SSH-ключ</option>
              </select>
            </label>
            {form.authType === 'key' ? (
              <>
                <label className="span-2">
                  Ключ из папки keys/
                  <select
                    value={form.keyPath}
                    onChange={(e) => set('keyPath', e.target.value)}
                  >
                    <option value="">— выберите ключ —</option>
                    {keys.map((k) => (
                      <option key={k.path} value={k.path}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    {keysError
                      ? `Не удалось загрузить список: ${keysError}`
                      : keys.length === 0
                        ? 'В папке keys/ нет файлов. Импортируйте ключ кнопкой ниже или положите файл в keys/ вручную.'
                        : 'Файлы из папки keys/ (в контейнере — /keys).'}
                  </span>
                </label>
                <label className="span-2">
                  Путь к ключу (в контейнере)
                  <div className="inline-field">
                    <input
                      value={form.keyPath}
                      onChange={(e) => set('keyPath', e.target.value)}
                      placeholder="/keys/id_rsa"
                    />
                    <button type="button" className="btn" onClick={() => void loadKeys()}>
                      Обновить
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={importBusy}
                      onClick={() => keyFileRef.current?.click()}
                    >
                      {importBusy ? 'Загрузка…' : 'Импортировать…'}
                    </button>
                    <input
                      ref={keyFileRef}
                      type="file"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void importKeyFile(file);
                      }}
                    />
                  </div>
                </label>
                <label>
                  Passphrase ключа (если задана)
                  <input
                    type="password"
                    value={form.keyPassphrase}
                    onChange={(e) => set('keyPassphrase', e.target.value)}
                    placeholder="••••••••"
                  />
                </label>
              </>
            ) : (
              <label>
                Пароль
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="••••••••"
                />
              </label>
            )}
            <label>
              Команда Docker
              <input value={form.dockerCommand} onChange={(e) => set('dockerCommand', e.target.value)} placeholder="docker" />
            </label>
            <label className="span-2">
              Заметка
              <input value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Описание (необязательно)" />
            </label>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Сохранение…' : 'Сохранить'}
            </button>
            <button
              className="btn"
              onClick={() => void testConn()}
              disabled={busy || testResult.phase === 'testing'}
            >
              {testResult.phase === 'testing' ? 'Проверка…' : 'Проверить подключение'}
            </button>
            {editingId && (
              <button className="btn" onClick={() => { setEditingId(null); setForm(emptyForm); }}>
                Отмена
              </button>
            )}
          </div>
          {testResult.phase === 'ok' && (
            <p className="test-result test-result-ok">
              Подключение успешно{testResult.banner ? ` — ${testResult.banner}` : ''}
            </p>
          )}
          {testResult.phase === 'error' && (
            <p className="test-result test-result-error">Ошибка подключения: {testResult.message}</p>
          )}
          <p className="hint">
            Ключи можно импортировать кнопкой «Импортировать…» — файл сохраняется в папку{' '}
            <code>keys/</code> с правами <code>0600</code>. Либо положите ключ в <code>keys/</code>{' '}
            вручную и укажите путь внутри контейнера, например <code>/keys/id_rsa</code>.
          </p>
        </div>
      </div>
    </Modal>
  );
}
