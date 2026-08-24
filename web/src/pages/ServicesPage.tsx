import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchServiceDetail,
  fetchServices,
  serviceAction,
  serviceLogsUrl,
  type ServiceAction,
  type ServiceDetail,
  type ServicesSnapshot,
  type UnitInfo,
} from '../api';
import type { Profile } from '../types';
import { Modal } from '../components/Modal';
import { SortableTh, useSortBy } from '../hooks/useSortBy';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: 'Запустить',
  stop: 'Остановить',
  restart: 'Перезапустить',
  reload: 'Перезагрузить',
  enable: 'Включить автозапуск',
  disable: 'Выключить автозапуск',
  'reset-failed': 'Сбросить failed',
};

// Точное имя или префикс до `.service` — только усиливает confirm-текст, не блокирует.
const CRITICAL_UNITS = [
  'sshd',
  'ssh',
  'network',
  'networking',
  'networkd',
  'systemd-networkd',
  'firewalld',
  'ufw',
  'fail2ban',
  'docker',
  'containerd',
];

function isCriticalUnit(name: string): boolean {
  const core = name.replace(/\.service$/, '').split('@')[0];
  return CRITICAL_UNITS.includes(core);
}

/** Приоритет статуса для сортировки: failed вверх, затем activating. */
function statusPriority(u: UnitInfo): number {
  if (u.active === 'failed' || u.sub === 'failed') return 0;
  if (u.active === 'activating') return 1;
  return 2;
}

function statusText(u: UnitInfo): string {
  const active = u.active ?? '—';
  if (!u.sub || u.sub === active) return active;
  return `${active} (${u.sub})`;
}

/** Класс чипа статуса с точкой: running/ok, failed/red, exited|activating/amber, остальное нейтральный. */
function statusBadgeClass(u: UnitInfo): string {
  if (u.sub === 'running') return 'running';
  if (u.active === 'failed' || u.sub === 'failed') return 'failed';
  if (u.sub === 'exited') return 'exited';
  if (u.active === 'activating' || u.sub === 'activating') return 'activating';
  return '';
}

function isFailed(u: UnitInfo): boolean {
  return u.active === 'failed' || u.sub === 'failed';
}

/** Класс бейджа автозапуска в карточке (enabled/masked/generated цветные, остальные нейтральные). */
function unitAutoClass(enabled: UnitInfo['enabled']): string {
  if (enabled === 'enabled') return 'enabled';
  if (enabled === 'masked') return 'masked';
  if (enabled === 'generated') return 'generated';
  return '';
}

/** Автозапуск переключаем (enable/disable имеют смысл) только для enabled/disabled. */
function autoToggleable(enabled: UnitInfo['enabled']): boolean {
  return enabled === 'enabled' || enabled === 'disabled';
}

/** Подсказка под switch, когда enable/disable неприменимы. */
function autoHint(enabled: UnitInfo['enabled']): string {
  if (enabled === 'masked') return 'замаскирован — нужен unmask';
  if (enabled === 'static' || enabled === 'indirect' || enabled === 'alias' || enabled === 'generated') {
    return `автозапуск: ${enabled} — управляется системой`;
  }
  return '';
}

const DETAIL_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'MainPID', label: 'PID' },
  { key: 'ActiveState', label: 'Состояние' },
  { key: 'Restart', label: 'Рестарт' },
  { key: 'NRestarts', label: 'Перезапусков' },
  { key: 'Result', label: 'Результат' },
  { key: 'FragmentPath', label: 'Файл unit' },
  { key: 'MemoryCurrent', label: 'Память' },
  { key: 'TasksCurrent', label: 'Задачи' },
  { key: 'ActiveEnterTimestamp', label: 'Запущен' },
];

/** Цель подтверждения: действие + unit + необязательный откат (для switch автозапуска). */
interface ConfirmTarget {
  action: ServiceAction;
  unit: UnitInfo;
  onCancel?: () => void;
}

export function ServicesPage({ profile, visible, showError }: Props) {
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [selected, setSelected] = useState<UnitInfo | null>(null);
  const [detail, setDetail] = useState<ServiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailKey, setDetailKey] = useState(0);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [logsUnit, setLogsUnit] = useState<UnitInfo | null>(null);
  // Уведомление об успешном действии (output systemctl не отбрасываем).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  // sudo-пароль держим в стейте страницы на время жизни вкладки (без persist):
  // после первого ввода повторные действия не спрашивают его заново.
  const [sudoPassword, setSudoPassword] = useState('');
  // Оптимистичное положение switch автозапуска во время подтверждения (откат при отмене).
  const [autoFlip, setAutoFlip] = useState<{ name: string; value: boolean } | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  // Polling 5 с при видимой вкладке; мутации применяют свежий снимок сразу.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await fetchServices(profile.id);
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

  // Деталь выбранного unit'а (и при возврате на вкладку после keep-alive).
  useEffect(() => {
    if (!visible) return;
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchServiceDetail(profile.id, selected.name)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) showError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, selected, visible, detailKey, showError]);

  // Свежий объект выбранного unit'а из последнего снимка (бейдж статуса не устаревает).
  const selectedUnit = useMemo(() => {
    if (!selected) return null;
    return snapshot?.units.find((u) => u.name === selected.name) ?? selected;
  }, [selected, snapshot]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (snapshot?.units ?? []).filter((u) => {
      // Шаблоны из list-unit-files (getty@.service, user@.service) — не
      // инстансы, в таблицу не попадают (инстансы вида getty@tty1.service
      // остаются).
      if (/@\.service$/.test(u.name)) return false;
      if (q && !u.name.toLowerCase().includes(q) && !(u.description ?? '').toLowerCase().includes(q)) {
        return false;
      }
      // «только запущенные» и «только сбойные» — ИЛИ: две галочки вместе
      // дают объединение, а не всегда пустой список (логическое И).
      if (onlyRunning || onlyFailed) {
        const running = onlyRunning && u.sub === 'running';
        const failed = onlyFailed && isFailed(u);
        if (!running && !failed) return false;
      }
      return true;
    });
  }, [snapshot, filter, onlyRunning, onlyFailed]);

  const accessors = useMemo(
    () => ({
      name: (u: UnitInfo) => u.name,
      description: (u: UnitInfo) => u.description ?? '',
      status: (u: UnitInfo) => statusPriority(u),
      enabled: (u: UnitInfo) => u.enabled ?? '',
    }),
    [],
  );

  // Дефолт — failed вверх (приоритет failed → activating → остальные).
  const { sort, toggle, sorted } = useSortBy(filtered, accessors, { key: 'status', dir: 'asc' });

  const handleActionRequest = (unit: UnitInfo, action: ServiceAction, onCancel?: () => void) => {
    setConfirm({ action, unit, onCancel });
    setConfirmError(null);
  };

  const closeConfirm = () => {
    confirm?.onCancel?.();
    setConfirm(null);
  };

  // Переключение switch автозапуска: оптимистичный флип + подтверждение + откат при отмене.
  const handleAutoToggle = (unit: UnitInfo, newValue: boolean) => {
    const action: ServiceAction = newValue ? 'enable' : 'disable';
    setAutoFlip({ name: unit.name, value: newValue });
    handleActionRequest(unit, action, () => setAutoFlip(null));
  };

  const handleConfirmAction = async () => {
    if (!confirm) return;
    setActionBusy(true);
    setConfirmError(null);
    try {
      const result = await serviceAction(profile.id, confirm.unit.name, confirm.action, sudoPassword || undefined);
      setConfirm(null);
      setAutoFlip(null);
      showNotice(
        `${ACTION_LABELS[confirm.action]}: ${confirm.unit.name}${result.output ? ` — ${result.output}` : ''}`,
      );
      // Немедленный refetch снимка (кэш сброшен на сервере после мутации).
      setReloadKey((k) => k + 1);
      if (selected?.name === confirm.unit.name) {
        setDetailKey((k) => k + 1);
      }
    } catch (err) {
      setConfirmError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  // Состояние switch автозапуска для выбранного unit'а.
  const selEnabled = selectedUnit?.enabled ?? null;
  const flipping = autoFlip?.name === selectedUnit?.name;
  const autoOn = flipping ? (autoFlip?.value ?? false) : selEnabled === 'enabled';
  const autoDisabled = !(autoToggleable(selEnabled) || flipping);
  const autoHintText = autoHint(selEnabled);

  return (
    <div className="page services-page">
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
          placeholder="Фильтр по имени или описанию…"
        />
        <label className="check">
          <input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} />
          только запущенные
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
          только сбойные
        </label>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {!snapshot ? (
        <div className="empty-state">
          <p>Загрузка списка служб…</p>
        </div>
      ) : error && snapshot.units.length === 0 ? (
        <div className="empty-state">
          <p>Сервер недоступен: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : !snapshot.available ? (
        <div className="empty-state">
          <p>{snapshot.reason ?? 'systemd недоступен'}</p>
          <p className="muted">
            systemd не обнаружен (Alpine/OpenRC/контейнер?) — управление службами недоступно
          </p>
        </div>
      ) : (
        <div className="ports-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh sortKey="name" currentSort={sort} onToggle={toggle}>
                  Служба
                </SortableTh>
                <SortableTh sortKey="status" currentSort={sort} onToggle={toggle}>
                  Статус
                </SortableTh>
                <th className="col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => (
                <tr
                  key={u.name}
                  className={selectedUnit?.name === u.name ? 'selected' : ''}
                  onClick={() => setSelected(u)}
                >
                  <td>
                    <div className="cell-main">
                      <div className="cell-top">
                        <span className={`unit-auto ${unitAutoClass(u.enabled)}`}>{u.enabled ?? '—'}</span>
                      </div>
                      <span className="name" title={u.name}>
                        {u.name}
                      </span>
                      <span className="image" title={u.description ?? ''}>
                        {u.description || '—'}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`status-badge ${statusBadgeClass(u)}`}>
                      <i className="sb-dot" />
                      {statusText(u)}
                    </span>
                  </td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <button
                        className="btn btn-mini icon-btn btn-primary"
                        title="Перезапустить"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleActionRequest(u, 'restart');
                        }}
                      >
                        ↻
                      </button>
                      <span className="action-sep" />
                      <button
                        className="btn btn-mini icon-btn btn-ghost"
                        title="Журнал"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLogsUnit(u);
                        }}
                      >
                        ≡
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {snapshot && sorted.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    {filter.trim() !== '' || onlyRunning || onlyFailed
                      ? 'Ничего не найдено по фильтру'
                      : 'Служб нет'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedUnit && (
        <ServiceDetailModal
          unit={selectedUnit}
          detail={detail}
          loading={detailLoading}
          autoOn={autoOn}
          autoDisabled={autoDisabled}
          autoHint={autoHintText}
          onToggleAuto={(v) => handleAutoToggle(selectedUnit, v)}
          onAction={handleActionRequest}
          onLogs={() => setLogsUnit(selectedUnit)}
          onClose={() => setSelected(null)}
        />
      )}

      {confirm && (
        <ActionConfirmModal
          unit={confirm.unit}
          action={confirm.action}
          busy={actionBusy}
          error={confirmError}
          sudoPassword={sudoPassword}
          onSudoPasswordChange={setSudoPassword}
          onClose={closeConfirm}
          onConfirm={handleConfirmAction}
        />
      )}

      {logsUnit && (
        <ServiceLogsModal
          profile={profile}
          unit={logsUnit}
          visible={visible}
          onClose={() => setLogsUnit(null)}
          showError={showError}
        />
      )}

      {notice && <div className="toast toast-notice">{notice}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Деталь unit'а — модальное окно
// ---------------------------------------------------------------------------

function ServiceDetailModal({
  unit,
  detail,
  loading,
  autoOn,
  autoDisabled,
  autoHint,
  onToggleAuto,
  onAction,
  onLogs,
  onClose,
}: {
  unit: UnitInfo;
  detail: ServiceDetail | null;
  loading: boolean;
  autoOn: boolean;
  autoDisabled: boolean;
  autoHint: string;
  onToggleAuto: (newValue: boolean) => void;
  onAction: (unit: UnitInfo, action: ServiceAction, onCancel?: () => void) => void;
  onLogs: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={unit.name} onClose={onClose} wide>
      <div className="svc-head">
        <span className={`status-badge ${statusBadgeClass(unit)}`}>
          <i className="sb-dot" />
          {statusText(unit)}
        </span>
        <label className="svc-switch">
          <span className="muted">автозапуск</span>
          <span className="switch">
            <input
              type="checkbox"
              checked={autoOn}
              disabled={autoDisabled}
              onChange={(e) => onToggleAuto(e.target.checked)}
            />
            <span className="slider" />
          </span>
          {autoHint && (
            <span className="muted" style={{ fontSize: 11 }}>
              {autoHint}
            </span>
          )}
        </label>
      </div>

      <div className="services-actions">
        <button className="btn btn-mini btn-primary" onClick={() => onAction(unit, 'start')}>
          Запустить
        </button>
        <button className="btn btn-mini btn-danger" onClick={() => onAction(unit, 'stop')}>
          Остановить
        </button>
        <button className="btn btn-mini btn-ghost" onClick={() => onAction(unit, 'restart')}>
          Перезапустить
        </button>
        <button className="btn btn-mini btn-ghost" onClick={() => onAction(unit, 'reload')}>
          Перезагрузить
        </button>
        {isFailed(unit) && (
          <button className="btn btn-mini btn-danger" onClick={() => onAction(unit, 'reset-failed')}>
            {ACTION_LABELS['reset-failed']}
          </button>
        )}
        <span className="action-sep" />
        <button className="btn btn-mini btn-ghost" onClick={onLogs}>
          Журнал
        </button>
      </div>

      {loading && !detail && <p className="muted services-detail-loading">Загрузка деталей…</p>}
      {detail && (
        <>
          <div className="detail-grid">
            {DETAIL_FIELDS.map((f) => (
              <div className="detail-cell" key={f.key}>
                <span className="muted">{f.label}</span>
                <span className="detail-value">{detail.show[f.key] ?? '—'}</span>
              </div>
            ))}
          </div>
          <pre className="logs-view services-status">{detail.status || '(статус пуст)'}</pre>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Модалка подтверждения действия
// ---------------------------------------------------------------------------

function ActionConfirmModal({
  unit,
  action,
  busy,
  error,
  sudoPassword,
  onSudoPasswordChange,
  onClose,
  onConfirm,
}: {
  unit: UnitInfo;
  action: ServiceAction;
  busy: boolean;
  error: string | null;
  sudoPassword: string;
  onSudoPasswordChange: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const label = ACTION_LABELS[action];
  const critical = isCriticalUnit(unit.name);
  return (
    <Modal title={`${label}: ${unit.name}`} onClose={onClose}>
      <p>
        {label} <code>{unit.name}</code>?
      </p>
      {critical && (
        <p className="critical-warning">⚠ Это может оборвать SSH/сеть на сервере — продолжить?</p>
      )}
      <label>
        sudo-пароль (если нужны права)
        <input
          type="password"
          value={sudoPassword}
          onChange={(e) => onSudoPasswordChange(e.target.value)}
          placeholder="оставьте пустым, если прав хватает"
          autoComplete="off"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {' '}передаётся только на этот запрос
        </span>
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Отмена
        </button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Выполняется…' : label}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Просмотрщик журнала unit'а (минимальный inline по образцу LogsModal)
// ---------------------------------------------------------------------------

const LOG_BUFFER_LIMIT = 500 * 1024;

function ServiceLogsModal({
  profile,
  unit,
  visible,
  onClose,
  showError,
}: {
  profile: Profile;
  unit: UnitInfo;
  visible: boolean;
  onClose: () => void;
  showError: (msg: string) => void;
}) {
  const [follow, setFollow] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [tail, setTail] = useState(500);
  const [started, setStarted] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [failed, setFailed] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(autoScroll);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  const append = useCallback((text: string) => {
    const el = preRef.current;
    if (!el) return;
    let next = (el.textContent ?? '') + text;
    // Кольцевая обрезка буфера ~500 КБ по границе строки.
    if (next.length > LOG_BUFFER_LIMIT) {
      const nl = next.indexOf('\n', next.length - LOG_BUFFER_LIMIT);
      next = next.slice(nl >= 0 ? nl + 1 : next.length - LOG_BUFFER_LIMIT);
    }
    el.textContent = next;
    if (autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    // Вкладка скрыта (keep-alive) — стрим на паузе, возобновится при возврате.
    if (!visible) return;
    let cancelled = false;
    const controller = new AbortController();
    setStarted(true);
    setHasContent(false);
    setFailed(false);
    if (preRef.current) preRef.current.textContent = '';

    void fetch(serviceLogsUrl(profile.id, unit.name, tail, follow), {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 429) {
          let message = 'достигнут лимит одновременных журналов на сервер';
          try {
            message = (await res.json()).error ?? message;
          } catch {
            /* noop */
          }
          throw new Error(message);
        }
        if (!res.ok || !res.body) {
          let message = res.statusText;
          try {
            message = (await res.json()).error ?? message;
          } catch {
            /* noop */
          }
          throw new Error(message);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text) setHasContent(true);
          append(text);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setFailed(true);
        if ((err as Error).name !== 'AbortError') showError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setStarted(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [profile.id, unit.name, tail, follow, visible, showError, append]);

  return (
    <Modal title={`Журнал: ${unit.name}`} onClose={onClose} wide>
      <div className="logs-toolbar">
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Следовать за логами
        </label>
        <label className="check">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Автоскролл
        </label>
        <label>
          Строк:{' '}
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
            <option value={5000}>5000</option>
          </select>
        </label>
        {started && <span className="muted">подключено…</span>}
      </div>
      <pre className="logs-view" ref={preRef} />
      {!started && !hasContent && !failed && (
        <p className="muted services-log-hint">
          Журнал пуст или недоступен: для чтения системного журнала пользователь должен быть в группе{' '}
          <code>adm</code> или <code>systemd-journal</code>
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}
