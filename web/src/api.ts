import type { FileSearchResult } from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Глобальный обработчик 401: App подписывается, чтобы при истёкшей сессии
// вернуть пользователя на страницу логина с любой страницы.
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  // 204 или успешный ответ с пустым телом — res.json() бросил бы SyntaxError.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function uploadFile(
  profileId: string,
  dir: string,
  name: string,
  file: Blob,
): Promise<void> {
  const params = new URLSearchParams({ profileId, dir, name });
  const res = await fetch(`/api/files/upload?${params}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
}

export function downloadUrl(profileId: string, path: string): string {
  const params = new URLSearchParams({ profileId, path });
  return `/api/files/download?${params}`;
}

export interface KeyEntry {
  name: string;
  path: string;
}

export interface ProfilesImportSummary {
  imported: number;
  renamed: Array<{ from: string; to: string }>;
  keysSaved: number;
  keysSkipped: string[];
  needSecrets: string[];
}

/** Экспорт профилей в файл бэкапа (секреты — только с includeSecrets). */
export async function exportProfilesBackup(opts: {
  passphrase?: string;
  includeSecrets: boolean;
}): Promise<Blob> {
  const res = await fetch('/api/profiles/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

/** Импорт бэкапа профилей; для зашифрованного файла нужен passphrase. */
export function importProfilesBackup(
  backup: string,
  passphrase?: string,
): Promise<ProfilesImportSummary> {
  return api<ProfilesImportSummary>('/api/profiles/import', {
    method: 'POST',
    body: JSON.stringify({ backup, passphrase }),
  });
}

/** Импорт приватного ключа в хранилище keys/ (сохраняется с правами 0600). */
export async function importKey(name: string, content: string, overwrite = false): Promise<KeyEntry> {
  const params = new URLSearchParams({ name });
  if (overwrite) params.set('overwrite', '1');
  const res = await fetch(`/api/keys?${params}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: content,
  });
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  const data = (await res.json()) as { key: KeyEntry };
  return data.key;
}

export interface ServerMetrics {
  timestamp: number;
  cpu: { percent: number | null; cores: number | null };
  memory: {
    totalBytes: number | null;
    availableBytes: number | null;
    usedBytes: number | null;
    usedPercent: number | null;
  };
  disks: Array<{
    filesystem: string;
    mount: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number | null;
  }>;
  uptimeSeconds: number | null;
  loadAverage: [number, number, number] | null;
  processes: Array<{
    user: string;
    pid: number;
    cpuPercent: number | null;
    memPercent: number | null;
    command: string;
  }>;
}

export function fetchMetrics(profileId: string): Promise<ServerMetrics> {
  return api<ServerMetrics>(`/api/metrics?profileId=${encodeURIComponent(profileId)}`);
}

export interface OverviewServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  ok: boolean;
  error?: string;
  metrics?: ServerMetrics;
  docker?: { containersTotal: number; containersRunning: number };
}

export interface OverviewResponse {
  timestamp: number;
  servers: OverviewServerEntry[];
}

/** Сводный снимок по всем профилям (вкладка «Серверы»). */
export function fetchOverview(): Promise<OverviewResponse> {
  return api<OverviewResponse>('/api/overview');
}

export async function fetchTerminalHistory(profileId: string, limit = 100): Promise<string[]> {
  const params = new URLSearchParams({ profileId, limit: String(limit) });
  const data = await api<{ commands: string[] }>(`/api/terminal/history?${params}`);
  return data.commands;
}

export function downloadDirUrl(profileId: string, path: string): string {
  const params = new URLSearchParams({ profileId, path });
  return `/api/files/download-dir?${params}`;
}

export async function uploadDirArchive(profileId: string, path: string, file: Blob): Promise<void> {
  const params = new URLSearchParams({ profileId, path });
  const res = await fetch(`/api/files/upload-dir?${params}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/gzip' },
    body: file,
  });
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
}

export async function searchFiles(
  profileId: string,
  path: string,
  pattern: string,
  mode: 'name' | 'content',
): Promise<FileSearchResult[]> {
  const params = new URLSearchParams({ profileId, path, pattern, mode });
  const data = await api<{ results: FileSearchResult[] }>(`/api/files/search?${params}`);
  return data.results;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function formatDate(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

