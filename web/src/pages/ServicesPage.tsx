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
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

const ACTION_LABELS: Record<ServiceAction, I18nKey> = {
  start: 'services.actionStart',
  stop: 'services.actionStop',
  restart: 'services.actionRestart',
  reload: 'services.actionReload',
  enable: 'services.actionEnable',
  disable: 'services.actionDisable',
  'reset-failed': 'services.actionResetFailed',
};

// Exact name or a prefix up to `.service` — only strengthens the confirm text, never blocks.
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

/** Status priority for sorting: failed on top, then activating. */
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

/** Status chip class with a dot: running/ok, failed/red, exited|activating/amber, anything else neutral. */
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

/** Autostart badge class in the card (enabled/masked/generated are colored, the rest neutral). */
function unitAutoClass(enabled: UnitInfo['enabled']): string {
  if (enabled === 'enabled') return 'enabled';
  if (enabled === 'masked') return 'masked';
  if (enabled === 'generated') return 'generated';
  return '';
}

/** Autostart is toggleable (enable/disable make sense) only for enabled/disabled. */
function autoToggleable(enabled: UnitInfo['enabled']): boolean {
  return enabled === 'enabled' || enabled === 'disabled';
}

/** Hint under the switch when enable/disable do not apply. */
function autoHint(t: TFn, enabled: UnitInfo['enabled']): string {
  if (enabled === 'masked') return t('services.autoHintMasked');
  if (enabled === 'static' || enabled === 'indirect' || enabled === 'alias' || enabled === 'generated') {
    return t('services.autoHintSystem', { mode: enabled });
  }
  return '';
}

const DETAIL_FIELDS: Array<{ key: string; label: I18nKey }> = [
  { key: 'MainPID', label: 'services.fieldPid' },
  { key: 'ActiveState', label: 'services.fieldState' },
  { key: 'Restart', label: 'services.fieldRestart' },
  { key: 'NRestarts', label: 'services.fieldRestarts' },
  { key: 'Result', label: 'services.fieldResult' },
  { key: 'FragmentPath', label: 'services.fieldUnitFile' },
  { key: 'MemoryCurrent', label: 'services.fieldMemory' },
  { key: 'TasksCurrent', label: 'services.fieldTasks' },
  { key: 'ActiveEnterTimestamp', label: 'services.fieldStarted' },
];

/** Confirmation target: action + unit + optional rollback (for the autostart switch). */
interface ConfirmTarget {
  action: ServiceAction;
  unit: UnitInfo;
  onCancel?: () => void;
}

export function ServicesPage({ profile, visible, showError }: Props) {
  const { t, locale } = useT();
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
  // Success notice for an action (the systemctl output is not discarded).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  // The sudo password lives in the page state for the lifetime of the tab (not persisted):
  // after the first entry, subsequent actions do not ask for it again.
  const [sudoPassword, setSudoPassword] = useState('');
  // Optimistic position of the autostart switch during confirmation (rolled back on cancel).
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

  // 5s polling while the tab is visible; mutations apply the fresh snapshot right away.
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

  // Detail of the selected unit (also when returning to the tab after keep-alive).
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

  // Fresh object of the selected unit from the latest snapshot (the status badge never goes stale).
  const selectedUnit = useMemo(() => {
    if (!selected) return null;
    return snapshot?.units.find((u) => u.name === selected.name) ?? selected;
  }, [selected, snapshot]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (snapshot?.units ?? []).filter((u) => {
      // Templates from list-unit-files (getty@.service, user@.service) are not
      // instances and do not reach the table (instances like getty@tty1.service
      // stay).
      if (/@\.service$/.test(u.name)) return false;
      if (q && !u.name.toLowerCase().includes(q) && !(u.description ?? '').toLowerCase().includes(q)) {
        return false;
      }
      // "only running" and "only failed" are OR: both checkboxes together
      // give a union, not an always-empty list (logical AND).
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

  // Default — failed on top (priority failed → activating → the rest).
  const { sort, toggle, sorted } = useSortBy(filtered, accessors, { key: 'status', dir: 'asc' });

  const handleActionRequest = (unit: UnitInfo, action: ServiceAction, onCancel?: () => void) => {
    setConfirm({ action, unit, onCancel });
    setConfirmError(null);
  };

  const closeConfirm = () => {
    confirm?.onCancel?.();
    setConfirm(null);
  };

  // Toggling the autostart switch: optimistic flip + confirmation + rollback on cancel.
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
        `${t(ACTION_LABELS[confirm.action])}: ${confirm.unit.name}${result.output ? ` — ${result.output}` : ''}`,
      );
      // Immediate snapshot refetch (the cache is invalidated on the server after the mutation).
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

  // Autostart switch state for the selected unit.
  const selEnabled = selectedUnit?.enabled ?? null;
  const flipping = autoFlip?.name === selectedUnit?.name;
  const autoOn = flipping ? (autoFlip?.value ?? false) : selEnabled === 'enabled';
  const autoDisabled = !(autoToggleable(selEnabled) || flipping);
  const autoHintText = autoHint(t, selEnabled);

  return (
    <div className="page services-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? t('common.noConnection', { error })
            : snapshot
              ? t('common.updated', { time: new Date(snapshot.timestamp).toLocaleTimeString(locale) })
              : t('common.loading')}
        </span>
        <input
          className="search-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('services.filterPlaceholder')}
        />
        <label className="check">
          <input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} />
          {t('services.onlyRunning')}
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
          {t('services.onlyFailed')}
        </label>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {!snapshot ? (
        <div className="empty-state">
          <p>{t('services.loadingList')}</p>
        </div>
      ) : error && snapshot.units.length === 0 ? (
        <div className="empty-state">
          <p>{t('common.serverUnavailable', { error })}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : !snapshot.available ? (
        <div className="empty-state">
          <p>{snapshot.reason ?? t('services.systemdUnavailable')}</p>
          <p className="muted">
            {t('services.systemdNotFoundHint')}
          </p>
        </div>
      ) : (
        <div className="ports-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh sortKey="name" currentSort={sort} onToggle={toggle}>
                  {t('services.colService')}
                </SortableTh>
                <SortableTh sortKey="status" currentSort={sort} onToggle={toggle}>
                  {t('services.colStatus')}
                </SortableTh>
                <th className="col-actions">{t('services.colActions')}</th>
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
                        title={t('services.actionRestart')}
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
                        title={t('services.logs')}
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
                      ? t('services.filterEmpty')
                      : t('services.noServices')}
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
// Unit detail modal
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
  const { t } = useT();
  return (
    <Modal title={unit.name} onClose={onClose} wide>
      <div className="svc-head">
        <span className={`status-badge ${statusBadgeClass(unit)}`}>
          <i className="sb-dot" />
          {statusText(unit)}
        </span>
        <label className="svc-switch">
          <span className="muted">{t('services.autostart')}</span>
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
          {t(ACTION_LABELS.start)}
        </button>
        <button className="btn btn-mini btn-danger" onClick={() => onAction(unit, 'stop')}>
          {t(ACTION_LABELS.stop)}
        </button>
        <button className="btn btn-mini btn-ghost" onClick={() => onAction(unit, 'restart')}>
          {t(ACTION_LABELS.restart)}
        </button>
        <button className="btn btn-mini btn-ghost" onClick={() => onAction(unit, 'reload')}>
          {t(ACTION_LABELS.reload)}
        </button>
        {isFailed(unit) && (
          <button className="btn btn-mini btn-danger" onClick={() => onAction(unit, 'reset-failed')}>
            {t(ACTION_LABELS['reset-failed'])}
          </button>
        )}
        <span className="action-sep" />
        <button className="btn btn-mini btn-ghost" onClick={onLogs}>
          {t('services.logs')}
        </button>
      </div>

      {loading && !detail && <p className="muted services-detail-loading">{t('services.detailLoading')}</p>}
      {detail && (
        <>
          <div className="detail-grid">
            {DETAIL_FIELDS.map((f) => (
              <div className="detail-cell" key={f.key}>
                <span className="muted">{t(f.label)}</span>
                <span className="detail-value">{detail.show[f.key] ?? '—'}</span>
              </div>
            ))}
          </div>
          <pre className="logs-view services-status">{detail.status || t('services.statusEmpty')}</pre>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Action confirmation modal
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
  const { t } = useT();
  const label = t(ACTION_LABELS[action]);
  const critical = isCriticalUnit(unit.name);
  return (
    <Modal title={`${label}: ${unit.name}`} onClose={onClose}>
      <p>
        {label} <code>{unit.name}</code>?
      </p>
      {critical && (
        <p className="critical-warning">{t('services.criticalWarning')}</p>
      )}
      <label>
        {t('services.sudoPasswordLabel')}
        <input
          type="password"
          value={sudoPassword}
          onChange={(e) => onSudoPasswordChange(e.target.value)}
          placeholder={t('services.sudoPasswordPlaceholder')}
          autoComplete="off"
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {' '}{t('services.sudoPasswordHint')}
        </span>
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          {busy ? t('services.actionRunning') : label}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Unit log viewer (minimal inline viewer modeled after LogsModal)
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
  const { t } = useT();
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
    // Ring-buffer trim of the buffer at ~500 KB on a line boundary.
    if (next.length > LOG_BUFFER_LIMIT) {
      const nl = next.indexOf('\n', next.length - LOG_BUFFER_LIMIT);
      next = next.slice(nl >= 0 ? nl + 1 : next.length - LOG_BUFFER_LIMIT);
    }
    el.textContent = next;
    if (autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    // Tab hidden (keep-alive) — the stream is paused and resumes on return.
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
          let message = t('services.logsLimitReached');
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
  }, [profile.id, unit.name, tail, follow, visible, showError, append, t]);

  return (
    <Modal title={t('services.logsTitle', { name: unit.name })} onClose={onClose} wide>
      <div className="logs-toolbar">
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          {t('services.followLogs')}
        </label>
        <label className="check">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          {t('services.autoscroll')}
        </label>
        <label>
          {t('services.tailLabel')}{' '}
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
            <option value={5000}>5000</option>
          </select>
        </label>
        {started && <span className="muted">{t('services.connected')}</span>}
      </div>
      <pre className="logs-view" ref={preRef} />
      {!started && !hasContent && !failed && (
        <p className="muted services-log-hint">
          {t('services.logHintPre')}{' '}
          <code>adm</code> {t('services.logHintOr')} <code>systemd-journal</code>
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
