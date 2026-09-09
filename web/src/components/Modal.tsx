import { useRef, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Дополнительный класс на .modal — кастомный layout вроде модалки настроек. */
  className?: string;
  /**
   * Закрытие кликом по оверлею. Для модалок, где случайное закрытие дорого
   * (например, просмотрщик применения обновлений пакетов — клик мимо окна
   * оборвал бы `apt-get upgrade`), выставляется false.
   */
  dismissable?: boolean;
}

export function Modal({ title, onClose, children, wide, className, dismissable = true }: Props) {
  const { t } = useT();
  // Клик по оверлею закрывает модалку только если нажатие началось на нём же:
  // click при выделении текста в поле (mousedown внутри модалки, mouseup на
  // оверлее) всплывает на оверлее как общий предок и без этой проверки
  // молча закрывал бы модалку вместе с введёнными данными.
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
