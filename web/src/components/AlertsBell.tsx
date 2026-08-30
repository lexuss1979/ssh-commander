import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Profile } from '../types';
import {
  DEFAULT_ALERTS_SETTINGS,
  type ActiveAlert,
  type AlertsSettings,
} from '../alerts';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

interface Props {
  alerts: ActiveAlert[];
  settings: AlertsSettings;
  profiles: Profile[];
  onOpenProfile: (profileId: string) => void;
  onSaveSettings: (s: AlertsSettings) => void;
  showError: (msg: string) => void;
}

function formatSince(since: number, t: TFn): string {
  const minutes = Math.floor((Date.now() - since) / 60000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('alerts.sinceMinutes', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('alerts.sinceHours', hours);
  return t('alerts.sinceDays', Math.floor(hours / 24));
}

/**
 * Колокольчик алертов в шапке сайдбара: счётчик активных, выпадающий список
 * и настройки (пороги, браузерные уведомления). Единственная точка входа к
 * настройкам — кнопка не прячется и при выключенных алертах, только
 * приглушается.
 */
export function AlertsBell({ alerts, settings, profiles, onOpenProfile, onSaveSettings, showError }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Позиция панели (fixed), чтобы она не выходила за край экрана: считается по
  // колокольчику при открытии и клампится по ширине/высоте вьюпорта.
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const bell = bellRef.current;
    const panel = panelRef.current;
    if (!bell || !panel) return;
    const b = bell.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(b.left, window.innerWidth - p.width - margin));
    const top = Math.max(margin, Math.min(b.bottom + margin, window.innerHeight - p.height - margin));
    setPanelPos({ left, top });
  }, [open]);

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
        ref={bellRef}
        type="button"
        className={`alerts-bell${settings.enabled ? '' : ' disabled'}`}
        onClick={() => setOpen((o) => !o)}
        title={settings.enabled ? t('alerts.titleEnabled') : t('alerts.titleDisabled')}
      >
        🔔
        {settings.enabled && alerts.length > 0 && (
          <span className={`bell-badge${hasCrit ? ' crit' : ''}`}>{alerts.length}</span>
        )}
      </button>

      {open && (
        <div
          className="alerts-panel"
          ref={panelRef}
          style={panelPos ? { left: panelPos.left, top: panelPos.top } : undefined}
        >
          <div className="alerts-panel-head">
            <span className="alerts-panel-title">{t('alerts.panelTitle')}</span>
            <button
              type="button"
              className="alerts-gear"
              onClick={() => setSettingsOpen(true)}
              title={t('alerts.settingsTitle')}
            >
              ⚙
            </button>
          </div>
          {!settings.enabled ? (
            <div className="alerts-empty">
              <span>{t('alerts.disabledText')}</span>
              <span className="field-hint">{t('alerts.disabledHint')}</span>
            </div>
          ) : sorted.length === 0 ? (
            <div className="alerts-empty">
              <span>{t('alerts.empty')}</span>
              <span className="field-hint">
                {t('alerts.emptyHint')}
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
                    <span className="alert-item-since">{formatSince(a.since, t)}</span>
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
  const { t } = useT();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [disk, setDisk] = useState(String(settings.disk));
  const [mem, setMem] = useState(String(settings.mem));
  const [load, setLoad] = useState(String(settings.load));
  const [notify, setNotify] = useState(settings.notify);
  const notifySupported = typeof Notification !== 'undefined';

  // Overlay модалку не закрывает (пороги не теряются случайным кликом),
  // Escape — закрывает.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Разрешение запрашиваем по клику на тумблер, не при загрузке (roadmap).
  const toggleNotify = async (on: boolean) => {
    if (!on) {
      setNotify(false);
      return;
    }
    try {
      // Legacy-Safari возвращает undefined (callback-API) — оборачиваем
      // оба варианта в промис.
      const result: unknown = Notification.requestPermission();
      const perm = typeof result === 'string' ? result : await result;
      if (perm === 'granted') {
        setNotify(true);
      } else {
        setNotify(false);
        showError(t('alerts.notifyDenied'));
      }
    } catch {
      setNotify(false);
      showError(t('alerts.notifyDenied'));
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
          <h2>{t('alerts.settingsTitle')}</h2>
        </div>
        <div className="modal-body">
          <div className="alerts-settings">
            <label className="alerts-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t('alerts.enabledLabel')}
            </label>

            <div className="alerts-fields">
              <label className="alerts-field">
                <span>{t('alerts.diskThreshold')}</span>
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
                <span>{t('alerts.memThreshold')}</span>
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
                <span>{t('alerts.loadThreshold')}</span>
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
              {t('alerts.hysteresisHint')}
            </span>

            {notifySupported ? (
              <label className="alerts-toggle">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => void toggleNotify(e.target.checked)}
                />
                {t('alerts.notifyLabel')}
                <span className="field-hint">{t('alerts.notifyHint')}</span>
              </label>
            ) : (
              <span className="field-hint">
                {t('alerts.notifyUnsupported')}
              </span>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save}>
            {t('common.save')}
          </button>
          <button className="btn btn-ghost" onClick={resetDefaults} title={t('alerts.resetTitle')}>
            {t('alerts.reset')}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
