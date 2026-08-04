import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import {
  api,
  downloadDirUrl,
  downloadUrl,
  formatDate,
  formatSize,
  searchFiles,
  uploadDirArchive,
  uploadFile,
} from '../api';
import type { FileEntry, FileListResponse, FileSearchResult, Profile } from '../types';
import { Modal } from '../components/Modal';

// Редактор с подсветкой грузится отдельным чанком, чтобы не раздувать основной бандл
const CodeEditor = lazy(() => import('../components/CodeEditor'));

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
}

function fileQuery(profileId: string, path: string): string {
  const params = new URLSearchParams({ profileId, path });
  return `/api/files/list?${params}`;
}

export function FilesPage({ profile, showError }: Props) {
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

  const navigate = (p: string) => setPath(p);

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
        </div>
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

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th className="col-narrow">Размер</th>
              <th className="col-narrow">Изменён</th>
              <th className="col-narrow">Права</th>
              <th className="col-narrow">Действия</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="muted">Загрузка…</td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">Директория пуста</td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.path}>
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
    </div>
  );
}

