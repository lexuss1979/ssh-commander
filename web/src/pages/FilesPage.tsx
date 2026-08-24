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

// SVG-иконки на currentColor — читаемы на обеих темах (вместо эмодзи, которые
// на светлой теме почти не видны).
const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
  </svg>
);
const FILE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
    <path d="M14 2v6h6" />
  </svg>
);
const DOWN_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v12M6 11l6 6 6-6" />
    <path d="M5 21h14" />
  </svg>
);
const EDIT_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const EYE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
// «Просмотр» — read-only с подсветкой по расширению (лупа-инспекция), отличимо
// от глаза (живой tail) и карандаша (редактирование).
const VIEW_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <line x1="20.5" y1="20.5" x2="16" y2="16" />
  </svg>
);
// Переименование — «карандаш на поле имени» (отличимо от карандаша
// редактирования содержимого) и наглядно читается в 13px.
const RENAME_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
  </svg>
);
const LOCK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="11" width="17" height="10" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const X_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export function FilesPage({ profile, showError, visible, onAskAgent, onProfilesChanged, openPath, onFilesPathConsumed }: Props) {
  const [path, setPath] = useState('/');
  // Редактируемая адресная строка: draft синхронизирован с path, Enter — переход.
  const [pathDraft, setPathDraft] = useState('/');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editTarget, setEditTarget] = useState<FileEntry | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  // «Просмотр» — read-only файл с подсветкой синтаксиса по расширению.
  const [viewTarget, setViewTarget] = useState<FileEntry | null>(null);
  const [viewContent, setViewContent] = useState('');
  const [viewLoading, setViewLoading] = useState(false);
  // Стабильный no-op для read-only CodeMirror (onChange обязательный).
  const noop = useCallback(() => {}, []);
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
    setPathDraft(openPath);
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
  const navigate = (p: string) => { setSelected(new Set()); setPath(p); setPathDraft(p); };

  // Вверх (родительский каталог).
  const goUp = () => {
    const parent = path === '/' ? '/' : path.replace(/\/[^/]*$/, '') || '/';
    navigate(parent);
  };

  // Копировать текущий путь; короткая подсветка кнопки.
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      /* clipboard может быть недоступен */
    }
    setCopied(true);
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  // Переход по введённому пути (Enter в адресной строке).
  const commitPathDraft = () => {
    const v = pathDraft.trim();
    if (!v.startsWith('/')) {
      showError('Путь должен начинаться с /');
      setPathDraft(path);
      return;
    }
    navigate(v);
  };

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

  // «Просмотр» (read-only): тот же /api/files/read, но в редакторе с readOnly
  // и подсветкой по расширению — без сохранения.
  const openView = async (entry: FileEntry) => {
    setViewTarget(entry);
    setViewLoading(true);
    setViewContent('');
    try {
      const params = new URLSearchParams({ profileId: profile.id, path: entry.path });
      const data = await api<{ content: string }>(`/api/files/read?${params}`);
      setViewContent(data.content);
    } catch (err) {
      showError((err as Error).message);
      setViewTarget(null);
    } finally {
      setViewLoading(false);
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
      <div className="toolbar files-toolbar">
        <div className="addr-row">
          <div className="addr-bar">
            <button className="addr-btn" title="Вверх (родительский каталог)" onClick={goUp}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
            <button className="addr-btn" title="Копировать путь" onClick={() => void copyPath()}>
              {copied ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            <input
              className="path-input"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitPathDraft()}
              onBlur={() => setPathDraft(path)}
              spellCheck={false}
            />
          </div>

          <div className="tools">
            <div className="tools-group">
              <button className="btn btn-small" onClick={() => setPromptState({ title: 'Новая директория', value: '', action: 'mkdir' })}>
                <span className="ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                Папка
              </button>
              <button className="btn btn-small" onClick={() => setPromptState({ title: 'Новый файл', value: '', action: 'newfile' })}>
                <span className="ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
                Файл
              </button>
            </div>
            <span className="tools-sep" />
            <div className="tools-group">
              <button className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
                <span className="ic">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 16V4M6 10l6-6 6 6" />
                    <path d="M4 20h16" />
                  </svg>
                </span>
                Загрузить
              </button>
              <button
                className="btn btn-small"
                disabled={uploadingArchive}
                onClick={() => archiveInputRef.current?.click()}
                title="Загрузить архив .tar.gz и распаковать в текущую директорию"
              >
                {uploadingArchive ? (
                  'Распаковка…'
                ) : (
                  <>
                    <span className="ic">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v12M6 11l6 6 6-6" />
                        <path d="M5 21h14" />
                      </svg>
                    </span>
                    Архив
                  </>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => void upload(e.target.files)}
              />
              <input
                ref={archiveInputRef}
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                hidden
                onChange={(e) => void uploadArchive(e.target.files)}
              />
            </div>
            <span className="tools-sep" />
            <div className="tools-group">
              <button className="btn btn-ghost btn-small" onClick={() => void load()}>↻ Обновить</button>
              <button
                className="btn btn-ghost btn-small"
                title="Переустановить SSH-подключение (применить новые группы и права)"
                onClick={() => void reconnect()}
              >
                ⇄ Переподключить
              </button>
            </div>
            {selected.size > 0 && (
              <>
                <span className="tools-sep" />
                <div className="tools-group">
                  <span className="muted" style={{ fontSize: 12 }}>выбрано: {selected.size}</span>
                  <button className="btn btn-small" disabled={batchLoading} onClick={() => void batchDownload()}>
                    {batchLoading ? (
                      'Упаковка…'
                    ) : (
                      <>
                        <span className="ic">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 4v12M6 12l6 6 6-6" />
                            <path d="M5 21h14" />
                          </svg>
                        </span>
                        Скачать
                      </>
                    )}
                  </button>
                  <button className="btn btn-small btn-danger" onClick={() => void batchDelete()}>
                    <span className="ic">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </span>
                    Удалить
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="crumb-rail">
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
      </div>

      {/* Ряд закреплённых логов — компактные чипы по имени файла (полный путь в
          подсказке); «+» достижим и при пустом logPaths. */}
      <div className="log-bookmarks">
        <span className="lbl">Закреплённые логи</span>
        {pinnedPaths.map((p) => (
          <span key={p} className="log-pin">
            <span className="ic">{FILE_ICON}</span>
            <button className="name" title={`Смотреть ${p}`} onClick={() => setTailTarget(p)}>
              {p.split('/').pop() || p}
            </button>
            <button
              className="rm"
              title="Открепить"
              onClick={() => void putLogPaths(pinnedPaths.filter((x) => x !== p))}
            >
              {X_ICON}
            </button>
          </span>
        ))}
        <button
          className="log-pin-add"
          title="Добавить путь лога"
          onClick={() => setAddLogOpen(true)}
        >
          <span className="ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          Добавить лог
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
                    <span className={`file-kind ${entry.isDirectory ? 'dir' : 'file'}`}>
                      {entry.isDirectory ? FOLDER_ICON : FILE_ICON}
                    </span>
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
                        {DOWN_ICON}
                      </a>
                    )}
                    {!entry.isDirectory && (
                      <>
                        <a className="btn btn-mini" href={downloadUrl(profile.id, entry.path)} title="Скачать">
                          {DOWN_ICON}
                        </a>
                        <button
                          className="btn btn-mini"
                          title="Просмотр (read-only, с подсветкой)"
                          onClick={() => void openView(entry)}
                        >
                          {VIEW_ICON}
                        </button>
                        <button className="btn btn-mini" title="Редактировать" onClick={() => void openEditor(entry)}>
                          {EDIT_ICON}
                        </button>
                        {/* симлинки можно: серверный stat следует по ссылке */}
                        <button
                          className="btn btn-mini"
                          title="Смотреть хвост (tail -F)"
                          onClick={() => setTailTarget(entry.path)}
                        >
                          {EYE_ICON}
                        </button>
                      </>
                    )}
                    <button
                      className="btn btn-mini"
                      title="Переименовать"
                      onClick={() =>
                        setPromptState({ title: 'Переименовать', value: entry.name, action: 'rename', target: entry })
                      }
                    >
                      {RENAME_ICON}
                    </button>
                    <button
                      className="btn btn-mini"
                      title="Права доступа (chmod)"
                      onClick={() =>
                        setPromptState({ title: 'Права доступа', value: '755', action: 'chmod', target: entry })
                      }
                    >
                      {LOCK_ICON}
                    </button>
                    <button className="btn btn-mini btn-danger" title="Удалить" onClick={() => void remove(entry)}>
                      {X_ICON}
                    </button>
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

      {viewTarget && (
        <Modal title={`Просмотр: ${viewTarget.name}`} onClose={() => setViewTarget(null)} wide>
          {viewLoading ? (
            <p className="muted">Загрузка файла…</p>
          ) : (
            <>
              <Suspense fallback={<p className="muted">Загрузка редактора…</p>}>
                <CodeEditor value={viewContent} fileName={viewTarget.name} onChange={noop} readOnly />
              </Suspense>
              <div className="modal-actions">
                <button className="btn" onClick={() => setViewTarget(null)}>Закрыть</button>
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
            kind="url"
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
