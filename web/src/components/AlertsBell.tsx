import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Profile } from '../types';
import type { ActiveAlert, AlertsSettings } from '../alerts';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

interface Props {
  alerts: ActiveAlert[];
  settings: AlertsSettings;
  profiles: Profile[];
  onOpenProfile: (profileId: string) => void;
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
 * Колокольчик алертов в шапке сайдбара: счётчик активных и выпадающий
 * список. Настройки порогов переехали в модалку «Настройки» (раздел
 * «Алерты») — колокольчик остаётся только индикатором и списком.
 */
export function AlertsBell({ alerts, settings, profiles, onOpenProfile }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
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
    </div>
  );
}
