import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadUrl, formatDate, formatSize, api, uploadFile } from '../api';
import type { FileEntry, FileListResponse, Profile } from '../types';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
}

function fileQuery(profileId: string, path: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ profileId, path, ...extra });
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

  const reconnect = async () => {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.id)}/reconnect`, { method: 'POST' });
      void load();
    } catch (err) {
      showError((err as Error).message);
    }
  };

  const navigate = (p: string) => setPath(p);

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
    const isDir = entry.isDirectory;
    const recursive = isDir && window.confirm(`Удалить директорию ${entry.path} рекурсивно? Это необратимо.`);
    if (!isDir && !window.confirm(`Удалить файл ${entry.path}?`)) return;
    if (isDir && !recursive) return;
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
        </div>
      </div>

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
              <textarea
                className="editor"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                spellCheck={false}
              />
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
