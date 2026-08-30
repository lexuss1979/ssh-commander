import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  bootstrapServer,
  exportProfilesBackup,
  importKey,
  importProfilesBackup,
  type BootstrapStep,
  type KeyEntry,
} from '../api';
import type { Profile } from '../types';
import { useT } from '../i18n';
import { Modal } from './Modal';

interface Props {
  profiles: Profile[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  showError: (msg: string) => void;
  /** Вызывается после успешного bootstrap — выбрать созданный профиль. */
  onProfileCreated?: (profileId: string) => void;
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

interface BootstrapFormState {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  disablePasswordAuth: boolean;
}

const emptyBootstrapForm: BootstrapFormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  password: '',
  disablePasswordAuth: true,
};

type BootstrapPhase =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; steps: BootstrapStep[] }
  | { phase: 'error'; message: string; steps: BootstrapStep[] };

export function ProfileModal({ profiles, onClose, onSaved, showError, onProfileCreated }: Props) {
  const { t } = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Режим правой панели: обычная форма профиля или bootstrap «root + пароль».
  const [mode, setMode] = useState<'form' | 'bootstrap'>('form');
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
        overwrite = window.confirm(t('profileModal.keyOverwriteConfirm', { name: file.name }));
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
    setMode('form');
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
    setMode('form');
    setTestResult({ phase: 'idle' });
    setForm(emptyForm);
  };

  const startBootstrap = () => {
    setEditingId(null);
    setMode('bootstrap');
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
      showError(t('profileModal.errorRequiredFields'));
      return null;
    }
    if (form.authType === 'key' && !form.keyPath) {
      showError(t('profileModal.errorKeyPath'));
      return null;
    }
    if (form.authType === 'password' && !form.password) {
      showError(t('profileModal.errorPassword'));
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
    if (!window.confirm(t('profileModal.deleteConfirm'))) return;
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
      const ok = window.confirm(t('profileModal.exportNoPasswordConfirm'));
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
      setTransferMsg(t('profileModal.exportDone'));
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
      const parts = [t('profileModal.importedProfiles', { n: summary.imported })];
      if (summary.keysSaved) parts.push(t('profileModal.keysSaved', { n: summary.keysSaved }));
      if (summary.keysSkipped.length) {
        parts.push(t('profileModal.keysSkipped', { n: summary.keysSkipped.length }));
      }
      if (summary.renamed.length) {
        parts.push(
          t('profileModal.renamed', { names: summary.renamed.map((r) => `${r.from} → ${r.to}`).join(', ') }),
        );
      }
      if (summary.needSecrets.length) {
        parts.push(t('profileModal.needSecrets', { names: summary.needSecrets.join(', ') }));
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
    <Modal title={t('profileModal.title')} onClose={onClose} wide>
      <div className="profiles-layout">
        <div className="profiles-list">
          <button className="btn btn-primary btn-block" onClick={startCreate}>
            {t('profileModal.newServer')}
          </button>
          <button
            className={`btn btn-block ${mode === 'bootstrap' && !editingId ? 'btn-primary' : ''}`}
            onClick={startBootstrap}
            title={t('profileModal.bootstrapButtonTitle')}
          >
            {t('profileModal.bootstrapButton')}
          </button>
          {profiles.map((p) => (
            <div key={p.id} className={`profile-item ${editingId === p.id ? 'active' : ''}`}>
              <button className="profile-item-main" onClick={() => startEdit(p)}>
                <strong>{p.name}</strong>
                <span className="muted">{p.username}@{p.host}:{p.port}</span>
              </button>
              <button className="btn btn-danger" onClick={() => remove(p.id)} title={t('common.delete')}>
                ✕
              </button>
            </div>
          ))}

          <div className="transfer-block">
            <label className="sidebar-label">{t('profileModal.transferTitle')}</label>
            <input
              type="password"
              value={transferPassword}
              onChange={(e) => setTransferPassword(e.target.value)}
              placeholder={t('profileModal.transferPasswordPlaceholder')}
            />
            <label className="transfer-check">
              <input
                type="checkbox"
                checked={transferNoSecrets}
                onChange={(e) => setTransferNoSecrets(e.target.checked)}
              />
              {t('profileModal.transferNoSecrets')}
            </label>
            <div className="transfer-actions">
              <button className="btn" onClick={() => void exportBackup()} disabled={transferBusy}>
                {t('profileModal.export')}
              </button>
              <button
                className="btn"
                onClick={() => backupFileRef.current?.click()}
                disabled={transferBusy}
              >
                {t('profileModal.import')}
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
          {mode === 'bootstrap' && !editingId ? (
            <BootstrapPanel
              showError={showError}
              onSaved={onSaved}
              onProfileCreated={onProfileCreated}
              onBack={() => setMode('form')}
            />
          ) : (
            <>
          <h3>{editingId ? t('profileModal.editServer') : t('profileModal.formTitleNew')}</h3>
          <div className="form-grid">
            <label>
              {t('profileModal.fieldName')}
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="prod-01" />
            </label>
            <label>
              {t('profileModal.fieldHost')}
              <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="example.com" />
            </label>
            <label>
              {t('profileModal.fieldPort')}
              <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </label>
            <label>
              {t('profileModal.fieldUsername')}
              <input value={form.username} onChange={(e) => set('username', e.target.value)} />
            </label>
            <label>
              {t('profileModal.fieldAuth')}
              <select
                value={form.authType}
                onChange={(e) => set('authType', e.target.value as 'key' | 'password')}
              >
                <option value="password">{t('profileModal.authPassword')}</option>
                <option value="key">{t('profileModal.authKey')}</option>
              </select>
            </label>
            {form.authType === 'key' ? (
              <>
                <label className="span-2">
                  {t('profileModal.keyFromFolder')}
                  <select
                    value={form.keyPath}
                    onChange={(e) => set('keyPath', e.target.value)}
                  >
                    <option value="">{t('profileModal.selectKey')}</option>
                    {keys.map((k) => (
                      <option key={k.path} value={k.path}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    {keysError
                      ? t('profileModal.keysLoadFailed', { error: keysError })
                      : keys.length === 0
                        ? t('profileModal.keysEmpty')
                        : t('profileModal.keysHint')}
                  </span>
                </label>
                <label className="span-2">
                  {t('profileModal.keyPathLabel')}
                  <div className="inline-field">
                    <input
                      value={form.keyPath}
                      onChange={(e) => set('keyPath', e.target.value)}
                      placeholder="/keys/id_rsa"
                    />
                    <button type="button" className="btn" onClick={() => void loadKeys()}>
                      {t('common.refresh')}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={importBusy}
                      onClick={() => keyFileRef.current?.click()}
                    >
                      {importBusy ? t('common.loading') : t('profileModal.importKey')}
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
                  {t('profileModal.keyPassphraseLabel')}
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
                {t('profileModal.fieldPassword')}
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="••••••••"
                />
              </label>
            )}
            <label>
              {t('profileModal.dockerCommandLabel')}
              <input value={form.dockerCommand} onChange={(e) => set('dockerCommand', e.target.value)} placeholder="docker" />
            </label>
            <label className="span-2">
              {t('profileModal.noteLabel')}
              <input value={form.note} onChange={(e) => set('note', e.target.value)} placeholder={t('profileModal.notePlaceholder')} />
            </label>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? t('profileModal.saving') : t('common.save')}
            </button>
            <button
              className="btn"
              onClick={() => void testConn()}
              disabled={busy || testResult.phase === 'testing'}
            >
              {testResult.phase === 'testing' ? t('profileModal.testing') : t('profileModal.testConnection')}
            </button>
            {editingId && (
              <button className="btn" onClick={() => { setEditingId(null); setForm(emptyForm); }}>
                {t('common.cancel')}
              </button>
            )}
          </div>
          {testResult.phase === 'ok' && (
            <p className="test-result test-result-ok">
              {t('profileModal.testOk')}{testResult.banner ? ` — ${testResult.banner}` : ''}
            </p>
          )}
          {testResult.phase === 'error' && (
            <p className="test-result test-result-error">{t('profileModal.testError', { message: testResult.message })}</p>
          )}
          <p className="hint">
            {t('profileModal.keysHelpPre')}
            <code>keys/</code>{t('profileModal.keysHelpMid1')}<code>0600</code>
            {t('profileModal.keysHelpMid2')}<code>keys/</code>{t('profileModal.keysHelpMid3')}
            <code>/keys/id_rsa</code>.
          </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------
// «Новый сервер (root + пароль)» — bootstrap под ключ: отдельный ed25519-ключ
// на сервер, опциональное закрытие парольного входа, профиль с authType=key.
// Живого прогресса нет (одиночный запрос, десятки секунд): спиннер во время
// работы, итоговый отчёт по шагам в конце.
// --------------------------------------------------------------------------

function BootstrapPanel({
  showError,
  onSaved,
  onProfileCreated,
  onBack,
}: {
  showError: (msg: string) => void;
  onSaved: () => Promise<void>;
  onProfileCreated?: (profileId: string) => void;
  onBack: () => void;
}) {
  const { t } = useT();
  const [form, setForm] = useState<BootstrapFormState>(emptyBootstrapForm);
  const [state, setState] = useState<BootstrapPhase>({ phase: 'idle' });

  const set = <K extends keyof BootstrapFormState>(key: K, value: BootstrapFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const hardeningAvailable = form.username.trim() === 'root';

  const submit = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim() || !form.password) {
      showError(t('profileModal.bootstrapErrorRequired'));
      return;
    }
    const port = Number(form.port) || 22;
    if (port < 1 || port > 65535) {
      showError(t('profileModal.bootstrapErrorPort'));
      return;
    }
    setState({ phase: 'busy' });
    try {
      const res = await bootstrapServer({
        name: form.name.trim(),
        host: form.host.trim(),
        port,
        username: form.username.trim(),
        password: form.password,
        disablePasswordAuth: hardeningAvailable && form.disablePasswordAuth,
      });
      setState({ phase: 'done', steps: res.steps });
      await onSaved();
      onProfileCreated?.(res.profile.id);
    } catch (err) {
      showError((err as Error).message);
      const body = err instanceof ApiError ? (err.body as { steps?: BootstrapStep[] }) : null;
      setState({ phase: 'error', message: (err as Error).message, steps: body?.steps ?? [] });
    }
  };

  const icon = (status: BootstrapStep['status']) =>
    status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✕';

  return (
    <>
      <h3>{t('profileModal.bootstrapTitle')}</h3>
      <p className="field-hint">
        {t('profileModal.bootstrapHintPre')}
        <code>authType=key</code>
        {t('profileModal.bootstrapHintPost')}
      </p>
      {state.phase === 'done' ? (
        <div className="bootstrap-report">
          <p className="test-result test-result-ok">{t('profileModal.bootstrapDone', { name: form.name.trim() })}</p>
          <div className="bootstrap-steps">
            {state.steps.map((s, i) => (
              <div key={i} className={`bootstrap-step bootstrap-step-${s.status}`}>
                <span className="bootstrap-step-icon">{icon(s.status)}</span>
                <span className="bootstrap-step-name">{s.name}</span>
                {s.detail && <span className="bootstrap-step-detail">{s.detail}</span>}
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setState({ phase: 'idle' })}>
              {t('profileModal.bootstrapAnother')}
            </button>
          </div>
        </div>
      ) : state.phase === 'error' ? (
        <div className="bootstrap-report">
          <p className="test-result test-result-error">{t('profileModal.bootstrapFailed', { message: state.message })}</p>
          {state.steps.length > 0 && (
            <div className="bootstrap-steps">
              {state.steps.map((s, i) => (
                <div key={i} className={`bootstrap-step bootstrap-step-${s.status}`}>
                  <span className="bootstrap-step-icon">{icon(s.status)}</span>
                  <span className="bootstrap-step-name">{s.name}</span>
                  {s.detail && <span className="bootstrap-step-detail">{s.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {/добавьте профиль вручную/.test(state.message) && (
            <pre className="bootstrap-error-details">{state.message}</pre>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={() => setState({ phase: 'idle' })}>
              {t('profileModal.bootstrapRetry')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <label>
              {t('profileModal.fieldName')}
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="prod-01" />
            </label>
            <label>
              {t('profileModal.fieldHost')}
              <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="203.0.113.10" />
            </label>
            <label>
              {t('profileModal.fieldPort')}
              <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </label>
            <label>
              {t('profileModal.fieldUsername')}
              <input value={form.username} onChange={(e) => set('username', e.target.value)} />
            </label>
            <label className="span-2">
              {t('profileModal.fieldPassword')}
              <input
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </label>
            <label className={`transfer-check span-2 ${hardeningAvailable ? '' : 'disabled'}`}>
              <input
                type="checkbox"
                checked={hardeningAvailable && form.disablePasswordAuth}
                disabled={!hardeningAvailable || state.phase === 'busy'}
                onChange={(e) => set('disablePasswordAuth', e.target.checked)}
              />
              {t('profileModal.bootstrapHardening')}
            </label>
          </div>
          <p className="field-hint">
            {hardeningAvailable ? (
              <>{t('profileModal.bootstrapHardeningHint')}</>
            ) : (
              <>{t('profileModal.bootstrapHardeningRootOnly')}</>
            )}
          </p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => void submit()} disabled={state.phase === 'busy'}>
              {state.phase === 'busy' ? t('profileModal.bootstrapSubmitting') : t('profileModal.bootstrapSubmit')}
            </button>
            <button className="btn" onClick={onBack} disabled={state.phase === 'busy'}>
              {t('profileModal.bootstrapBack')}
            </button>
          </div>
          {state.phase === 'busy' && (
            <p className="bootstrap-busy">
              <span className="bootstrap-busy-dot" aria-hidden />
              {t('profileModal.bootstrapBusy')}
            </p>
          )}
        </>
      )}
    </>
  );
}
