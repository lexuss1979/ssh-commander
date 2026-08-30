import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchNginx, fetchNginxConfig, nginxSourceKey, reloadNginx, testNginx } from '../api';
import type { NginxCert, NginxListen, NginxSite, NginxSnapshot, NginxSourceSnapshot } from '../api';
import type { Profile } from '../types';
import { Modal } from '../components/Modal';
import { useT } from '../i18n';
import type { I18nKey, I18nParams } from '../i18n';

// Редактор с подсветкой (nginx-конфиг по полному пути) — ленивый чанк.
const CodeEditor = lazy(() => import('../components/CodeEditor'));

// Открыть конфиг — «квадрат со стрелкой наружу» (в стиле приложения).
const OPEN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14L21 3" />
  </svg>
);

/**
 * Вкладка «Nginx» (docs/nginx-plan.md): сайты сервера из `nginx -T`.
 * Паттерн CronPage: polling 5 с только при видимой вкладке, секции по
 * источникам (native + контейнеры), точечные мутации (test/reload) за
 * confirm'ом, 409 показывает вывод `nginx -t` mono-блоком.
 */

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;
/** ≤ этого срока сертификат подсвечивается жёлтым (просрочен — красным). */
const CERT_WARN_DAYS = 14;

type TFn = (key: I18nKey, params?: I18nParams | number) => string;

function sourceTitle(source: NginxSourceSnapshot, t: TFn): string {
  return source.type === 'native'
    ? t('nginx.sourceHost')
    : t('nginx.sourceContainer', { name: source.containerName ?? source.containerId ?? '' });
}

/** Бейдж `nginx -t`: «конфиг цел» / «конфиг с ошибками»; permission denied
 * (конфиг может быть цел, но не читается) — отдельный честный текст. */
function ConfigTestBadge({ source }: { source: NginxSourceSnapshot }) {
  const { t } = useT();
  if (source.configTest.ok) {
    return (
      <span className="scope-badge loopback" title={source.configTest.output}>
        {t('nginx.badgeConfigOk')}
      </span>
    );
  }
  const noPerm = /permission denied/i.test(source.configTest.output);
  return (
    <span className="scope-badge public" title={source.configTest.output}>
      {noPerm ? t('nginx.badgeNoPerm') : t('nginx.badgeConfigErrors')}
    </span>
  );
}

function formatListen(l: NginxListen): string {
  if (l.port === null) return l.addr;
  const addr = l.addr === '' ? '*' : l.addr;
  return `${addr}:${l.port}`;
}

function CertBadge({ cert }: { cert: NginxCert | null }) {
  const { t, locale } = useT();
  if (!cert) return <span className="muted">—</span>;
  if ('error' in cert) {
    return (
      <span className="cert-badge muted" title={cert.error}>
        {t('nginx.certUnavailable')}
      </span>
    );
  }
  const { daysLeft, notAfter } = cert;
  const date = new Date(notAfter).toLocaleDateString(locale);
  let text = t('nginx.certDaysLeft', { n: daysLeft });
  let cls = 'ok';
  if (daysLeft < 0) {
    text = t('nginx.certExpired', { n: -daysLeft });
    cls = 'crit';
  } else if (daysLeft <= CERT_WARN_DAYS) {
    cls = 'warn';
  }
  return (
    <span className={`cert-badge ${cls}`} title={t('nginx.certUntil', { date })}>
      {text}
    </span>
  );
}

function TargetCell({ site }: { site: NginxSite }) {
  const { kind, value } = site.target;
  let label: string;
  let valueNode: ReactNode;
  if (kind === 'proxy') {
    label = 'proxy →';
    valueNode = <code>{value}</code>;
  } else if (kind === 'static') {
    label = 'static';
    valueNode = <code>{value}</code>;
  } else {
    label = '—';
    valueNode = null;
  }
  return (
    <td className="nginx-target">
      <span className="muted">{label}</span> {valueNode}
    </td>
  );
}

function SitesTable({
  sites,
  sourceKey,
  onOpenFile,
}: {
  sites: NginxSite[];
  /** Ключ источника (nginxSourceKey): 'native' | 'container:<id>'. */
  sourceKey: string;
  onOpenFile: (path: string, sourceKey: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="ports-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('nginx.colSite')}</th>
            <th>{t('nginx.colListen')}</th>
            <th>{t('nginx.colTarget')}</th>
            <th>{t('nginx.colCert')}</th>
            <th className="col-narrow">{t('nginx.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site, i) => {
            const names = site.serverNames.join(', ');
            return (
              <tr key={`${site.file}-${i}`}>
                <td>
                  <div className="cell-main">
                    <div className="cell-top">
                      {site.isDefault && (
                        <span className="scope-badge loopback nginx-default-badge">default_server</span>
                      )}
                      {site.locationsCount >= 1 && (
                        <span className="muted nginx-loc-count">{site.locationsCount} location</span>
                      )}
                    </div>
                    <span className="name" title={names || undefined}>
                      {names || '—'}
                    </span>
                    <span className="image" title={site.file || undefined}>
                      {site.file || '—'}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="port-list">
                    {site.listens.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      site.listens.map((l, j) => (
                        <span key={j} className={`port-chip${l.ssl ? ' ssl' : ''}`}>
                          {formatListen(l)}
                          {l.ssl && <span className="chip-ssl">SSL</span>}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <TargetCell site={site} />
                <td>
                  <CertBadge cert={site.cert} />
                </td>
                <td className="col-narrow">
                  {site.file ? (
                    <button
                      className="btn btn-mini"
                      title={t('nginx.openConfigTitle')}
                      onClick={() => onOpenFile(site.file, sourceKey)}
                    >
                      {OPEN_ICON}
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {sites.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {t('nginx.noServerBlocks')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Mono-блок вывода nginx -t / ошибки источника (паттерн db-query-error). */
function OutputBlock({ text }: { text: string }) {
  return (
    <div className="nginx-error-block">
      <pre>{text || '—'}</pre>
    </div>
  );
}

export function NginxPage({ profile, visible, showError }: Props) {
  const { t, locale } = useT();
  const [snapshot, setSnapshot] = useState<NginxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Модалка вывода: результат «Проверить конфиг» или 409 reload'а.
  const [outputModal, setOutputModal] = useState<{ title: string; output: string } | null>(null);
  // Confirm reload'а: ключ источника + заголовок.
  const [confirmReload, setConfirmReload] = useState<{ key: string; title: string } | null>(null);
  // Идёт test/reload источника (кнопки блокируются).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Информационное сообщение (успех test/reload) — без красной рамки ошибки.
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | null>(null);
  // Модалка «Открыть конфиг»: содержимое файла из nginx -T, с подсветкой.
  const [fileModal, setFileModal] = useState<{ path: string } | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 8000);
  };

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await fetchNginx(profile.id);
        if (cancelled) return;
        setSnapshot(s);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profile.id, visible, reloadKey]);

  const handleTest = async (source: NginxSourceSnapshot) => {
    const key = nginxSourceKey(source);
    setBusyKey(key);
    try {
      const result = await testNginx(profile.id, key);
      if (result.ok) {
        showNotice(t('nginx.configOk', { title: sourceTitle(source, t) }));
      } else {
        setOutputModal({ title: t('nginx.testOutputTitle', { title: sourceTitle(source, t) }), output: result.output });
      }
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const handleReloadConfirm = async (key: string) => {
    setConfirmReload(null);
    setBusyKey(key);
    try {
      const result = await reloadNginx(profile.id, key);
      if (result.ok) {
        showNotice(t('nginx.reloaded'));
        // Свежий снапшот: бейдж конфиг-теста и сертификаты.
        setReloadKey((k) => k + 1);
      } else {
        setOutputModal({ title: 'nginx -s reload', output: result.output });
      }
    } catch (err) {
      const e = err as Error & { status?: number; output?: string };
      if (e.status === 409) {
        // Guard: конфиг красный — reload не выполнялся, показываем вывод теста.
        setOutputModal({ title: t('nginx.testFailedTitle'), output: e.output ?? e.message });
      } else {
        showError(e.message);
      }
    } finally {
      setBusyKey(null);
    }
  };

  // «Открыть конфиг»: прочитать содержимое файла (native cat / docker exec cat).
  const openConfigFile = async (path: string, sourceKey: string) => {
    setFileModal({ path });
    setFileLoading(true);
    setFileError(null);
    setFileContent('');
    try {
      const { content } = await fetchNginxConfig(profile.id, sourceKey, path);
      setFileContent(content);
    } catch (err) {
      const e = err as Error & { status?: number };
      setFileError(e.status === 502 ? t('common.serverUnavailablePlain') : e.message);
      setFileContent('');
    } finally {
      setFileLoading(false);
    }
  };

  const sources = snapshot?.sources ?? [];

  return (
    <div className="page cron-page">
      <div className="toolbar">
        <span className={`status-dot ${error ? 'error' : 'connected'}`} />
        <span className="status-text">
          {error
            ? t('common.noConnection', { error })
            : snapshot
              ? t('common.updated', { time: new Date(snapshot.timestamp).toLocaleTimeString(locale) })
              : t('common.loading')}
        </span>
        <div className="toolbar-actions">
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {error && !snapshot ? (
        <div className="empty-state">
          <p>{t('common.serverUnavailable', { error })}</p>
          <button className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : sources.length === 0 ? (
        <div className="empty-state">
          <p>{t('nginx.notFound')}</p>
          <p className="muted">
            {t('nginx.notFoundHint')}
          </p>
          <button className="btn btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            {t('nginx.recheck')}
          </button>
        </div>
      ) : (
        <div className="cron-scroll">
          {sources.map((source) => {
            const key = nginxSourceKey(source);
            const busy = busyKey === key;
            return (
              <div className="cron-section" key={key}>
                <div className="nginx-source-header">
                  <h3 className="section-title">
                    {sourceTitle(source, t)}
                    {source.version && <span className="muted nginx-version">nginx {source.version}</span>}
                  </h3>
                  <div className="nginx-source-actions">
                    <ConfigTestBadge source={source} />
                    <span className="action-sep" />
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={busy}
                      onClick={() => handleTest(source)}
                    >
                      {t('nginx.testConfig')}
                    </button>
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={busy}
                      onClick={() => setConfirmReload({ key, title: sourceTitle(source, t) })}
                    >
                      {t('nginx.reload')}
                    </button>
                  </div>
                </div>
                {source.error && (
                  <OutputBlock text={source.error} />
                )}
                <SitesTable sites={source.sites} sourceKey={key} onOpenFile={openConfigFile} />
              </div>
            );
          })}
        </div>
      )}

      {confirmReload && (
        <Modal
          title={t('nginx.reloadModalTitle')}
          onClose={() => setConfirmReload(null)}
        >
          <p>
            {t('nginx.reloadConfirmPre')} <code>nginx -s reload</code> {t('nginx.reloadConfirmPost', { title: confirmReload.title })}
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            {t('nginx.reloadHintPre')}<code>nginx -t</code>{t('nginx.reloadHintPost')}
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmReload(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => handleReloadConfirm(confirmReload.key)}>
              {t('nginx.reload')}
            </button>
          </div>
        </Modal>
      )}

      {outputModal && (
        <Modal title={outputModal.title} onClose={() => setOutputModal(null)} wide>
          <OutputBlock text={outputModal.output} />
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setOutputModal(null)}>
              {t('common.close')}
            </button>
          </div>
        </Modal>
      )}

      {fileModal && (
        <Modal title={t('nginx.configFileTitle', { path: fileModal.path })} onClose={() => setFileModal(null)} wide>
          {fileLoading ? (
            <p className="muted">{t('nginx.configLoading')}</p>
          ) : fileError ? (
            <OutputBlock text={fileError} />
          ) : (
            <Suspense fallback={<p className="muted">{t('nginx.editorLoading')}</p>}>
              <CodeEditor value={fileContent} fileName={fileModal.path} onChange={() => {}} readOnly />
            </Suspense>
          )}
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setFileModal(null)}>
              {t('common.close')}
            </button>
          </div>
        </Modal>
      )}

      {notice && <div className="toast toast-notice">{notice}</div>}
    </div>
  );
}
