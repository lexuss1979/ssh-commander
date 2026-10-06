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
  /** Pinned log paths for quick access in FilesPage (epic 14). */
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

// ---------------------------------------------------------------------------
// Nginx tab (epic docs/nginx-plan.md) — API contracts
// ---------------------------------------------------------------------------

/** A single `listen` directive of a server block. */
export interface NginxListen {
  /** Address without port: '' (all interfaces), a specific IP, '[::]' for IPv6. */
  addr: string;
  /** Port; null means a unix socket (`listen unix:...`). */
  port: number | null;
  /** The `listen ... ssl` flag. */
  ssl: boolean;
  /** The `listen ... default_server` flag. */
  defaultServer: boolean;
}

/** What the site points at: proxy_pass, root, or unrecognized. */
export interface NginxTarget {
  kind: 'proxy' | 'static' | 'unknown';
  value: string;
}

/**
 * Site certificate. Parsed locally (`crypto.X509Certificate`, decision 5 of
 * the plan) — `notAfter` is ISO, `daysLeft` is whole days until expiry (may
 * be negative). `error` means the file could not be read or the PEM not
 * parsed.
 */
export type NginxCert =
  | { path: string; notAfter: string; daysLeft: number }
  | { path: string; error: string };

/** A site (server block) in the snapshot. */
export interface NginxSite {
  /** File from the `# configuration file <path>:` marker; '' — undetermined. */
  file: string;
  /** All server_name values (wildcards as-is); empty — no server_name. */
  serverNames: string[];
  /** Any of the listen directives carries the default_server flag. */
  isDefault: boolean;
  listens: NginxListen[];
  target: NginxTarget;
  /** Number of top-level location blocks. */
  locationsCount: number;
  /** null — no ssl_certificate in the config (neither at server nor http level). */
  cert: NginxCert | null;
}

/** Result of `nginx -t`: output is read from stderr (nginx writes there). */
export interface NginxConfigTest {
  ok: boolean;
  output: string;
}

/** Source of the nginx configuration: the host binary or a container. */
export type NginxSourceRef =
  | { type: 'native'; bin: string }
  | { type: 'container'; containerId: string; containerName: string };

/** One source in the `GET /api/nginx` snapshot. */
export interface NginxSourceSnapshot {
  type: 'native' | 'container';
  containerId?: string;
  containerName?: string;
  /** Version from `nginx -v` (writes to stderr); null — not determined. */
  version: string | null;
  configTest: NginxConfigTest;
  sites: NginxSite[];
  /** The source could not be read at all (`nginx -T` failed) — the reason; sites is empty. */
  error?: string;
}

export interface NginxSnapshot {
  timestamp: number;
  sources: NginxSourceSnapshot[];
}

