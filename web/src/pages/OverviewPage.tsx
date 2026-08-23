import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetrics, fetchMetricsHistory, processRenice, processSignal } from '../api';
import type { HistorySample, ProcessSignal, ServerMetrics } from '../api';
import type { Profile } from '../types';
import { useSortBy, SortableTh } from '../hooks/useSortBy';
import { LoadChart } from '../components/Sparkline';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 3000;

/** Строка таблицы процессов (элемент `metrics.processes`). */
type ProcRow = ServerMetrics['processes'][number];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} дн ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(1)}%`;
}

function meterClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return '';
}

export function Meter({ percent }: { percent: number | null }) {
  return (
    <div className="meter">
      <div
        className={`meter-fill ${meterClass(percent)}`}
        style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
      />
    </div>
  );
}

export function OverviewPage({ profile, visible }: Props) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Действия над процессами (эпик 17): цель модалки, статус, sudo-пароль.
  const [actionTarget, setActionTarget] = useState<ProcRow | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // sudo-пароль держим в стейте страницы на время жизни вкладки (без persist):
  // после первого ввода повторные действия не спрашивают его заново (паттерн
  // ServicesPage, комментарий тот же).
  const [sudoPassword, setSudoPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

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

  // Последовательный polling: следующий запрос только после завершения
  // предыдущего. На скрытой вкладке (keep-alive) опрос полностью остановлен.
  // История нагрузки грузится тем же тиком, но её ошибки тихие — графики
  // декоративные, при сбое остаётся последнее нарисованное.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      const [mRes, hRes] = await Promise.allSettled([
        fetchMetrics(profile.id),
        fetchMetricsHistory(profile.id),
      ]);
      if (cancelled) return;
      if (mRes.status === 'fulfilled') {
        setMetrics(mRes.value);
        setError(null);
      } else {
        setError((mRes.reason as Error).message);
      }
      if (hRes.status === 'fulfilled') {
        setHistory(hRes.value.samples);
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

  const mem = metrics?.memory;

  const processes = metrics?.processes ?? [];
  const procAccessors = useMemo(() => ({
    command: (p: ProcRow) => p.command,
    pid: (p: ProcRow) => p.pid,
    user: (p: ProcRow) => p.user,
    cpu: (p: ProcRow) => p.cpuPercent ?? 0,
    mem: (p: ProcRow) => p.memPercent ?? 0,
  }), []);
  const { sort: procSort, toggle: toggleProcSort, sorted: sortedProcesses } = useSortBy(processes, procAccessors, { key: 'cpu', dir: 'desc' });

  /** Подтверждённое действие из модалки: сигнал или renice с sudo-ретраем.
   * После успеха — кэш метрик сброшен на сервере, тик polling'а сработает
   * немедленно против свежего снимка. */
  const handleProcessAction = async (action: ProcessModalAction, nice: number) => {
    if (!actionTarget) return;
    setActionBusy(true);
    setConfirmError(null);
    try {
      if (action === 'renice') {
        const result = await processRenice(profile.id, actionTarget.pid, nice, sudoPassword || undefined);
        setActionTarget(null);
        showNotice(`Приоритет процесса ${actionTarget.pid} изменён${result.output ? ` — ${result.output}` : ''}`);
      } else {
        await processSignal(profile.id, actionTarget.pid, action, sudoPassword || undefined);
        setActionTarget(null);
        showNotice(`Сигнал ${action} отправлен процессу ${actionTarget.pid}`);
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      setConfirmError((err as Error).message);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="page overview-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? `Нет связи: ${error}`
            : metrics
              ? `Обновлено ${new Date(metrics.timestamp).toLocaleTimeString('ru-RU')}`
              : 'Загрузка…'}
        </span>
        <div className="toolbar-actions">
          <span className="muted">
            {profile.name} — {profile.username}@{profile.host}
          </span>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Обновить
          </button>
        </div>
      </div>

      {error && !metrics ? (
        <div className="empty-state">
          <p>Сервер недоступен: {error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      ) : (
        <div className="overview-scroll">
          <div className="overview-grid">
            <div className="overview-card">
              <div className="overview-card-title">Процессор</div>
              <div className="overview-big">{formatPct(metrics?.cpu.percent ?? null)}</div>
              <Meter percent={metrics?.cpu.percent ?? null} />
              <div className="overview-sub">
                Ядер: {metrics?.cpu.cores ?? '—'}
              </div>
              <LoadChart samples={history} value={(s) => s.cpu} tone="cpu" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Память</div>
              <div className="overview-big">{formatPct(mem?.usedPercent ?? null)}</div>
              <Meter percent={mem?.usedPercent ?? null} />
              <div className="overview-sub">
                {formatBytes(mem?.usedBytes ?? null)} из {formatBytes(mem?.totalBytes ?? null)}
              </div>
              <LoadChart samples={history} value={(s) => s.memPct} tone="mem" />
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Аптайм и нагрузка</div>
              <div className="overview-big">{formatUptime(metrics?.uptimeSeconds ?? null)}</div>
              <div className="overview-sub">
                Load average (1/5/15 мин):{' '}
                {metrics?.loadAverage ? metrics.loadAverage.map((n) => n.toFixed(2)).join(' / ') : '—'}
              </div>
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Диски</div>
              {metrics && metrics.disks.length === 0 && (
                <div className="overview-sub">Нет данных</div>
              )}
              {!metrics && <div className="overview-sub">Загрузка…</div>}
              {(metrics?.disks ?? []).map((d) => (
                <div className="disk-row" key={d.mount}>
                  <div className="disk-row-head">
                    <span className="mount" title={d.filesystem}>
                      {d.mount}
                    </span>
                    <span className="sizes">
                      {formatBytes(d.usedBytes)} из {formatBytes(d.totalBytes)}
                    </span>
                  </div>
                  <Meter percent={d.usedPercent} />
                </div>
              ))}
            </div>
          </div>

          <div className="overview-card overview-processes">
            <div className="overview-card-title">Топ процессов по CPU</div>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh sortKey="command" currentSort={procSort} onToggle={toggleProcSort}>Процесс</SortableTh>
                  <SortableTh sortKey="pid" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">PID</SortableTh>
                  <SortableTh sortKey="user" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">Пользователь</SortableTh>
                  <SortableTh sortKey="cpu" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">CPU</SortableTh>
                  <SortableTh sortKey="mem" currentSort={procSort} onToggle={toggleProcSort} className="col-narrow">Память</SortableTh>
                  <th className="col-actions">Действия</th>
                </tr>
              </thead>
              <tbody>
                {sortedProcesses.map((p) => (
                  <tr key={p.pid}>
                    <td className="proc-command" title={p.command}>
                      {p.command}
                    </td>
                    <td>{p.pid}</td>
                    <td>{p.user}</td>
                    <td>{formatPct(p.cpuPercent)}</td>
                    <td>{formatPct(p.memPercent)}</td>
                    <td className="col-actions">
                      <button
                        className="btn btn-ghost btn-small"
                        title={`Действия над процессом ${p.pid}`}
                        onClick={() => {
                          setActionTarget(p);
                          setConfirmError(null);
                        }}
                      >
                        ⋯
                      </button>
                    </td>
                  </tr>
                ))}
                {metrics && sortedProcesses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Нет данных
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {actionTarget && (
        <ProcessActionModal
          process={actionTarget}
          profileUsername={profile.username}
          busy={actionBusy}
          error={confirmError}
          sudoPassword={sudoPassword}
          onSudoPasswordChange={setSudoPassword}
          onClose={() => setActionTarget(null)}
          onConfirm={handleProcessAction}
        />
      )}

      {notice && <div className="toast toast-notice">{notice}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Модалка действий над процессом (эпик 17)
// ---------------------------------------------------------------------------

type ProcessModalAction = ProcessSignal | 'renice';

const PROCESS_ACTION_LABELS: Record<ProcessModalAction, string> = {
  TERM: 'Завершить (TERM)',
  KILL: 'Убить (KILL)',
  HUP: 'Перечитать конфиг (HUP)',
  renice: 'Понизить приоритет',
};

function ProcessActionModal({
  process: p,
  profileUsername,
  busy,
  error,
  sudoPassword,
  onSudoPasswordChange,
  onClose,
  onConfirm,
}: {
  process: ProcRow;
  profileUsername: string;
  busy: boolean;
  error: string | null;
  sudoPassword: string;
  onSudoPasswordChange: (v: string) => void;
  onClose: () => void;
  onConfirm: (action: ProcessModalAction, nice: number) => void;
}) {
  const [action, setAction] = useState<ProcessModalAction>('TERM');
  const [nice, setNice] = useState(5);

  // Превью команды mono: сервер соберёт ровно её (кроме sudo-обёртки).
  const command = action === 'renice' ? `renice -n ${nice} -p ${p.pid}` : `kill -${action} ${p.pid}`;

  // Предупреждения усиливают подтверждение, не блокируют (roadmap).
  const warnings: string[] = [];
  if (p.user !== profileUsername) {
    warnings.push('Процесс другого пользователя — потребуется sudo-пароль');
  }
  if (p.pid < 100) {
    warnings.push('Похоже на системный процесс ядра — остановка может уронить сервер');
  }
  if (action === 'KILL') {
    warnings.push('KILL не даёт процессу сохранить данные — сначала попробуйте TERM');
  }

  const actionBtnClass = (a: ProcessModalAction): string => {
    if (a !== action) return 'btn btn-ghost btn-small';
    return a === 'KILL' ? 'btn btn-danger btn-small' : 'btn btn-primary btn-small';
  };

  return (
    <Modal title={`Процесс ${p.pid}`} onClose={onClose}>
      <div className="process-summary">
        <div className="proc-command" title={p.command}>
          {p.command}
        </div>
        <div className="muted">
          PID {p.pid} · {p.user} · CPU {formatPct(p.cpuPercent)} · память {formatPct(p.memPercent)}
        </div>
      </div>

      <div className="process-action-row">
        {(['TERM', 'KILL', 'HUP', 'renice'] as const).map((a) => (
          <button key={a} className={actionBtnClass(a)} onClick={() => setAction(a)}>
            {PROCESS_ACTION_LABELS[a]}
          </button>
        ))}
      </div>

      {action === 'renice' && (
        <label>
          Новый приоритет (nice)
          <input
            type="number"
            min={-20}
            max={19}
            value={nice}
            onChange={(e) => setNice(Number(e.target.value))}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {' '}−20..19; понижение (ускорение) требует root
          </span>
        </label>
      )}

      <pre className="process-preview">{command}</pre>

      {warnings.length > 0 && (
        <div className="process-warnings">
          {warnings.map((w, i) => (
            <p key={i} className="process-warning">⚠ {w}</p>
          ))}
        </div>
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
        <button
          className={`btn ${action === 'KILL' ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => onConfirm(action, nice)}
          disabled={busy}
        >
          {busy ? 'Выполняется…' : PROCESS_ACTION_LABELS[action]}
        </button>
      </div>
    </Modal>
  );
}
