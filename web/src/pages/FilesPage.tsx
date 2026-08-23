import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
  api,
  downloadBatch,
  downloadDirUrl,
  downloadUrl,
  formatDate,
  formatSize,
  searchFiles,
  uploadDirArchive,
  uploadFile,
} from '../api';
import type { AgentAskMode, FileEntry, FileListResponse, FileSearchResult, Profile } from '../types';
import { LogViewer } from '../components/LogViewer';
import { Modal } from '../components/Modal';
import { useSortBy, SortableTh } from '../hooks/useSortBy';

// Редактор с подсветкой грузится отдельным чанком, чтобы не раздувать основной бандл
const CodeEditor = lazy(() => import('../components/CodeEditor'));

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  visible: boolean;
  onAskAgent: (text: string, mode?: AgentAskMode, source?: string) => void;
  onProfilesChanged: () => void;
  /** Одноразовый переход на путь (из навигатора «Что занимает»); App сбрасывает через onFilesPathConsumed. */
  openPath?: string | null;
  onFilesPathConsumed?: () => void;
}

function fileQuery(profileId: string, path: string): string {
  const params = new URLSearchParams({ profileId, path });
  return `/api/files/list?${params}`;
}

export function FilesPage({ profile, showError, visible, onAskAgent, onProfilesChanged, openPath, onFilesPathConsumed }: Props) {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<FileEntry | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [promptState, setPromptState] = useState<{ title: string; value: string; action: 'mkdir' | 'rename' | 'chmod' | 'newfile'; target?: FileEntry } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const [uploadingArchive, setUploadingArchive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'name' | 'content'>('name');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<FileSearchResult[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  // Живой просмотр лога (эпик 14): tailTarget — путь открытого файла,
  // addLogInput — значение инпута модалки «+ путь» для чипов.
  const [tailTarget, setTailTarget] = useState<string | null>(null);
  const [addLogOpen, setAddLogOpen] = useState(false);
  const [addLogInput, setAddLogInput] = useState('');

  const fileAccessors = useMemo(() => ({
    // Папки всегда выше файлов; внутри группы — по алфавиту.
    name: (e: FileEntry) => `${e.isDirectory ? '0' : '1'}${e.name.toLowerCase()}`,
    size: (e: FileEntry) => e.size,
    mtime: (e: FileEntry) => e.mtime,
    mode: (e: FileEntry) => e.mode,
  }), []);
  const { sort: fileSort, toggle: toggleFileSort, sorted: sortedEntries } = useSortBy(entries, fileAccessors, { key: 'name', dir: 'asc' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<FileListResponse>(fileQuery(profile.id, path));
      setEntries(data.entries);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [profile.id, path, showError]);

  useEffect(() => {
    void load();
  }, [load]);

  // «Открыть в файлах» из навигатора «Что занимает» (эпик 16): одноразовый
  // переход на путь. Страница смонтирована keep-alive — эффект срабатывает
  // при переключении вкладки; App сбрасывает openPath через onFilesPathConsumed.
  useEffect(() => {
    if (!openPath) return;
    setSelected(new Set());
    setSearchResults(null);
    setPath(openPath);
    onFilesPathConsumed?.();
  }, [openPath, onFilesPathConsumed]);

  const reconnect = async () => {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}/reconnect`, { method: 'POST' });
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const uploadArchive = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploadingArchive(true);
    try {
      await uploadDirArchive(profile.id, path, file);
    } catch (err) {
      showError(`${file.name}: ${(err as Error).message}`);
    } finally {
      setUploadingArchive(false);
      if (archiveInputRef.current) archiveInputRef.current.value = '';
    }
    void load();
  };

  const runSearch = async () => {
    const pattern = searchQuery.trim();
    if (!pattern) return;
    setSearching(true);
    try {
      setSearchResults(await searchFiles(profile.id, path, pattern, searchMode));
    } catch (err) {
      setSearchResults(null);
      showError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const openSearchResult = async (result: FileSearchResult) => {
    const parent = result.path.replace(/\/[^/]*$/, '') || '/';
    const name = result.path.split('/').pop() ?? result.path;
    const openAsFile = () => {
      navigate(parent);
      void openEditor({ name, path: result.path, isDirectory: false, isSymlink: false, size: 0, mtime: 0, mode: '' });
    };
    if (searchMode === 'content') {
      // совпадение по содержимому — это всегда файл
      openAsFile();
      return;
    }
    // по имени тип неизвестен: пробуем открыть как директорию, иначе — как файл
    try {
      await api<FileListResponse>(fileQuery(profile.id, result.path));
      navigate(result.path);
    } catch {
      openAsFile();
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        await uploadFile(profile.id, path, file.name, file);
      } catch (err) {
        showError(`${file.name}: ${(err as Error).message}`);
      }
    }
    void load();
  };

  // Drag & drop: счётчик enter/leave корректно работает с вложенными элементами.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) await upload(files);
  };

  // Мультивыбор: toggle, select all, batch download/delete.
  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selected.size === sortedEntries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sortedEntries.map((e) => e.path)));
    }
  };
  // При смене директории сбрасываем выделение.
  const navigate = (p: string) => { setSelected(new Set()); setPath(p); };

  // Эпик 14: живой просмотр логов. buildUrl стабилизирован useCallback —
  // LogViewer перезапускает стрим при смене identity пропа.
  const buildTailUrl = useCallback(
    (follow: boolean) => {
      const params = new URLSearchParams({
        profileId: profile.id,
        path: tailTarget ?? '',
        lines: '500',
        follow: follow ? '1' : '0',
      });
      return `/api/files/tail?${params}`;
    },
    [profile.id, tailTarget],
  );

  // PUT log-paths — отдельный маршрут: полный апдейт профиля рвёт
  // SSH-подключение и оборвал бы открытый tail-стрим.
  const putLogPaths = useCallback(
    async (paths: string[]): Promise<boolean> => {
      try {
        await api(`/api/profiles/${encodeURIComponent(profile.id)}/log-paths`, {
          method: 'PUT',
          body: JSON.stringify({ paths }),
        });
        onProfilesChanged();
        return true;
      } catch (err) {
        showError((err as Error).message);
        return false;
      }
    },
    [profile.id, onProfilesChanged, showError],
  );

  const pinnedPaths = useMemo(() => profile.logPaths ?? [], [profile.logPaths]);
  const tailPinned = tailTarget !== null && pinnedPaths.includes(tailTarget);

  const submitAddLog = async () => {
    const value = addLogInput.trim();
    if (!value.startsWith('/')) {
      showError('Путь должен начинаться с /');
      return;
    }
    // при отказе сервера (не-абсолютный, ..) модалку держим открытой
    if (await putLogPaths([...pinnedPaths, value])) {
      setAddLogOpen(false);
      setAddLogInput('');
    }
  };

  const batchDownload = async () => {
    if (selected.size === 0) return;
    setBatchLoading(true);
    try {
      const names = sortedEntries.filter((e) => selected.has(e.path)).map((e) => e.name);
      await downloadBatch(profile.id, path, names);
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setBatchLoading(false);
    }
  };
  const batchDelete = async () => {
    if (selected.size === 0) return;
    const count = selected.size;
    if (!window.confirm(`Удалить ${count} объект(ов)? Это действие необратимо.`)) return;
    for (const entry of sortedEntries) {
      if (!selected.has(entry.path)) continue;
      try {
        await api('/api/files/delete', {
          method: 'POST',
          body: JSON.stringify({ profileId: profile.id, path: entry.path, recursive: true }),
        });
      } catch (err) {
        showError(`${entry.name}: ${(err as Error).message}`);
      }
    }
    setSelected(new Set());
    void load();
  };

  const remove = async (entry: FileEntry) => {
    let recursive = false;
    if (entry.isDirectory) {
      recursive = window.confirm(`Удалить директорию ${entry.path} и всё содержимое (рекурсивно)? Это необратимо.`);
      if (!recursive && !window.confirm(`Удалить директорию ${entry.path}, только если она пустая?`)) return;
    } else if (!window.confirm(`Удалить файл ${entry.path}?`)) {
      return;
    }
    try {
      await api('/api/files/delete', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, path: entry.path, recursive }),
      });
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const openEditor = async (entry: FileEntry) => {
    setEditTarget(entry);
    setEditLoading(true);
    setEditContent('');
    try {
      const params = new URLSearchParams({ profileId: profile.id, path: entry.path });
      const data = await api<{ content: string }>(`/api/files/read?${params}`);
      setEditContent(data.content);
    } catch (err) {
      showError((err as Error).message);
      setEditTarget(null);
    } finally {
      setEditLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    try {
      await api('/api/files/write', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, path: editTarget.path, content: editContent }),
      });
      setEditTarget(null);
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const submitPrompt = async () => {
    if (!promptState) return;
    try {
      if (promptState.action === 'mkdir') {
        const target = path === '/' ? `/${promptState.value}` : `${path}/${promptState.value}`;
        await api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ profileId: profile.id, path: target }) });
      } else if (promptState.action === 'newfile') {
        const target = path === '/' ? `/${promptState.value}` : `${path}/${promptState.value}`;
        await api('/api/files/write', { method: 'POST', body: JSON.stringify({ profileId: profile.id, path: target, content: '' }) });
      } else if (promptState.action === 'rename' && promptState.target) {
        const target = path === '/' ? `/${promptState.value}` : `${path}/${promptState.value}`;
        await api('/api/files/rename', {
          method: 'POST',
          body: JSON.stringify({ profileId: profile.id, from: promptState.target.path, to: target }),
        });
      } else if (promptState.action === 'chmod' && promptState.target) {
        await api('/api/files/chmod', {
          method: 'POST',
          body: JSON.stringify({ profileId: profile.id, path: promptState.target.path, mode: promptState.value }),
        });
      }
      setPromptState(null);
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const promptTitle = {
    mkdir: 'Новая директория',
    newfile: 'Новый файл',
    rename: 'Переименовать',
    chmod: 'Права доступа (chmod)',
  }[promptState?.action ?? 'mkdir'];

  return (
    <div className="page">
      <div className="toolbar">
        <div className="breadcrumbs">
          <button className="btn btn-ghost" onClick={() => navigate('/')}>/</button>
          {path !== '/' &&
            path
              .split('/')
              .filter(Boolean)
              .map((part, i, arr) => {
                const crumbsPath = `/${arr.slice(0, i + 1).join('/')}`;
                return (
                  <span key={crumbsPath} className="crumb">
                    <button className="btn btn-ghost" onClick={() => navigate(crumbsPath)}>
                      {part}
                    </button>
                  </span>
                );
              })}
        </div>
        <div className="toolbar-actions">
          <button className="btn" onClick={() => fileInputRef.current?.click()}>Загрузить</button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <button
            className="btn"
            disabled={uploadingArchive}
            onClick={() => archiveInputRef.current?.click()}
            title="Загрузить архив .tar.gz и распаковать в текущую директорию"
          >
            {uploadingArchive ? 'Распаковка…' : 'Загрузить архив'}
          </button>
          <input
            ref={archiveInputRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            hidden
            onChange={(e) => void uploadArchive(e.target.files)}
          />
          <button className="btn" onClick={() => setPromptState({ title: 'Новая директория', value: '', action: 'mkdir' })}>
            + Папка
          </button>
          <button className="btn" onClick={() => setPromptState({ title: 'Новый файл', value: '', action: 'newfile' })}>
            + Файл
          </button>
          <button className="btn btn-ghost" onClick={() => void load()}>Обновить</button>
          <button
            className="btn btn-ghost"
            title="Переустановить SSH-подключение (применить новые группы и права)"
            onClick={() => void reconnect()}
          >
            Переподключить
          </button>
          {selected.size > 0 && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>
                выбрано: {selected.size}
              </span>
              <button className="btn" disabled={batchLoading} onClick={() => void batchDownload()}>
                {batchLoading ? 'Упаковка…' : '⬇ Скачать'}
              </button>
              <button className="btn btn-danger" onClick={() => void batchDelete()}>
                ✕ Удалить
              </button>
            </>
          )}
        </div>
      </div>

      {/* Ряд чипов закреплённых логов — безусловно: «+» достижим и при
          пустом logPaths, иначе первый пин ставится только через 👁. */}
      <div className="log-chips">
        {pinnedPaths.map((p) => (
          <span key={p} className="log-chip">
            <button className="log-chip-open" title={`Смотреть ${p}`} onClick={() => setTailTarget(p)}>
              {p}
            </button>
            <button
              className="log-chip-remove"
              title="Открепить"
              onClick={() => void putLogPaths(pinnedPaths.filter((x) => x !== p))}
            >
              ✕
            </button>
          </span>
        ))}
        <button
          className="log-chip-add"
          title="Добавить путь лога"
          onClick={() => setAddLogOpen(true)}
        >
          + лог
        </button>
      </div>

      <div className="search-panel">
        <input
          className="search-input"
          placeholder={searchMode === 'name' ? 'Шаблон имени, напр. *.log (без * — точное имя)' : 'Текст внутри файлов'}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
        />
        <div className="search-mode">
          <button
            className={`btn${searchMode === 'name' ? ' active' : ''}`}
            onClick={() => setSearchMode('name')}
          >
            Имена
          </button>
          <button
            className={`btn${searchMode === 'content' ? ' active' : ''}`}
            onClick={() => setSearchMode('content')}
          >
            Содержимое
          </button>
        </div>
        <button className="btn" disabled={searching || !searchQuery.trim()} onClick={() => void runSearch()}>
          {searching ? 'Поиск…' : 'Найти'}
        </button>
        {searchResults !== null && !searching && (
          <button className="btn btn-ghost" onClick={() => setSearchResults(null)}>Скрыть</button>
        )}
      </div>

      {(searching || searchResults !== null) && (
        <div className="search-results">
          {searching ? (
            <p className="muted">Идёт поиск…</p>
          ) : searchResults !== null && searchResults.length === 0 ? (
            <p className="muted">Ничего не найдено</p>
          ) : (
            <ul>
              {(searchResults ?? []).map((r, i) => (
                <li key={`${r.path}:${r.line ?? i}`}>
                  <button className="link-cell" onClick={() => void openSearchResult(r)}>
                    <span className="search-result-path">{r.path}</span>
                    {r.line !== undefined && <span className="mono search-result-line">:{r.line}</span>}
                  </button>
                  {r.preview && <div className="search-preview mono">{r.preview}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        className={`table-wrap${dragOver ? ' drop-target' : ''}`}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={(e) => void onDrop(e)}
      >
        {dragOver && (
          <div className="drop-overlay">
            <span>Отпустите файлы для загрузки</span>
          </div>
        )}
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={sortedEntries.length > 0 && selected.size === sortedEntries.length}
                  onChange={toggleSelectAll}
                  title="Выбрать все"
                />
              </th>
              <SortableTh sortKey="name" currentSort={fileSort} onToggle={toggleFileSort}>Имя</SortableTh>
              <SortableTh sortKey="size" currentSort={fileSort} onToggle={toggleFileSort} className="col-narrow">Размер</SortableTh>
              <SortableTh sortKey="mtime" currentSort={fileSort} onToggle={toggleFileSort} className="col-narrow">Изменён</SortableTh>
              <SortableTh sortKey="mode" currentSort={fileSort} onToggle={toggleFileSort} className="col-narrow">Права</SortableTh>
              <th className="col-narrow">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="muted">Загрузка…</td>
              </tr>
            )}
            {!loading && sortedEntries.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">Директория пуста</td>
              </tr>
            )}
            {sortedEntries.map((entry) => (
              <tr key={entry.path} className={selected.has(entry.path) ? 'selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(entry.path)}
                    onChange={() => toggleSelect(entry.path)}
                  />
                </td>
                <td>
                  <button
                    className="link-cell"
                    onClick={() => entry.isDirectory && navigate(entry.path)}
                  >
                    <span className="file-icon">{entry.isDirectory ? '📁' : '📄'}</span>
                    {entry.name}
                    {entry.isSymlink && ' →'}
                  </button>
                </td>
                <td className="col-narrow">{entry.isDirectory ? '—' : formatSize(entry.size)}</td>
                <td className="col-narrow">{formatDate(entry.mtime)}</td>
                <td className="col-narrow mono">{entry.mode}</td>
                <td className="col-narrow">
                  <div className="row-actions">
                    {entry.isDirectory && (
                      <a
                        className="btn btn-mini"
                        href={downloadDirUrl(profile.id, entry.path)}
                        title="Скачать директорию архивом (.tar.gz)"
                      >
                        ⬇
                      </a>
                    )}
                    {!entry.isDirectory && (
                      <>
                        <a className="btn btn-mini" href={downloadUrl(profile.id, entry.path)}>⬇</a>
                        <button className="btn btn-mini" onClick={() => void openEditor(entry)}>✎</button>
                        {/* симлинки можно: серверный stat следует по ссылке */}
                        <button
                          className="btn btn-mini"
                          title="Смотреть хвост (tail -F)"
                          onClick={() => setTailTarget(entry.path)}
                        >
                          👁
                        </button>
                      </>
                    )}
                    <button
                      className="btn btn-mini"
                      onClick={() =>
                        setPromptState({ title: 'Переименовать', value: entry.name, action: 'rename', target: entry })
                      }
                    >
                      ↻
                    </button>
                    <button
                      className="btn btn-mini"
                      onClick={() =>
                        setPromptState({ title: 'Права доступа', value: '755', action: 'chmod', target: entry })
                      }
                    >
                      🔒
                    </button>
                    <button className="btn btn-mini btn-danger" onClick={() => void remove(entry)}>✕</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editTarget && (
        <Modal title={`Редактирование: ${editTarget.name}`} onClose={() => setEditTarget(null)} wide>
          {editLoading ? (
            <p className="muted">Загрузка файла…</p>
          ) : (
            <>
              <Suspense fallback={<p className="muted">Загрузка редактора…</p>}>
                <CodeEditor
                  value={editContent}
                  fileName={editTarget.name}
                  onChange={setEditContent}
                />
              </Suspense>
              <div className="modal-actions">
                <button className="btn btn-primary" onClick={() => void saveEdit()}>Сохранить</button>
                <button className="btn" onClick={() => setEditTarget(null)}>Отмена</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {promptState && (
        <Modal title={promptTitle} onClose={() => setPromptState(null)}>
          <label>
            {promptState.action === 'chmod' ? 'Режим (например 755):' : 'Имя:'}
            <input
              autoFocus
              value={promptState.value}
              onChange={(e) => setPromptState({ ...promptState, value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void submitPrompt()}
            />
          </label>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => void submitPrompt()}>ОК</button>
            <button className="btn" onClick={() => setPromptState(null)}>Отмена</button>
          </div>
        </Modal>
      )}

      {tailTarget !== null && (
        <Modal title={tailTarget} onClose={() => setTailTarget(null)} wide>
          <LogViewer
            title={tailTarget}
            buildUrl={buildTailUrl}
            visible={visible}
            logPath={tailTarget}
            serverName={profile.name}
            onAskAgent={(text) => {
              // Модалку закрываем: панель агента раскрывается под ней, и
              // ответ не виден, пока просмотрщик висит поверх.
              setTailTarget(null);
              onAskAgent(text, 'send');
            }}
            toolbarExtra={
              <button
                className="btn btn-mini"
                onClick={() =>
                  void putLogPaths(
                    tailPinned ? pinnedPaths.filter((p) => p !== tailTarget) : [...pinnedPaths, tailTarget],
                  )
                }
              >
                {tailPinned ? '☆ Открепить' : '★ Закрепить'}
              </button>
            }
          />
          <div className="modal-actions">
            <button className="btn" onClick={() => setTailTarget(null)}>Закрыть</button>
          </div>
        </Modal>
      )}

      {addLogOpen && (
        <Modal title="Добавить путь лога" onClose={() => setAddLogOpen(false)}>
          <label>
            Абсолютный путь:
            <input
              autoFocus
              value={addLogInput}
              onChange={(e) => setAddLogInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submitAddLog()}
              placeholder="/var/log/nginx/error.log"
            />
          </label>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => void submitAddLog()}>ОК</button>
            <button className="btn" onClick={() => setAddLogOpen(false)}>Отмена</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
