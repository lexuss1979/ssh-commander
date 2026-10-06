import { useRef, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Extra class on .modal — a custom layout like the settings modal. */
  className?: string;
  /**
   * Close on overlay click. For modals where an accidental close is costly
   * (e.g. the package update viewer — a click outside the window would abort
   * `apt-get upgrade`), set to false.
   */
  dismissable?: boolean;
}

export function Modal({ title, onClose, children, wide, className, dismissable = true }: Props) {
  const { t } = useT();
  // An overlay click closes the modal only if the press started on the overlay
  // itself: a click while selecting text in a field (mousedown inside the
  // modal, mouseup on the overlay) bubbles to the overlay as a common ancestor
  // and without this check would silently close the modal along with the
  // entered data.
  const pressedOnOverlay = useRef(false);
  return (
    <div
      className="modal-overlay"
      onMouseDown={
        dismissable
          ? (e) => {
              pressedOnOverlay.current = e.target === e.currentTarget;
            }
          : undefined
      }
      onClick={
        dismissable
          ? (e) => {
              if (pressedOnOverlay.current && e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        className={`modal${wide ? ' modal-wide' : ''}${className ? ` ${className}` : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
