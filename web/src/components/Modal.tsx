import type { ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /**
   * Закрытие кликом по оверлею. Для модалок, где случайное закрытие дорого
   * (например, просмотрщик применения обновлений пакетов — клик мимо окна
   * оборвал бы `apt-get upgrade`), выставляется false.
   */
  dismissable?: boolean;
}

export function Modal({ title, onClose, children, wide, dismissable = true }: Props) {
  return (
    <div className="modal-overlay" onClick={dismissable ? onClose : undefined}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
