import { useEffect, useState } from 'react';
import {
  addCronEntry,
  deleteCronEntry,
  fetchCron,
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

// Read-only таблица задач (системные файлы)
function ReadOnlyCronTable({
  entries,
  showUser,
  emptyText = 'Задач нет',
}: {
  entries: CronEntry[];
  showUser: boolean;
  emptyText?: string;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Расписание</th>
          {showUser && <th className="col-narrow">Пользователь</th>}
          <th>Команда</th>
          <th className="col-narrow">Статус</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.index} className={e.enabled ? '' : 'cron-disabled'}>
            <ScheduleCell entry={e} />
            {showUser && <td>{e.user ?? '—'}</td>}
            <td className="cron-cmd" title={e.raw}>
              <code>{e.command}</code>
            </td>
            <td>
              <span className={`scope-badge ${e.enabled ? 'loopback' : ''}`}>
                {e.enabled ? 'вкл' : 'выкл'}
              </span>
            </td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr>
            <td colSpan={showUser ? 4 : 3} className="muted">
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

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await fetchCron(profile.id);
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
  }, [profile.id, visible, reloadKey]);

  // Мутации возвращают свежий snapshot — применяем сразу, без ожидания polling'а.
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

  const userEntries = (snapshot?.userCrontab?.entries ?? []).filter((e) => matchesFilter(e, filter));
  const userEnv = snapshot?.userCrontab?.env ?? [];
  const systemEntries = (snapshot?.systemCrontab?.entries ?? []).filter((e) => matchesFilter(e, filter));
  const cronDFiles = (snapshot?.cronD ?? []).map((f) => ({
    ...f,
    entries: f.entries.filter((e) => matchesFilter(e, filter)),
  }));
  const filterActive = filter.trim() !== '';

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
        <div className="toolbar-actions">
          <button className="btn btn-primary" onClick={() => setModal({})}>
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
          {/* Crontab SSH-пользователя — редактируемый */}
          <div className="cron-section">
            <h3 className="section-title">
              Задачи пользователя {snapshot ? <code>{snapshot.username}</code> : ''}
            </h3>
            <div className="ports-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Расписание</th>
                    <th>Команда</th>
                    <th className="col-narrow">Статус</th>
                    <th className="col-narrow">Действия</th>
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
                        <button
                          className="btn btn-ghost btn-small"
                          disabled={busyIndex === e.index}
                          onClick={() => handleToggle(e)}
                          title={e.enabled ? 'Выключить (закомментировать)' : 'Включить'}
                        >
                          <span className={`scope-badge ${e.enabled ? 'loopback' : ''}`}>
                            {e.enabled ? 'вкл' : 'выкл'}
                          </span>
                        </button>
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-small"
                          disabled={busyIndex === e.index}
                          onClick={() => setModal({ entry: e })}
                        >
                          Изменить
                        </button>
                        <button
                          className="btn btn-ghost btn-small"
                          disabled={busyIndex === e.index}
                          onClick={() => handleDelete(e)}
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                  {snapshot && userEntries.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
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
                      <td colSpan={4} className="muted">
                        Загрузка…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {userEnv.length > 0 && (
                <p className="muted ports-hint">
                  Переменные окружения: {userEnv.map((l) => l.trim()).join(' · ')}
                </p>
              )}
            </div>
          </div>

          {/* /etc/crontab — read-only */}
          {snapshot?.systemCrontab && (
            <div className="cron-section">
              <h3 className="section-title">
                Системный <code>/etc/crontab</code> <span className="muted">(только чтение)</span>
              </h3>
              <div className="ports-scroll">
                <ReadOnlyCronTable
                  entries={systemEntries}
                  showUser
                  emptyText={filterActive ? 'Ничего не найдено по фильтру' : undefined}
                />
              </div>
            </div>
          )}

          {/* /etc/cron.d/* — read-only */}
          {cronDFiles.map((f) => (
            <div className="cron-section" key={f.file}>
              <h3 className="section-title">
                <code>{f.file}</code> <span className="muted">(только чтение)</span>
              </h3>
              <div className="ports-scroll">
                <ReadOnlyCronTable
                  entries={f.entries}
                  showUser
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
