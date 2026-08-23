export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'key' | 'password';
  keyPath?: string;
  keyPassphrase?: string;
  password?: string;
  dockerCommand?: string;
  note?: string;
  /** Закреплённые пути логов для быстрого доступа в FilesPage (эпик 14). */
  logPaths?: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
  mode: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

