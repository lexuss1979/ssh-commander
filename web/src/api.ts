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
  /** Внешний (публичный) IP сервера; отсутствует, если определить не удалось. */
  externalIp?: string;
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

/** Сэмпл истории нагрузки: лёгкий срез снимка метрик. */
export interface HistorySample {
  /** Момент снимка (мс, серверное время ssh-commander). */
  t: number;
  cpu: number | null;
  memPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  load1: number | null;
}

export interface MetricsHistoryResponse {
  timestamp: number;
  samples: HistorySample[];
}

export interface BulkMetricsHistoryResponse {
  timestamp: number;
  profiles: Array<{ id: string; samples: HistorySample[] }>;
}

/** История нагрузки одного профиля — графики на вкладке «Обзор». */
export function fetchMetricsHistory(profileId: string): Promise<MetricsHistoryResponse> {
  return api<MetricsHistoryResponse>(`/api/metrics-history?profileId=${encodeURIComponent(profileId)}`);
}

/** История нагрузки всех профилей — спарклайны на экране «Серверы». */
export function fetchBulkMetricsHistory(): Promise<BulkMetricsHistoryResponse> {
  return api<BulkMetricsHistoryResponse>('/api/metrics-history');
}

export interface PortListener {
  proto: 'tcp' | 'udp';
  host: string;
  port: number;
  pid: number | null;
  process: string | null;
  /** public — слушает наружу, loopback — только 127.x/::1, interface — конкретный IP. */
  scope: 'public' | 'loopback' | 'interface';
  /** Аннотация: слушатель принадлежит docker-контейнеру (опубликованный порт). */
  container?: { id: string; name: string };
}

export interface ContainerPortBinding {
  containerPort: number;
  proto: 'tcp' | 'udp';
  hostIp: string | null;
  hostPort: number | null;
}

export interface ContainerPortEntry {
  containerId: string;
  name: string;
  networkMode: string;
  ip: string | null;
  ports: ContainerPortBinding[];
}

export interface PortsSnapshot {
  timestamp: number;
  ports: PortListener[];
  /** Порты контейнеров (null/undefined — docker недоступен, деградация). */
  containers?: ContainerPortEntry[];
}

/** Прослушиваемые порты сервера (вкладка «Порты»). */
export function fetchPorts(profileId: string): Promise<PortsSnapshot> {
  return api<PortsSnapshot>(`/api/ports?profileId=${encodeURIComponent(profileId)}`);
}

// SSH-туннели
export interface Tunnel {
  id: string;
  profileId: string;
  localHost: '127.0.0.1';
  localPort: number;
  targetHost: string;
  targetPort: number;
  status: 'active' | 'closed';
  error?: string;
  createdAt: number;
}

export interface TunnelsResponse {
  tunnels: Tunnel[];
  portRange: { min: number; max: number };
}

export function fetchTunnels(profileId: string): Promise<TunnelsResponse> {
  return api<TunnelsResponse>(`/api/tunnels?profileId=${encodeURIComponent(profileId)}`);
}

export function createTunnel(
  profileId: string,
  params: { localPort: number; targetHost: string; targetPort: number },
): Promise<Tunnel> {
  return api<Tunnel>(`/api/tunnels?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function deleteTunnel(id: string): Promise<void> {
  return api<void>(`/api/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Cron-задачи
export interface CronEntry {
  /** Номер строки в файле (0-based) — ключ для мутаций пользовательского crontab. */
  index: number;
  /** Исходная строка файла как есть. */
  raw: string;
  /** false — задача закомментирована. */
  enabled: boolean;
  schedule: string;
  command: string;
  /** Пользователь из колонки системного формата (/etc/crontab, /etc/cron.d). */
  user?: string;
  /** Человекочитаемое описание расписания. */
  human: string;
}

export interface ParsedCrontab {
  entries: CronEntry[];
  env: string[];
  comments: string[];
}

export interface CronSnapshot {
  timestamp: number;
  username: string;
  userCrontab: (ParsedCrontab & { raw: string }) | null;
  systemCrontab: ParsedCrontab | null;
  cronD: { file: string; entries: CronEntry[] }[];
}

/** Cron-задачи сервера (вкладка «Cron»). */
export function fetchCron(profileId: string): Promise<CronSnapshot> {
  return api<CronSnapshot>(`/api/cron?profileId=${encodeURIComponent(profileId)}`);
}

export function addCronEntry(
  profileId: string,
  entry: { schedule: string; command: string },
): Promise<CronSnapshot> {
  return api<CronSnapshot>(`/api/cron/entries?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

export function updateCronEntry(
  profileId: string,
  index: number,
  entry: { expectedRaw: string; schedule: string; command: string },
): Promise<CronSnapshot> {
  return api<CronSnapshot>(
    `/api/cron/entries/${index}?profileId=${encodeURIComponent(profileId)}`,
    { method: 'PUT', body: JSON.stringify(entry) },
  );
}

export function deleteCronEntry(
  profileId: string,
  index: number,
  expectedRaw: string,
): Promise<CronSnapshot> {
  return api<CronSnapshot>(
    `/api/cron/entries/${index}?profileId=${encodeURIComponent(profileId)}`,
    { method: 'DELETE', body: JSON.stringify({ expectedRaw }) },
  );
}

export function toggleCronEntry(
  profileId: string,
  index: number,
  expectedRaw: string,
): Promise<CronSnapshot> {
  return api<CronSnapshot>(
    `/api/cron/entries/${index}/toggle?profileId=${encodeURIComponent(profileId)}`,
    { method: 'POST', body: JSON.stringify({ expectedRaw }) },
  );
}

export async function fetchTerminalHistory(profileId: string, limit = 100): Promise<string[]> {
  const params = new URLSearchParams({ profileId, limit: String(limit) });
  const data = await api<{ commands: string[] }>(`/api/terminal/history?${params}`);
  return data.commands;
}

// Вкладка «Службы» (эпик 13)
export interface UnitInfo {
  /** Имя unit'а с суффиксом: 'nginx.service'. */
  name: string;
  description: string | null;
  /** loaded / not-found / error / null (не загружен). */
  load: string | null;
  /** active / inactive / activating / failed / null. */
  active: string | null;
  /** running / dead / exited / failed / null. */
  sub: string | null;
  /** enabled / disabled / masked / static / indirect / generated / alias / null. */
  enabled: string | null;
}

export interface ServicesSnapshot {
  timestamp: number;
  available: boolean;
  /** Причина недоступности systemd — для заглушки UI. */
  reason?: string;
  units: UnitInfo[];
}

export interface ServiceDetail {
  name: string;
  /** Raw-вывод `systemctl status` — для человека. */
  status: string;
  /** Значения полей `systemctl show`; отсутствующие — null. */
  show: Record<string, string | null>;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'reset-failed';

/** Снимок служб сервера (вкладка «Службы»). */
export function fetchServices(profileId: string): Promise<ServicesSnapshot> {
  return api<ServicesSnapshot>(`/api/services?profileId=${encodeURIComponent(profileId)}`);
}

/** Деталь unit'а: raw-статус + сводка полей show. */
export function fetchServiceDetail(profileId: string, unit: string): Promise<ServiceDetail> {
  return api<ServiceDetail>(
    `/api/services/${encodeURIComponent(unit)}?profileId=${encodeURIComponent(profileId)}`,
  );
}

/**
 * Действие над unit'ом. Ошибки 400 (текст systemd/пользовательские причины)
 * показываются как есть; 502 сервер уже отдаёт с текстом «Сервер недоступен:
 * <детали>» — пробрасываем целиком, чтобы диагностика (в т.ч. таймаут из
 * п. 2 ревью) не терялась.
 */
export async function serviceAction(
  profileId: string,
  unit: string,
  action: ServiceAction,
  sudoPassword?: string,
): Promise<{ ok: boolean; output: string }> {
  return api(`/api/services/${encodeURIComponent(unit)}/action?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify({ action, sudoPassword }),
  });
}

/** URL журнала unit'а для просмотрщика (fetch + reader, chunked text/plain). */
export function serviceLogsUrl(profileId: string, unit: string, tail: number, follow: boolean): string {
  const params = new URLSearchParams({ profileId, tail: String(tail) });
  if (follow) params.set('follow', '1');
  return `/api/services/${encodeURIComponent(unit)}/logs?${params}`;
}

// Вкладка «Базы данных» (эпик 12, итерация 2: явные креденшалы)
export type DbEngine = 'postgres' | 'mysql';
export type MysqlFlavor = 'mysql' | 'mariadb';

/** Цель подключения: контейнер (рабочий путь v1) или хост (модель под v2). */
export type DbConnectionTarget =
  | { kind: 'container'; containerId: string }
  | { kind: 'host'; host: string; port: number };

/** Сохранённое подключение (пароль наружу не отдаётся). */
export interface DbConnectionInfo {
  id: string;
  profileId: string;
  name: string;
  engine: DbEngine;
  target: DbConnectionTarget;
  username: string;
  hasPassword: boolean;
  defaultDatabase?: string;
  flavor?: MysqlFlavor;
  createdAt: string;
  updatedAt: string;
}

/** Поля подключения, создаваемые/обновляемые формой. */
export interface DbConnectionInput {
  profileId: string;
  name: string;
  engine: DbEngine;
  target: DbConnectionTarget;
  username: string;
  password?: string;
  defaultDatabase?: string;
  flavor?: MysqlFlavor;
}

export function fetchDbConnections(profileId: string): Promise<DbConnectionInfo[]> {
  return api<{ connections: DbConnectionInfo[] }>(
    `/api/db/connections?profileId=${encodeURIComponent(profileId)}`,
  ).then((r) => r.connections);
}

export function createDbConnection(input: DbConnectionInput): Promise<DbConnectionInfo> {
  return api('/api/db/connections', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** PUT: непереданный (пустой) пароль сохраняется из хранилища. */
export function updateDbConnection(id: string, input: DbConnectionInput): Promise<DbConnectionInfo> {
  return api(`/api/db/connections/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteDbConnection(id: string): Promise<void> {
  return api(`/api/db/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Проверка креденшалов без сохранения: SELECT 1 по реальному каналу.
 * Ошибка клиента БД приходит структурой {message, stderr, exitCode} —
 * выбрасываем её, а не строку.
 */
export async function testDbConnection(
  input: DbConnectionInput & { id?: string },
): Promise<void> {
  const res = await fetch('/api/db/connections/test', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let body: { error?: unknown } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const err = body?.error as { message?: string } | string | undefined;
    if (err && typeof err === 'object') {
      throw Object.assign(new Error(err.message ?? 'Ошибка запроса'), {
        info: err as DbQueryErrorInfo,
      });
    }
    throw new ApiError(res.status, typeof err === 'string' ? err : res.statusText);
  }
}

/** Контейнер СУБД из discovery — автозаполнение формы подключения. */
export interface DbSuggestion {
  id: string;
  name: string;
  engine: DbEngine;
  image: string;
  suggestedUser: string;
  suggestedDatabase: string | null;
  flavor?: MysqlFlavor;
}

export interface DbHint {
  id: string;
  name: string;
  port: number;
}

export function fetchDbDiscovery(
  profileId: string,
): Promise<{ suggestions: DbSuggestion[]; hints: DbHint[] }> {
  return api(`/api/db/discovery?profileId=${encodeURIComponent(profileId)}`);
}

export interface DbDatabaseInfo {
  name: string;
  sizeBytes: number | null;
  tableCount: number | null;
}

export interface DbOverview {
  engine: DbEngine;
  version: string;
  databases: DbDatabaseInfo[];
}

export function fetchDbOverview(profileId: string, connectionId: string): Promise<DbOverview> {
  const params = new URLSearchParams({ profileId, connectionId });
  return api(`/api/db/overview?${params}`);
}

export interface DbTableInfo {
  schema: string;
  name: string;
}

export function fetchDbTables(
  profileId: string,
  connectionId: string,
  database: string,
): Promise<DbTableInfo[]> {
  const params = new URLSearchParams({ profileId, connectionId, database });
  return api<{ tables: DbTableInfo[] }>(`/api/db/tables?${params}`).then((r) => r.tables);
}

export interface DbColumnInfo {
  schema: string;
  table: string;
  name: string;
}

/** Колонки таблиц базы — схема для промпта «Спросить агента».
 * `truncated` — сервер обрезал список по лимиту (4000). */
export function fetchDbColumns(
  profileId: string,
  connectionId: string,
  database: string,
): Promise<{ columns: DbColumnInfo[]; truncated: boolean }> {
  const params = new URLSearchParams({ profileId, connectionId, database });
  return api(`/api/db/columns?${params}`);
}

export interface DbQueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  totalRows: number;
  durationMs: number;
  truncated: boolean;
  rawOutput?: string;
}

/** Структурированная ошибка клиента БД: stderr и exit code — в mono-блок. */
export interface DbQueryErrorInfo {
  message: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Выполнение SQL. Ошибка приходит телом {error: {message, stderr, exitCode}}
 * — выбрасываем её структуру, а не строку (в отличие от api()).
 */
export async function runDbQuery(
  profileId: string,
  params: { connectionId: string; database: string; sql: string; readOnly: boolean },
): Promise<DbQueryResult> {
  const res = await fetch('/api/db/query', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId, ...params }),
  });
  const text = await res.text();
  let body: { error?: unknown } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const err = body?.error as { message?: string } | string | undefined;
    if (err && typeof err === 'object') {
      throw Object.assign(new Error(err.message ?? 'Ошибка запроса'), {
        info: err as DbQueryErrorInfo,
      });
    }
    throw new ApiError(res.status, typeof err === 'string' ? err : res.statusText);
  }
  return body as DbQueryResult;
}

/** Скачивание дампа базы: .sql.gz стримом → Blob → файл. Дамп собирается в
 * памяти браузера целиком — осознанное упрощение v1 (Blob не удерживает
 * JS-heap так, как string-конкатенация, но очень большие базы лимитируют). */
export async function downloadDbDump(
  profileId: string,
  connectionId: string,
  database: string,
): Promise<void> {
  const params = new URLSearchParams({ profileId, connectionId, database });
  const res = await fetch(`/api/db/dump?${params}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* keep statusText */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?(.+?)"?$/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : `${database}.sql.gz`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadDirUrl(profileId: string, path: string): string {
  const params = new URLSearchParams({ profileId, path });
  return `/api/files/download-dir?${params}`;
}

/** Batch-скачивание выбранных файлов/папок одним tar.gz (POST → blob → download). */
export async function downloadBatch(profileId: string, dirPath: string, names: string[]): Promise<void> {
  const params = new URLSearchParams({ profileId });
  const res = await fetch(`/api/files/download-batch?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path: dirPath, names }),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try { msg = JSON.parse(text).error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?(.+?)"?$/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : 'selected.tar.gz';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} ТБ`;
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

/**
 * Относительная дата для списков: «только что», «5 мин назад»,
 * «2 часа назад», иначе — полная дата «04.08.26 16:12».
 */
export function formatRelativeDate(ms: number): string {
  if (!ms) return '—';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${pluralHours(hours)} назад`;
  return formatDate(ms);
}

function pluralHours(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'час';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'часа';
  return 'часов';
}

