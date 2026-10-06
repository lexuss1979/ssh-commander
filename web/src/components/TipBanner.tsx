import { useState, type ReactNode } from 'react';
import { isTipSeen, markTipSeen, type TipId } from '../tips';
import { useT } from '../i18n';

interface Props {
  id: TipId;
  children: ReactNode;
}

/**
 * One-time contextual tip ("did you know"): a muted banner with the text and
 * a ✕ at the end. Renders null once the tip was seen (isTipSeen at mount);
 * ✕ persists the flag (markTipSeen) and hides the banner via local state.
 * Not a toast: it sits in the layout flow and never hides on its own.
 */
export function TipBanner({ id, children }: Props) {
  const { t } = useT();
  const [dismissed, setDismissed] = useState(() => isTipSeen(id));

  if (dismissed) return null;

  return (
    <div className="tip-banner">
      <span className="tip-banner-text">{children}</span>
      <button
        type="button"
        className="tip-banner-dismiss"
        aria-label={t('tips.dismiss')}
        title={t('tips.dismiss')}
        onClick={() => {
          markTipSeen(id);
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </div>
  );
}
