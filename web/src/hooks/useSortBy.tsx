import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDir;
}

/**
 * Клиентская сортировка массива по ключу столбца.
 */
export function useSortBy<T>(
  items: T[],
  accessors: Record<string, (item: T) => string | number>,
  initial?: SortState,
): {
  sort: SortState;
  toggle: (key: string) => void;
  sorted: T[];
} {
  const [sort, setSort] = useState<SortState>(
    initial ?? { key: Object.keys(accessors)[0], dir: 'asc' },
  );

  const toggle = (key: string) => {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { key, dir: 'asc' };
    });
  };

  const sorted = useMemo(() => {
    const accessor = accessors[sort.key];
    if (!accessor) return items;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      if (va === vb) return 0;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'ru') * dir;
    });
  }, [items, sort, accessors]);

  return { sort, toggle, sorted };
}

/** Сортируемый заголовок столбца. */
export function SortableTh({
  sortKey,
  currentSort,
  onToggle,
  children,
  className,
}: {
  sortKey: string;
  currentSort: SortState;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const active = currentSort.key === sortKey;
  const arrow = active ? (currentSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <th
      className={`sortable-th${active ? ' active' : ''} ${className ?? ''}`}
      onClick={() => onToggle(sortKey)}
    >
      {children}
      <span className="sort-arrow">{arrow}</span>
    </th>
  );
}
