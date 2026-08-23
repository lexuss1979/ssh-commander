import { useEffect, useMemo, useRef, useState } from 'react';
import type { Profile } from '../types';
import {
  DEFAULT_ALERTS_SETTINGS,
  type ActiveAlert,
  type AlertsSettings,
} from '../alerts';

interface Props {
  alerts: ActiveAlert[];
  settings: AlertsSettings;
  profiles: Profile[];
  onOpenProfile: (profileId: string) => void;
  onSaveSettings: (s: AlertsSettings) => void;
  showError: (msg: string) => void;
}

function formatSince(since: number): string {
  const minutes = Math.floor((Date.now() - since) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `уже ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `уже ${hours} ч`;
  return `уже ${Math.floor(hours / 24)} дн`;
}

/**
 * Колокольчик алертов в шапке сайдбара: счётчик активных, выпадающий список
 * и настройки (пороги, браузерные уведомления). Единственная точка входа к
 * настройкам — кнопка не прячется и при выключенных алертах, только
 * приглушается.
 */
export function AlertsBell({ alerts, settings, profiles, onOpenProfile, onSaveSettings, showError }: Props) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Панель закрывается по клику вне неё и по Escape (паттерн меню «В чат ▾»).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // crit выше warn, внутри уровня — старые выше.
  const sorted = useMemo(() => {
    const rank = (a: ActiveAlert) => (a.severity === 'crit' ? 0 : 1);
    return [...alerts].sort((x, y) => rank(x) - rank(y) || x.since - y.since);
  }, [alerts]);

  const hasCrit = alerts.some((a) => a.severity === 'crit');
  const profileName = (id: string): string =>
    profiles.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="alerts-bell-root" ref={rootRef}>
      <button
        type="button"
        className={`alerts-bell${settings.enabled ? '' : ' disabled'}`}
        onClick={() => setOpen((o) => !o)}
        title={settings.enabled ? 'Алерты по порогам' : 'Алерты выключены — открыть настройки'}
      >
        🔔
        {settings.enabled && alerts.length > 0 && (
          <span className={`bell-badge${hasCrit ? ' crit' : ''}`}>{alerts.length}</span>
        )}
      </button>

      {open && (
        <div className="alerts-panel">
          <div className="alerts-panel-head">
            <span className="alerts-panel-title">Алерты</span>
            <button
              type="button"
              className="alerts-gear"
              onClick={() => setSettingsOpen(true)}
              title="Настройки алертов"
            >
              ⚙
            </button>
          </div>
          {!settings.enabled ? (
            <div className="alerts-empty">
              <span>Алерты выключены.</span>
              <span className="field-hint">Включите их в настройках — шестерёнка выше.</span>
            </div>
          ) : sorted.length === 0 ? (
            <div className="alerts-empty">
              <span>Активных алертов нет.</span>
              <span className="field-hint">
                Пороги диска, памяти, load и недоступность сервера — в настройках.
              </span>
            </div>
          ) : (
            <div className="alerts-list">
              {sorted.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={`alert-item${a.severity === 'crit' ? ' crit' : ''}`}
                  onClick={() => {
                    setOpen(false);
                    onOpenProfile(a.profileId);
                  }}
                >
                  <span className="alert-item-head">
                    <strong>{profileName(a.profileId)}</strong>
                    <span className="alert-item-since">{formatSince(a.since)}</span>
                  </span>
                  <span className="alert-item-message">{a.message}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <AlertsSettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => {
            onSaveSettings(s);
            setSettingsOpen(false);
          }}
          showError={showError}
        />
      )}
    </div>
  );
}

interface ModalProps {
  settings: AlertsSettings;
  onClose: () => void;
  onSave: (s: AlertsSettings) => void;
  showError: (msg: string) => void;
}

const clampNum = (raw: string, min: number, max: number, fallback: number): number => {
  const v = Number(raw.replace(',', '.'));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v * 100) / 100));
};

// Закрытие — только кнопками: overlay не закрывает, чтобы заполненные
// пороги не терялись случайным кликом.
function AlertsSettingsModal({ settings, onClose, onSave, showError }: ModalProps) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [disk, setDisk] = useState(String(settings.disk));
  const [mem, setMem] = useState(String(settings.mem));
  const [load, setLoad] = useState(String(settings.load));
  const [notify, setNotify] = useState(settings.notify);
  const notifySupported = typeof Notification !== 'undefined';

  // Разрешение запрашиваем по клику на тумблер, не при загрузке (roadmap).
  const toggleNotify = async (on: boolean) => {
    if (!on) {
      setNotify(false);
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        setNotify(true);
      } else {
        setNotify(false);
        showError('Разрешение на уведомления не выдано');
      }
    } catch {
      setNotify(false);
      showError('Разрешение на уведомления не выдано');
    }
  };

  const save = () => {
    onSave({
      enabled,
      disk: clampNum(disk, 50, 99, DEFAULT_ALERTS_SETTINGS.disk),
      mem: clampNum(mem, 50, 99, DEFAULT_ALERTS_SETTINGS.mem),
      load: clampNum(load, 0.5, 16, DEFAULT_ALERTS_SETTINGS.load),
      notify,
    });
  };

  const resetDefaults = () => {
    setDisk(String(DEFAULT_ALERTS_SETTINGS.disk));
    setMem(String(DEFAULT_ALERTS_SETTINGS.mem));
    setLoad(String(DEFAULT_ALERTS_SETTINGS.load));
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <h2>Настройки алертов</h2>
        </div>
        <div className="modal-body">
          <div className="alerts-settings">
            <label className="alerts-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Алерты включены
            </label>

            <div className="alerts-fields">
              <label className="alerts-field">
                <span>Порог диска, %</span>
                <input
                  type="number"
                  min={50}
                  max={99}
                  step={1}
                  value={disk}
                  onChange={(e) => setDisk(e.target.value)}
                />
              </label>
              <label className="alerts-field">
                <span>Порог памяти, %</span>
                <input
                  type="number"
                  min={50}
                  max={99}
                  step={1}
                  value={mem}
                  onChange={(e) => setMem(e.target.value)}
                />
              </label>
              <label className="alerts-field">
                <span>Порог load на ядро</span>
                <input
                  type="number"
                  min={0.5}
                  max={16}
                  step={0.1}
                  value={load}
                  onChange={(e) => setLoad(e.target.value)}
                />
              </label>
            </div>
            <span className="field-hint">
              Алерт срабатывает при достижении порога и снимается, когда значение
              упадёт ниже порога минус дельта (5% у диска и памяти, 0.5 у load) —
              на границе уведомления не сыплются каждые 10 с.
            </span>

            {notifySupported ? (
              <label className="alerts-toggle">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => void toggleNotify(e.target.checked)}
                />
                Браузерные уведомления
                <span className="field-hint">только когда вкладка неактивна</span>
              </label>
            ) : (
              <span className="field-hint">
                Браузерные уведомления не поддерживаются этим браузером.
              </span>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save}>
            Сохранить
          </button>
          <button className="btn btn-ghost" onClick={resetDefaults}>
            По умолчанию
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
