import type { AlertsResponse, FileSearchResult, Profile } from './types';
import { activeLocale, t } from './i18n/core';
import type { AiProvider } from './ai-providers';

export class ApiError extends Error {
  status: number;
  /** Body of an error response (e.g. {error, steps} for bootstrap). */
  body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// First-run setup (onboarding, docs/settings-model-plan.md): the password and
// an optional AI config are set in the UI on first launch, before the first login.

export interface SetupStatus {
  required: boolean;
}

/** Public onboarding status: "no password configured" — show the setup screen. */
export function fetchSetupStatus(): Promise<SetupStatus> {
  return api<SetupStatus>('/api/setup/status');
}

/**
 * One-shot POST: password + optional AI config. The AI fields (including
 * aiProvider/aiModel — required with a key) are only sent with a non-empty key,
 * otherwise AI fields seeded from env would be wiped by an empty form. A
 * successful response means auto-login.
 */
export function submitSetup(input: {
  password: string;
  aiApiKey?: string;
  aiProvider?: AiProvider;
  aiApiBase?: string;
  aiModel?: string;
}): Promise<{ ok: boolean }> {
  return api('/api/setup', { method: 'POST', body: JSON.stringify(input) });
}

// The "Settings" page (epic 23): password and AI config changes after the
// first launch. The server never returns the API key — only the fact that it is set.

/** Masked AI status (the GET/PUT /api/settings response). */
export interface AiSettingsStatus {
  /** null — no provider preset selected (no key set). */
  provider: AiProvider | null;
  /** The key is set; its value is never returned to the client. */
  apiKeySet: boolean;
  apiBase: string;
  model: string;
  /** Honest web-search status, including the env override for non-DeepSeek. */
  searchAvailable: boolean;
}

export interface SettingsStatus {
  ai: AiSettingsStatus;
}

export function fetchSettings(): Promise<SettingsStatus> {
  return api<SettingsStatus>('/api/settings');
}

/**
 * PUT /api/settings: password change — the currentPassword+newPassword pair;
 * model change — aiModel alone (the stored key is kept); the rest of the AI
 * config is replaced all at once; the key is write-only, aiApiKey: null
 * clears the key (agent unavailable). The response is the updated GET status.
 */
export function updateSettings(input: {
  currentPassword?: string;
  newPassword?: string;
  aiApiKey?: string | null;
  aiProvider?: AiProvider;
  aiApiBase?: string;
  aiModel?: string;
}): Promise<SettingsStatus> {
  return api<SettingsStatus>('/api/settings', { method: 'PUT', body: JSON.stringify(input) });
}

// Global 401 handler: App subscribes so that an expired session sends the
// user back to the login page from any page.
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
    let body: unknown;
    try {
      body = await res.json();
      message = (body as { error?: string }).error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message, body);
  }
  // 204 or a successful response with an empty body — res.json() would throw a SyntaxError.
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

/** Export profiles to a backup file (secrets only with includeSecrets). */
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

/** Import a profiles backup; a passphrase is required for an encrypted file. */
export function importProfilesBackup(
  backup: string,
  passphrase?: string,
): Promise<ProfilesImportSummary> {
  return api<ProfilesImportSummary>('/api/profiles/import', {
    method: 'POST',
    body: JSON.stringify({ backup, passphrase }),
  });
}

/** One step of the bootstrap report ("New server (root + password)"). */
export interface BootstrapStep {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** The POST /api/profiles/bootstrap response; on error — {error, steps} in ApiError.body. */
export interface BootstrapResult {
  profile: Profile;
  steps: BootstrapStep[];
}

/**
 * Bootstrap a fresh server: generates a dedicated key, installs it on the
 * server, optionally disables SSH password login and creates an authType=key
 * profile. The request takes tens of seconds — no live progress, the report
 * arrives at the end.
 */
export function bootstrapServer(input: {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  disablePasswordAuth: boolean;
}): Promise<BootstrapResult> {
  return api<BootstrapResult>('/api/profiles/bootstrap', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Import a private key into the keys/ store (saved with 0600 permissions). */
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
  /** External (public) server IP; absent when it could not be determined. */
  externalIp?: string;
  metrics?: ServerMetrics;
  docker?: { containersTotal: number; containersRunning: number };
}

export interface OverviewResponse {
  timestamp: number;
  servers: OverviewServerEntry[];
}

/** Aggregated snapshot across all profiles (the "Servers" tab). */
export function fetchOverview(): Promise<OverviewResponse> {
  return api<OverviewResponse>('/api/overview');
}

/** Alert rule states for all profiles (epic 20). On top of the overview cache. */
export function fetchAlerts(t: { disk: number; mem: number; load: number }): Promise<AlertsResponse> {
  const params = new URLSearchParams({
    disk: String(t.disk),
    mem: String(t.mem),
    load: String(t.load),
  });
  return api<AlertsResponse>(`/api/alerts?${params}`);
}

/** A load-history sample: a light slice of the metrics snapshot. */
export interface HistorySample {
  /** Snapshot moment (ms, ssh-commander server time). */
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

/** Load history of one profile — charts on the "Overview" tab. */
export function fetchMetricsHistory(profileId: string): Promise<MetricsHistoryResponse> {
  return api<MetricsHistoryResponse>(`/api/metrics-history?profileId=${encodeURIComponent(profileId)}`);
}

/** Load history of all profiles — sparklines on the "Servers" screen. */
export function fetchBulkMetricsHistory(): Promise<BulkMetricsHistoryResponse> {
  return api<BulkMetricsHistoryResponse>('/api/metrics-history');
}

export interface PortListener {
  proto: 'tcp' | 'udp';
  host: string;
  port: number;
  pid: number | null;
  process: string | null;
  /** public — listens on external interfaces, loopback — 127.x/::1 only, interface — a specific IP. */
  scope: 'public' | 'loopback' | 'interface';
  /** Annotation: the listener belongs to a docker container (published port). */
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
  /** Container ports (null/undefined — docker unavailable, degraded). */
  containers?: ContainerPortEntry[];
}

/** Server listening ports (the "Ports" tab). */
export function fetchPorts(profileId: string): Promise<PortsSnapshot> {
  return api<PortsSnapshot>(`/api/ports?profileId=${encodeURIComponent(profileId)}`);
}

// SSH tunnels
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

// Cron jobs
export interface CronEntry {
  /** Line number in the file (0-based) — the key for user crontab mutations. */
  index: number;
  /** The original file line as is. */
  raw: string;
  /** false — the job is commented out. */
  enabled: boolean;
  schedule: string;
  command: string;
  /** User from the column of the system format (/etc/crontab, /etc/cron.d). */
  user?: string;
  /** Human-readable schedule description. */
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
  /** The SSH user whose crontab can be mutated (the session owner). */
  currentUser: string;
  /** true when `username === currentUser` — the crontab is editable; otherwise read-only. */
  editable: boolean;
  userCrontab: (ParsedCrontab & { raw: string }) | null;
  systemCrontab: ParsedCrontab | null;
  cronD: { file: string; entries: CronEntry[] }[];
}

/** Server cron jobs (the "Cron" tab). `user` — a specific user's personal crontab (read-only). */
export function fetchCron(profileId: string, user?: string): Promise<CronSnapshot> {
  const params = new URLSearchParams({ profileId });
  if (user) params.set('user', user);
  return api<CronSnapshot>(`/api/cron?${params.toString()}`);
}

/** Users for the selector; empty when reading other users' crontabs is impossible (not root). */
export async function fetchCronUsers(profileId: string): Promise<string[]> {
  const res = await api<{ users: string[] }>(`/api/cron/users?profileId=${encodeURIComponent(profileId)}`);
  return res.users;
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

// The "Nginx" tab (docs/nginx-plan.md)
export interface NginxListen {
  /** Address without the port: '' (all interfaces), a specific IP, '[::]' for IPv6. */
  addr: string;
  /** Port; null — a unix socket. */
  port: number | null;
  /** listen ... ssl. */
  ssl: boolean;
  /** listen ... default_server. */
  defaultServer: boolean;
}

/** What the site "serves": proxy_pass, root, or unrecognized. */
export interface NginxTarget {
  kind: 'proxy' | 'static' | 'unknown';
  value: string;
}

/**
 * The site certificate: parsed locally (notAfter ISO, daysLeft — whole days,
 * can be negative) or the file is unreadable/unparseable (error).
 */
export type NginxCert =
  | { path: string; notAfter: string; daysLeft: number }
  | { path: string; error: string };

/** A site (server block) in the snapshot. */
export interface NginxSite {
  /** File from the `# configuration file <path>:` marker; '' — undetermined. */
  file: string;
  serverNames: string[];
  isDefault: boolean;
  listens: NginxListen[];
  target: NginxTarget;
  /** The number of top-level location blocks. */
  locationsCount: number;
  cert: NginxCert | null;
}

export interface NginxConfigTest {
  ok: boolean;
  output: string;
}

/** One source in the snapshot: the host binary or a container. */
export interface NginxSourceSnapshot {
  type: 'native' | 'container';
  containerId?: string;
  containerName?: string;
  version: string | null;
  configTest: NginxConfigTest;
  sites: NginxSite[];
  /** The source could not be read at all (nginx -T failed) — the reason. */
  error?: string;
}

export interface NginxSnapshot {
  timestamp: number;
  sources: NginxSourceSnapshot[];
}

/** Server sites (the "Nginx" tab), 5 s polling while the tab is visible. */
export function fetchNginx(profileId: string): Promise<NginxSnapshot> {
  return api<NginxSnapshot>(`/api/nginx?profileId=${encodeURIComponent(profileId)}`);
}

/** Source key for test/reload: 'native' | 'container:<id>'. */
export function nginxSourceKey(source: NginxSourceSnapshot): string {
  return source.type === 'native' ? 'native' : `container:${source.containerId}`;
}

/** Contents of one config file of the source (the "Open" button). */
export function fetchNginxConfig(profileId: string, source: string, path: string): Promise<{ content: string }> {
  const params = new URLSearchParams({ profileId, source, path });
  return api<{ content: string }>(`/api/nginx/config?${params.toString()}`);
}

/** `nginx -t` on a source: `{ok, output}` (output — stderr + stdout).
 * profileId — in the query, like the other mutations (the cron convention). */
export function testNginx(profileId: string, source: string): Promise<NginxConfigTest> {
  return api<NginxConfigTest>(`/api/nginx/test?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify({ source }),
  });
}

/**
 * Reload with a guard: 409 when `nginx -t` fails — the body is {error, output}.
 * output (the test output) is re-thrown inside ApiError so the UI can show it
 * in a mono block. profileId — in the query, like the other mutations (the
 * cron convention).
 */
export async function reloadNginx(profileId: string, source: string): Promise<NginxConfigTest> {
  const res = await fetch(`/api/nginx/reload?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const err = new ApiError(res.status, (body.error as string) ?? res.statusText) as ApiError & {
      output?: string;
    };
    if (typeof body.output === 'string') err.output = body.output;
    throw err;
  }
  return body as unknown as NginxConfigTest;
}

export async function fetchTerminalHistory(profileId: string, limit = 100): Promise<string[]> {
  const params = new URLSearchParams({ profileId, limit: String(limit) });
  const data = await api<{ commands: string[] }>(`/api/terminal/history?${params}`);
  return data.commands;
}

// Terminal tabs (epic 15)
export interface TerminalSessionEntry {
  tabId: number;
  container: string | null;
  containerName: string | null;
}

export interface TerminalSessionsResponse {
  sessions: TerminalSessionEntry[];
  limit: number;
}

/** Live terminal sessions of a profile — reconciling tabs after F5/localStorage cleanup. */
export function fetchTerminalSessions(profileId: string): Promise<TerminalSessionsResponse> {
  return api<TerminalSessionsResponse>(
    `/api/terminal/sessions?profileId=${encodeURIComponent(profileId)}`,
  );
}

// The "Services" tab (epic 13)
export interface UnitInfo {
  /** Unit name with the suffix: 'nginx.service'. */
  name: string;
  description: string | null;
  /** loaded / not-found / error / null (not loaded). */
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
  /** Why systemd is unavailable — for the UI placeholder. */
  reason?: string;
  units: UnitInfo[];
}

export interface ServiceDetail {
  name: string;
  /** Raw `systemctl status` output — for humans. */
  status: string;
  /** Values of `systemctl show` fields; missing ones — null. */
  show: Record<string, string | null>;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'reset-failed';

/** Server services snapshot (the "Services" tab). */
export function fetchServices(profileId: string): Promise<ServicesSnapshot> {
  return api<ServicesSnapshot>(`/api/services?profileId=${encodeURIComponent(profileId)}`);
}

/** Unit detail: the raw status + a summary of show fields. */
export function fetchServiceDetail(profileId: string, unit: string): Promise<ServiceDetail> {
  return api<ServiceDetail>(
    `/api/services/${encodeURIComponent(unit)}?profileId=${encodeURIComponent(profileId)}`,
  );
}

/**
 * An action on a unit. 400 errors (systemd text/user-facing reasons) are
 * shown as is; 502 already comes from the server with a "server unavailable:
 * <details>" text — re-thrown whole so the diagnostics (including the timeout
 * from review item 2) are not lost.
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

/** Unit journal URL for the viewer (fetch + reader, chunked text/plain). */
export function serviceLogsUrl(profileId: string, unit: string, tail: number, follow: boolean): string {
  const params = new URLSearchParams({ profileId, tail: String(tail) });
  if (follow) params.set('follow', '1');
  return `/api/services/${encodeURIComponent(unit)}/logs?${params}`;
}

// Process actions (epic 17)
export type ProcessSignal = 'TERM' | 'KILL' | 'HUP';

export interface ProcessActionResult {
  ok: true;
  output: string;
}

/**
 * Signal a process (TERM|KILL|HUP). 400 errors (no permission, the process is
 * gone, the utility is missing, wrong sudo password) are shown as is; 502 —
 * the server is unreachable. The serviceAction pattern.
 */
export async function processSignal(
  profileId: string,
  pid: number,
  signal: ProcessSignal,
  sudoPassword?: string,
): Promise<ProcessActionResult> {
  return api(`/api/processes/${pid}/signal?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify({ signal, sudoPassword }),
  });
}

/** Lower the process priority (nice −20..19); renice output goes into a notice. */
export async function processRenice(
  profileId: string,
  pid: number,
  nice: number,
  sudoPassword?: string,
): Promise<ProcessActionResult> {
  return api(`/api/processes/${pid}/renice?profileId=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    body: JSON.stringify({ nice, sudoPassword }),
  });
}

// Saved commands (epic 18, the "Commands" section on the "Servers" page)
export interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  /** null — available on all servers; a list of ids — only on the selected ones. */
  profileIds?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export type SnippetInput = Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>;

export interface SnippetRunResult {
  profileId: string;
  /** true — exit code 0 only. */
  ok: boolean;
  /** null — transport failure/timeout, the command did not complete. */
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** Output truncated by the response limit (100 KB per stream). */
  truncated: boolean;
  /** Transport failure text (absent when the command completed). */
  error?: string;
}

export interface SnippetRunResponse {
  /** What actually ran — an echo for the UI and "To chat". */
  command: string;
  results: SnippetRunResult[];
}

export function fetchSnippets(): Promise<Snippet[]> {
  return api<{ snippets: Snippet[] }>('/api/snippets').then((r) => r.snippets);
}

export function createSnippet(input: SnippetInput): Promise<Snippet> {
  return api('/api/snippets', { method: 'POST', body: JSON.stringify(input) });
}

export function updateSnippet(id: string, input: SnippetInput): Promise<Snippet> {
  return api(`/api/snippets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteSnippet(id: string): Promise<void> {
  return api(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Run a snippet or a one-off command on the selected servers in parallel.
 * An individual server failure is not a request error: a results entry with
 * ok:false. The UI sends command itself (the string from the confirmation),
 * not snippetId — the snippet may have been edited between showing the modal
 * and the run. signal — the "Cancel" button: on the server the command may
 * keep running.
 */
export function runSnippet(
  params: {
    snippetId?: string;
    command?: string;
    profileIds: string[];
  },
  signal?: AbortSignal,
): Promise<SnippetRunResponse> {
  return api('/api/snippets/run', { method: 'POST', body: JSON.stringify(params), signal });
}

// Package updates (epic 19)
export type PackageManager = 'apt' | 'dnf' | 'yum' | 'apk';

export interface PackageUpdate {
  name: string;
  current: string | null;
  available: string;
  source: string | null;
}

export interface PackagesSnapshot {
  timestamp: number;
  pm: PackageManager | null;
  updates: PackageUpdate[];
  rebootRequired: boolean;
  rebootPackages: string[];
  indexAgeMs: number | null;
  error?: string;
}

/** Updates snapshot (a 60 s cache on the server) — the card and the "Overview" section. */
export function fetchPackages(profileId: string): Promise<PackagesSnapshot> {
  return api<PackagesSnapshot>(`/api/packages/updates?profileId=${encodeURIComponent(profileId)}`);
}

/**
 * Apply-updates request: a POST stream (chunked text/plain) with the password
 * in the JSON body. What is returned is not fetch but the parameters for
 * LogViewer.buildRequest — the caller stabilizes them with useCallback (an
 * identity prop would restart the mutation).
 */
export function packagesApplyRequest(
  profileId: string,
  sudoPassword: string | undefined,
): { url: string; init?: RequestInit } {
  return {
    url: `/api/packages/apply?profileId=${encodeURIComponent(profileId)}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sudoPassword: sudoPassword || undefined }),
    },
  };
}

// The "Databases" tab (epic 12, iteration 2: explicit credentials)
export type DbEngine = 'postgres' | 'mysql';
export type MysqlFlavor = 'mysql' | 'mariadb';

/** Connection target: a container (the v1 working path) or a host (the model for v2). */
export type DbConnectionTarget =
  | { kind: 'container'; containerId: string }
  | { kind: 'host'; host: string; port: number };

/** A saved connection (the password is never returned). */
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

/** Connection fields created/updated by the form. */
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

/** PUT: a missing (empty) password is kept from the store. */
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
 * Credential check without saving: SELECT 1 over the real channel.
 * A DB client error arrives as the {message, stderr, exitCode} structure —
 * we throw that structure, not a string.
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
      throw Object.assign(new Error(err.message ?? t('common.errorRequest')), {
        info: err as DbQueryErrorInfo,
      });
    }
    throw new ApiError(res.status, typeof err === 'string' ? err : res.statusText);
  }
}

/** A DBMS container from discovery — prefilling the connection form. */
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

/** Detailed table fields (expanding in the sidebar). */
export interface DbColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: 'pk' | 'fk' | 'uq' | null;
}

export interface DbIndexDetail {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface DbTableDetail {
  schema: string;
  table: string;
  columns: DbColumnDetail[];
  indexes: DbIndexDetail[];
}

/** Table details: columns (types, keys) + indexes (name, columns, type). */
export function fetchDbTableDetail(
  profileId: string,
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<DbTableDetail> {
  const params = new URLSearchParams({ profileId, connectionId, database, schema, table });
  return api<DbTableDetail>(`/api/db/table-detail?${params}`);
}

/** Database table columns — the schema for the "Ask the agent" prompt.
 * `truncated` — the server cut the list by the limit (4000). */
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

/** Structured DB client error: stderr and the exit code go into a mono block. */
export interface DbQueryErrorInfo {
  message: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run SQL. An error arrives as the {error: {message, stderr, exitCode}} body —
 * we throw its structure, not a string (unlike api()).
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
      throw Object.assign(new Error(err.message ?? t('common.errorRequest')), {
        info: err as DbQueryErrorInfo,
      });
    }
    throw new ApiError(res.status, typeof err === 'string' ? err : res.statusText);
  }
  return body as DbQueryResult;
}

/** Downloading a database dump: .sql.gz streamed → Blob → file. The dump is
 * assembled in browser memory as a whole — a deliberate v1 simplification
 * (a Blob does not pin the JS heap the way string concatenation does, but
 * very large databases are capped anyway). */
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

/** Batch download of the selected files/folders as a single tar.gz (POST → blob → download). */
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

// "What takes space" — the du navigator (epic 16)
export interface DiskUsageChild {
  name: string;
  path: string;
  bytes: number;
  /** Share of the directory subtree total (one decimal place). */
  pctOfParent: number;
}

export interface DiskUsageSnapshot {
  timestamp: number;
  path: string;
  totalBytes: number;
  /** Size of the files directly in the directory (du with -d 1 does not print them). */
  directBytes: number;
  children: DiskUsageChild[];
  /** Permission failures during traversal — the numbers are incomplete. */
  incomplete?: { unreadable: number } | null;
  /** du output truncated by the limit — the total is incomplete. */
  truncated?: boolean;
}

export interface DiskUsageFile {
  path: string;
  bytes: number;
}

export interface DiskUsageFilesResponse {
  timestamp: number;
  path: string;
  files: DiskUsageFile[];
  incomplete?: { unreadable: number } | null;
  truncated: boolean;
}

/** du snapshot of one directory: the total, direct files, subdirectories with shares. */
export function fetchDiskUsage(
  profileId: string,
  path: string,
  signal?: AbortSignal,
): Promise<DiskUsageSnapshot> {
  const params = new URLSearchParams({ profileId, path });
  return api<DiskUsageSnapshot>(`/api/disk-usage?${params}`, { signal });
}

/** Top largest files of the directory (the "Files" mode of the modal). */
export function fetchDiskUsageFiles(
  profileId: string,
  path: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<DiskUsageFilesResponse> {
  const params = new URLSearchParams({ profileId, path, limit: String(limit) });
  return api<DiskUsageFilesResponse>(`/api/disk-usage/files?${params}`, { signal });
}

// The "AI costs" tab (docs/ai-costs-plan.md)
/** An aggregate by day/profile/totals: token and USD sums, an honest call
 * counter without a model price (costUsd is incomplete then). */
export interface AiUsageAgg {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  unpricedCalls: number;
}

export interface AiUsageDay {
  /** The server's local date, YYYY-MM-DD. */
  date: string;
  byProfile: Record<string, AiUsageAgg>;
  total: AiUsageAgg;
}

export interface AiUsageReport {
  profiles: Array<{ id: string; name: string }>;
  days: AiUsageDay[];
  totals: AiUsageAgg;
}

/** AI spend report for a period (days — a number of days or 'all'). */
export function fetchAiUsage(days: number | 'all'): Promise<AiUsageReport> {
  const params = new URLSearchParams({ days: String(days) });
  return api<AiUsageReport>(`/api/ai/usage?${params}`);
}

/** USD: below $1 — 4 digits (a typical call cost), otherwise 2. */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${t('common.sizeUnit', 0)}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t('common.sizeUnit', 1)}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${t('common.sizeUnit', 2)}`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ${t('common.sizeUnit', 3)}`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} ${t('common.sizeUnit', 4)}`;
}

export function formatDate(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(activeLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Relative date for lists: "just now", "5 min ago",
 * "2 hours ago", otherwise — the full date "04.08.26 16:12".
 */
export function formatRelativeDate(ms: number): string {
  if (!ms) return '—';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', hours);
  return formatDate(ms);
}

