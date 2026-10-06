import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchDiskUsage, fetchDiskUsageFiles, formatSize } from '../api';
import type { DiskUsageFilesResponse, DiskUsageSnapshot } from '../api';
import type { Profile } from '../types';
import { Modal } from './Modal';
import { useT } from '../i18n';

interface Props {
  profile: Profile;
  /** Mount point (or path) where navigation starts. */
  initialPath: string;
  onClose: () => void;
  /** Jump to the path in the "Files" tab (App switches the tab). */
  onOpenInFiles: (path: string) => void;
}

/**
 * The "What takes space" navigator (epic 16): drilling down into directories
 * with sizes and a top list of the largest files. A level request is
 * du -d 1; clicking a subdirectory descends into it, breadcrumbs go back.
 * The "Files" mode is a top files list with a jump into FilesPage.
 */
export function DiskUsageModal({ profile, initialPath, onClose, onOpenInFiles }: Props) {
  const { t } = useT();
  const [path, setPath] = useState(initialPath);
  const [mode, setMode] = useState<'dirs' | 'files'>('dirs');
  const [data, setData] = useState<DiskUsageSnapshot | null>(null);
  const [filesData, setFilesData] = useState<DiskUsageFilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The scan is long — show a status bar with a counter and a "Cancel" button.
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  // A fresh fetch on path/mode change; closing the modal (unmount) aborts the request.
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setCancelled(false);
    setElapsed(0);
    // Do not show stale data from the previous path/mode under the new breadcrumbs.
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

  // Seconds counter of the scan: ticks while the request is running.
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
    <Modal title={t('diskUsage.title', { name: profile.name })} onClose={onClose} wide>
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
              {t('diskUsage.modeDirs')}
            </button>
            <button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')}>
              {t('diskUsage.modeFiles')}
            </button>
          </div>
          <button
            className="btn btn-ghost btn-mini"
            onClick={() => onOpenInFiles(path)}
            title={t('diskUsage.openInFilesTitle')}
          >
            {t('diskUsage.openInFiles')}
          </button>
        </div>
      </div>

      {error && (
        <div className="empty-state">
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {!error && loading && <ScanStatusBar mode={mode} elapsed={elapsed} onCancel={cancelScan} />}

      {!error && !loading && cancelled && (
        <div className="du-hint">
          {t('diskUsage.cancelled')}{' '}
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {!error && !cancelled && mode === 'dirs' && data && (
        <>
          {data.incomplete && (
            <div className="du-chip">{t('diskUsage.incompleteDirs')}</div>
          )}
          {data.truncated && <div className="du-chip">{t('diskUsage.truncatedDu')}</div>}
          <div className="du-list">
            <div className="du-row du-row-total">
              <span className="du-row-name">{t('diskUsage.total')}</span>
              {/* truncated — the total is computed from the children, "100%" would be a lie */}
              <span className="du-pct">{data.truncated ? '—' : '100%'}</span>
              <span className="du-size">{formatSize(data.totalBytes)}</span>
            </div>
            {data.children.map((child) => (
              <div key={child.path} className="du-row">
                <button
                  className="link-cell du-row-name"
                  onClick={() => setPath(child.path)}
                  title={t('diskUsage.openPath', { path: child.path })}
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
                <span className="du-row-name">{t('diskUsage.directFiles')}</span>
                <span className="du-pct">—</span>
                <span className="du-size">{formatSize(data.directBytes)}</span>
              </div>
            )}
            {data.children.length === 0 && data.directBytes === 0 && (
              <div className="du-hint">{t('diskUsage.emptyDir')}</div>
            )}
          </div>
        </>
      )}

      {!error && !cancelled && mode === 'files' && filesData && (
        <>
          {filesData.incomplete && (
            <div className="du-chip">{t('diskUsage.incompleteFiles')}</div>
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
                  title={t('diskUsage.openParentTitle')}
                >
                  {t('diskUsage.toFiles')}
                </button>
              </div>
            ))}
            {filesData.files.length === 0 && <div className="du-hint">{t('diskUsage.noFiles')}</div>}
            {filesData.truncated && (
              <div className="du-hint">{t('diskUsage.showingFirst', { n: filesData.files.length })}</div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Status bar of a long du/find scan: a spinner + an indeterminate bar
 * + a seconds counter + a "Cancel" button. A percentage is impossible — the
 * server does not stream progress, the bar only shows that the request is
 * running. */
function ScanStatusBar({
  mode,
  elapsed,
  onCancel,
}: {
  mode: 'dirs' | 'files';
  elapsed: number;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="du-scan">
      <div className="scan-status">
        <span className="spinner" />
        <span>{t(mode === 'dirs' ? 'diskUsage.scanDirs' : 'diskUsage.scanFiles')}</span>
      </div>
      <div className="scan-bar" />
      <div className="scan-note">
        <code>{mode === 'dirs' ? 'du -x -d 1' : 'find -printf'}</code> {t('diskUsage.scanNote')}
      </div>
      <div className="scan-foot">
        <span className="scan-elapsed">{t('diskUsage.elapsedSec', { n: elapsed })}</span>
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
