import { useEffect, useState } from 'react';
import {
  addCronEntry,
  deleteCronEntry,
  fetchCron,
  fetchCronUsers,
  toggleCronEntry,
  updateCronEntry,
} from '../api';
import type { CronEntry, CronSnapshot } from '../api';
import type { Profile } from '../types';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;

const PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Своё расписание', value: '' },
  { label: 'При загрузке системы (@reboot)', value: '@reboot' },
  { label: 'Ежечасно (@hourly)', value: '@hourly' },
  { label: 'Ежедневно (@daily)', value: '@daily' },
  { label: 'Еженедельно (@weekly)', value: '@weekly' },
  { label: 'Ежемесячно (@monthly)', value: '@monthly' },
  { label: 'Ежегодно (@yearly)', value: '@yearly' },
];

function presetOf(schedule: string): string {
  return PRESETS.some((p) => p.value === schedule && p.value !== '') ? schedule : '';
}

function matchesFilter(entry: CronEntry, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  return q === '' || entry.command.toLowerCase().includes(q);
}

// Модалка добавления/редактирования задачи
function CronEntryModal({
  entry,
  onClose,
  onSave,
}: {
  /** undefined — добавление, иначе редактирование существующей записи. */
  entry?: CronEntry;
  onClose: () => void;
  onSave: (schedule: string, command: string) => Promise<void>;
}) {
  const initialPreset = entry ? presetOf(entry.schedule) : '';
  const [preset, setPreset] = useState(initialPreset);
  const [schedule, setSchedule] = useState(entry && initialPreset === '' ? entry.schedule : '0 3 * * *');
  const [command, setCommand] = useState(entry?.command ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const finalSchedule = preset || schedule.trim();
    if (!finalSchedule) {
      setError('Укажите расписание');
      return;
    }
    if (!command.trim()) {
      setError('Укажите команду');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSave(finalSchedule, command.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={entry ? 'Изменить задачу' : 'Новая cron-задача'} onClose={onClose}>
      <label>
        Расписание:
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {preset === '' && (
        <label>
          Выражение:
          <input
            type="text"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="0 3 * * *"
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {' '}5 полей: минута час день месяц день-недели
          </span>
        </label>
      )}
      <label>
        Команда:
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="/home/user/backup.sh --full"
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={loading}>
          Отмена
        </button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
          {loading ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </Modal>
  );
}

// SVG-иконки в фирменном стиле приложения (feather)
function IconEdit() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

function IconDelete() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// Switch статуса задачи (вкл/выкл); disabled — read-only (чужой crontab / системные файлы)
function StatusSwitch({
  enabled,
  disabled,
  busy,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  busy?: boolean;
  onToggle?: () => void;
}) {
  return (
    <label className="svc-switch">
      <span className="switch">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled || busy}
          onChange={() => onToggle?.()}
        />
        <span className="slider" />
      </span>
    </label>
  );
}

const SCHEDULE_COL = 200;
const STATUS_COL = 90;
const USER_COL = 110;
const ACTIONS_COL = 120;

function ScheduleCell({ entry }: { entry: CronEntry }) {
  return (
    <td>
      <code>{entry.schedule}</code>
      {entry.human !== entry.schedule && (
        <div className="muted" style={{ fontSize: 12 }}>
          {entry.human}
        </div>
      )}
    </td>
  );
}

// Системная read-only таблица (/etc/crontab, /etc/cron.d/*) с колонкой «Пользователь».
function SystemCronTable({
  entries,
  emptyText = 'Задач нет',
}: {
  entries: CronEntry[];
  emptyText?: string;
}) {
  return (
    <table className="data-table">
      <colgroup>
        <col style={{ width: SCHEDULE_COL }} />
        <col />
        <col style={{ width: USER_COL }} />
        <col style={{ width: STATUS_COL }} />
      </colgroup>
      <thead>
        <tr>
          <th>Расписание</th>
          <th>Команда</th>
          <th>Пользователь</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.index} className={e.enabled ? '' : 'cron-disabled'}>
            <ScheduleCell entry={e} />
            <td className="cron-cmd" title={e.raw}>
              <code>{e.command}</code>
            </td>
            <td>{e.user ?? '—'}</td>
            <td>
              <StatusSwitch enabled={e.enabled} disabled />
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              {emptyText}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function CronPage({ profile, visible, showError }: Props) {
  const [snapshot, setSnapshot] = useState<CronSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState<{ entry?: CronEntry } | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [selectedUser, setSelectedUser] = useState<string>('');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetchCronUsers(profile.id)
      .then((us) => {
        if (!cancelled) setUsers(us);
      })
      .catch(() => {
        // Селектор не появится — работаем как раньше (только свой crontab).
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const user = selectedUser || undefined;
        const s = await fetchCron(profile.id, user);
        if (cancelled) return;
        setSnapshot(s);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profile.id, visible, reloadKey, selectedUser]);

  // Мутации возвращают свежий snapshot (текущего пользователя) — применяем сразу.
  const applySnapshot = (s: CronSnapshot) => {
    setSnapshot(s);
    setError(null);
  };

  const handleOpError = (err: unknown) => {
    const e = err as Error & { status?: number };
    showError(e.status === 409 ? `${e.message} (данные обновлены)` : e.message);
    setReloadKey((k) => k + 1);
  };

  const handleSave = async (schedule: string, command: string) => {
    if (modal?.entry) {
      applySnapshot(
        await updateCronEntry(profile.id, modal.entry.index, {
          expectedRaw: modal.entry.raw,
          schedule,
          command,
        }),
      );
    } else {
      applySnapshot(await addCronEntry(profile.id, { schedule, command }));
    }
  };

  const handleToggle = async (entry: CronEntry) => {
    setBusyIndex(entry.index);
    try {
      applySnapshot(await toggleCronEntry(profile.id, entry.index, entry.raw));
    } catch (err) {
      handleOpError(err);
    } finally {
      setBusyIndex(null);
    }
  };

  const handleDelete = async (entry: CronEntry) => {
    if (!window.confirm(`Удалить задачу «${entry.command}» (${entry.schedule})?`)) return;
    setBusyIndex(entry.index);
    try {
      applySnapshot(await deleteCronEntry(profile.id, entry.index, entry.raw));
    } catch (err) {
      handleOpError(err);
    } finally {
      setBusyIndex(null);
    }
  };

  const handleDownload = () => {
    const raw = snapshot?.userCrontab?.raw;
    if (!raw) return;
    const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crontab-${snapshot.username}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const editable = snapshot ? snapshot.editable : true;
  const userEntries = (snapshot?.userCrontab?.entries ?? []).filter((e) => matchesFilter(e, filter));
  const userEnv = snapshot?.userCrontab?.env ?? [];
  const systemEntries = (snapshot?.systemCrontab?.entries ?? []).filter((e) => matchesFilter(e, filter));
  const cronDFiles = (snapshot?.cronD ?? []).map((f) => ({
    ...f,
    entries: f.entries.filter((e) => matchesFilter(e, filter)),
  }));
  const filterActive = filter.trim() !== '';
  const currentUser = snapshot?.currentUser ?? '';

  const selectorValue = selectedUser || currentUser;

  return (
    <div className="page cron-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? `Нет связи: ${error}`
            : snapshot
              ? `Обновлено ${new Date(snapshot.timestamp).toLocaleTimeString('ru-RU')}`
              : 'Загрузка…'}
        </span>
        <input
          className="search-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Фильтр по команде…"
        />
        {users.length > 0 && (
          <>
            <span className="toolbar-label">Пользователь</span>
            <select
              className="user-select"
              value={selectorValue}
              onChange={(e) => setSelectedUser(e.target.value)}
            >
              {users.map((u) => (
                <option key={u} value={u}>
                  {u}
                  {u === currentUser ? ' (текущий)' : ''}
                </option>
              ))}
            </select>
          </>
        )}
        <div className="toolbar-actions">
          <button
            className="btn btn-primary"
            onClick={() => setModal({})}
            disabled={!editable}
            title={editable ? '' : 'Мутации доступны только для вашего crontab'}
          >
            Добавить задачу
          </button>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {error && !snapshot ? (
        <div className="empty-state">
          <p>Сервер недоступен: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <div className="cron-scroll">
          {/* Crontab пользователя — редактируемый (свой) или read-only (чужой) */}
          <div className="cron-section">
            <div className="section-head">
              <h3 className="section-title">
                Задачи пользователя {snapshot ? <code>{snapshot.username}</code> : ''}
                {!editable && <span className="readonly-tag">только чтение</span>}
              </h3>
              <div className="section-actions">
                <button
                  className="btn btn-mini btn-ghost"
                  onClick={handleDownload}
                  disabled={!snapshot?.userCrontab}
                  title="Скачать crontab-файл как .txt"
                >
                  ⬇ Скачать
                </button>
              </div>
            </div>
            <div className="ports-scroll">
              <table className="data-table">
                <colgroup>
                  <col style={{ width: SCHEDULE_COL }} />
                  <col />
                  <col style={{ width: STATUS_COL }} />
                  {editable && <col style={{ width: ACTIONS_COL }} />}
                </colgroup>
                <thead>
                  <tr>
                    <th>Расписание</th>
                    <th>Команда</th>
                    <th>Статус</th>
                    {editable && <th>Действия</th>}
                  </tr>
                </thead>
                <tbody>
                  {userEntries.map((e) => (
                    <tr key={e.index} className={e.enabled ? '' : 'cron-disabled'}>
                      <ScheduleCell entry={e} />
                      <td className="cron-cmd" title={e.raw}>
                        <code>{e.command}</code>
                      </td>
                      <td>
                        {editable ? (
                          <StatusSwitch
                            enabled={e.enabled}
                            disabled={false}
                            busy={busyIndex === e.index}
                            onToggle={() => handleToggle(e)}
                          />
                        ) : (
                          <StatusSwitch enabled={e.enabled} disabled />
                        )}
                      </td>
                      {editable && (
                        <td>
                          <div className="row-actions">
                            <button
                              className="btn btn-mini icon-btn btn-ghost"
                              disabled={busyIndex === e.index}
                              onClick={() => setModal({ entry: e })}
                              title="Изменить"
                            >
                              <IconEdit />
                            </button>
                            <button
                              className="btn btn-mini icon-btn btn-ghost"
                              disabled={busyIndex === e.index}
                              onClick={() => handleDelete(e)}
                              title="Удалить"
                            >
                              <IconDelete />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {snapshot && userEntries.length === 0 && (
                    <tr>
                      <td colSpan={editable ? 4 : 3} className="muted">
                        {filterActive
                          ? 'Ничего не найдено по фильтру'
                          : snapshot.userCrontab === null
                            ? 'Crontab пользователя отсутствует — добавьте первую задачу'
                            : 'Задач нет'}
                      </td>
                    </tr>
                  )}
                  {!snapshot && (
                    <tr>
                      <td colSpan={editable ? 4 : 3} className="muted">
                        Загрузка…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {userEnv.length > 0 && (
                <div className="env-box">
                  <b>Переменные окружения:</b>{' '}
                  {userEnv.map((line) => {
                    const i = line.indexOf('=');
                    const k = i === -1 ? line : line.slice(0, i);
                    const v = i === -1 ? '' : line.slice(i + 1);
                    return (
                      <span className="env-item" key={line}>
                        <code>{k}</code>
                        {i !== -1 && <span className="muted">={v}</span>}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* /etc/crontab — read-only */}
          {snapshot?.systemCrontab && (
            <div className="cron-section">
              <div className="section-head">
                <h3 className="section-title">
                  Системный <code>/etc/crontab</code> <span className="muted">(только чтение)</span>
                </h3>
              </div>
              <div className="ports-scroll">
                <SystemCronTable
                  entries={systemEntries}
                  emptyText={filterActive ? 'Ничего не найдено по фильтру' : undefined}
                />
              </div>
            </div>
          )}

          {/* /etc/cron.d/* — read-only */}
          {cronDFiles.map((f) => (
            <div className="cron-section" key={f.file}>
              <div className="section-head">
                <h3 className="section-title">
                  <code>{f.file}</code> <span className="muted">(только чтение)</span>
                </h3>
              </div>
              <div className="ports-scroll">
                <SystemCronTable
                  entries={f.entries}
                  emptyText={filterActive ? 'Ничего не найдено по фильтру' : undefined}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <CronEntryModal
          entry={modal.entry}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
