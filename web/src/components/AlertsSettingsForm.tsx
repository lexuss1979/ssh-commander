import { useState } from 'react';
import { DEFAULT_ALERTS_SETTINGS, type AlertsSettings } from '../alerts';
import { useT } from '../i18n';

interface Props {
  settings: AlertsSettings;
  onSave: (s: AlertsSettings) => void;
  showError: (msg: string) => void;
}

const clampNum = (raw: string, min: number, max: number, fallback: number): number => {
  const v = Number(raw.replace(',', '.'));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v * 100) / 100));
};

/**
 * Форма порогов алертов — раздел «Алерты» модалки настроек (раньше жила
 * модалкой в колокольчике). Поля — локальный стейт, инициализируется из
 * пропа settings при монтировании; сохранение уходит через onSave
 * (App делает тихий re-baseline активных алертов).
 */
export function AlertsSettingsForm({ settings, onSave, showError }: Props) {
  const { t } = useT();
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
    // Форма остаётся открытой (это раздел, а не модалка) — подтверждаем тостом.
    showError(t('alerts.saved'));
  };

  const resetDefaults = () => {
    setDisk(String(DEFAULT_ALERTS_SETTINGS.disk));
    setMem(String(DEFAULT_ALERTS_SETTINGS.mem));
    setLoad(String(DEFAULT_ALERTS_SETTINGS.load));
  };

  return (
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

      <div className="settings-actions">
        <button className="btn btn-primary" onClick={save}>
          {t('common.save')}
        </button>
        <button className="btn btn-ghost" onClick={resetDefaults} title={t('alerts.resetTitle')}>
          {t('alerts.reset')}
        </button>
      </div>
    </div>
  );
}
