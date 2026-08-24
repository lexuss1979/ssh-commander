import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchDiskUsage, fetchDiskUsageFiles, formatSize } from '../api';
import type { DiskUsageFilesResponse, DiskUsageSnapshot } from '../api';
import type { Profile } from '../types';
import { Modal } from './Modal';

interface Props {
  profile: Profile;
  /** Точка монтирования (или путь), с которой начинается навигация. */
  initialPath: string;
  onClose: () => void;
  /** Переход на путь во вкладке «Файлы» (App переключает вкладку). */
  onOpenInFiles: (path: string) => void;
}

/**
 * Навигатор «Что занимает» (эпик 16): проваливание по каталогам с размерами
 * и топ крупнейших файлов. Запрос на уровень — du -d 1; клик по подкаталогу
 * спускается вглубь, хлебные крошки возвращают назад. Режим «Файлы» — топ
 * файлов с переходом в FilesPage.
 */
export function DiskUsageModal({ profile, initialPath, onClose, onOpenInFiles }: Props) {
  const [path, setPath] = useState(initialPath);
  const [mode, setMode] = useState<'dirs' | 'files'>('dirs');
  const [data, setData] = useState<DiskUsageSnapshot | null>(null);
  const [filesData, setFilesData] = useState<DiskUsageFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Опрос длительный — показываем статус-бар со счётчиком и кнопкой «Отмена».
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  // Свежий fetch на смену пути/режима; закрытие модалки (unmount) рвёт запрос.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setCancelled(false);
    setElapsed(0);
    // Старые данные прошлого пути/режима не показываем под новыми крошками.
    setData(null);
    setFilesData(null);
    if (mode === 'dirs') {
      fetchDiskUsage(profile.id, path, controller.signal)
        .then((res) => {
          if (!controller.signal.aborted) setData(res);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError((err as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    } else {
      fetchDiskUsageFiles(profile.id, path, 100, controller.signal)
        .then((res) => {
          if (!controller.signal.aborted) setFilesData(res);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError((err as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    return () => controller.abort();
  }, [profile.id, path, mode, reloadKey]);

  // Счётчик секунд сканирования: тикает, пока идёт опрос.
  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  const cancelScan = () => {
    controllerRef.current?.abort();
    setCancelled(true);
    setLoading(false);
  };

  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    const items: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      items.push({ label: part, path: acc });
    }
    return items;
  }, [path]);

  const relPath = (p: string): string => (path === '/' ? p.slice(1) : p.slice(path.length));
  const lastCrumbPath = crumbs[crumbs.length - 1].path;

  return (
    <Modal title={`Что занимает · ${profile.name}`} onClose={onClose} wide>
      <div className="du-toolbar">
        <nav className="breadcrumbs">
          <button className="btn btn-ghost" onClick={() => setPath('/')} disabled={path === '/'}>
            /
          </button>
          {crumbs.slice(1).map((c) => (
            <span key={c.path} className="crumb">
              {c.path === lastCrumbPath ? (
                <span className="crumb-current">{c.label}</span>
              ) : (
                <button className="btn btn-ghost" onClick={() => setPath(c.path)}>
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <div className="du-toolbar-actions">
          <div className="du-mode">
            <button className={mode === 'dirs' ? 'active' : ''} onClick={() => setMode('dirs')}>
              Каталоги
            </button>
            <button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')}>
              Файлы
            </button>
          </div>
          <button
            className="btn btn-ghost btn-mini"
            onClick={() => onOpenInFiles(path)}
            title="Открыть этот путь во вкладке «Файлы»"
          >
            Открыть в файлах
          </button>
        </div>
      </div>

      {error && (
        <div className="empty-state">
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      )}

      {!error && loading && <ScanStatusBar mode={mode} elapsed={elapsed} onCancel={cancelScan} />}

      {!error && !loading && cancelled && (
        <div className="du-hint">
          Опрос отменён.{' '}
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Повторить
          </button>
        </div>
      )}

      {!error && !cancelled && mode === 'dirs' && data && (
        <>
          {data.incomplete && (
            <div className="du-chip">Часть каталогов недоступна (нет прав) — цифры неполные</div>
          )}
          {data.truncated && <div className="du-chip">Вывод du обрезан — сумма неполная</div>}
          <div className="du-list">
            <div className="du-row du-row-total">
              <span className="du-row-name">Всего</span>
              {/* truncated — сумма посчитана по детям, «100%» было бы враньём */}
              <span className="du-pct">{data.truncated ? '—' : '100%'}</span>
              <span className="du-size">{formatSize(data.totalBytes)}</span>
            </div>
            {data.children.map((child) => (
              <div key={child.path} className="du-row">
                <button
                  className="link-cell du-row-name"
                  onClick={() => setPath(child.path)}
                  title={`Открыть ${child.path}`}
                >
                  {child.name}
                </button>
                <div className="meter du-meter">
                  <div
                    className="meter-fill"
                    style={{ width: `${Math.min(100, Math.max(0, child.pctOfParent))}%` }}
                  />
                </div>
                <span className="du-pct">{child.pctOfParent}%</span>
                <span className="du-size">{formatSize(child.bytes)}</span>
              </div>
            ))}
            {data.directBytes > 0 && (
              <div className="du-row du-muted">
                <span className="du-row-name">файлы в этом каталоге</span>
                <span className="du-pct">—</span>
                <span className="du-size">{formatSize(data.directBytes)}</span>
              </div>
            )}
            {data.children.length === 0 && data.directBytes === 0 && (
              <div className="du-hint">Каталог пуст</div>
            )}
          </div>
        </>
      )}

      {!error && !cancelled && mode === 'files' && filesData && (
        <>
          {filesData.incomplete && (
            <div className="du-chip">Часть каталогов недоступна (нет прав) — список неполный</div>
          )}
          <div className="du-list">
            {filesData.files.map((f) => (
              <div key={f.path} className="du-row">
                <span className="du-row-name" title={f.path}>
                  {relPath(f.path)}
                </span>
                <span className="du-size">{formatSize(f.bytes)}</span>
                <button
                  className="btn btn-ghost btn-mini"
                  onClick={() => onOpenInFiles(f.path.replace(/\/[^/]*$/, '') || '/')}
                  title="Открыть родительский каталог во вкладке «Файлы»"
                >
                  В файлы
                </button>
              </div>
            ))}
            {filesData.files.length === 0 && <div className="du-hint">Файлов не найдено</div>}
            {filesData.truncated && (
              <div className="du-hint">Показаны первые {filesData.files.length}</div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Статус-бар длительного опроса du/find: спиннер + индетерминированная полоса
 * + счётчик секунд + кнопка «Отмена». Процент невозможен — сервер не стримит
 * прогресс, полоса лишь показывает, что запрос выполняется. */
function ScanStatusBar({
  mode,
  elapsed,
  onCancel,
}: {
  mode: 'dirs' | 'files';
  elapsed: number;
  onCancel: () => void;
}) {
  return (
    <div className="du-scan">
      <div className="scan-status">
        <span className="spinner" />
        <span>{mode === 'dirs' ? 'Сканирование каталогов…' : 'Поиск крупнейших файлов…'}</span>
      </div>
      <div className="scan-bar" />
      <div className="scan-note">
        <code>{mode === 'dirs' ? 'du -x -d 1' : 'find -printf'}</code> — опрос сервера может занять
        десятки секунд; прогресс не передаётся, полоса показывает, что запрос выполняется.
      </div>
      <div className="scan-foot">
        <span className="scan-elapsed">{elapsed} с</span>
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}
