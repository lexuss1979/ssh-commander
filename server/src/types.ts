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

// ---------------------------------------------------------------------------
// Вкладка «Nginx» (эпик docs/nginx-plan.md) — контракты API
// ---------------------------------------------------------------------------

/** Один параметр `listen` server-блока. */
export interface NginxListen {
  /** Адрес без порта: '' (все интерфейсы), конкретный IP, '[::]' для IPv6. */
  addr: string;
  /** Порт; null — unix-сокет (`listen unix:...`). */
  port: number | null;
  /** Флаг `listen ... ssl`. */
  ssl: boolean;
  /** Флаг `listen ... default_server`. */
  defaultServer: boolean;
}

/** Куда «смотрит» сайт: proxy_pass, root или не распознано. */
export interface NginxTarget {
  kind: 'proxy' | 'static' | 'unknown';
  value: string;
}

/**
 * Сертификат сайта. Распарсен локально (`crypto.X509Certificate`, решение 5
 * плана) — `notAfter` ISO, `daysLeft` — целых дней до конца срока (может
 * быть отрицательным). `error` — файл не прочитан или PEM не разобран.
 */
export type NginxCert =
  | { path: string; notAfter: string; daysLeft: number }
  | { path: string; error: string };

/** Сайт (server-блок) в снапшоте. */
export interface NginxSite {
  /** Файл из маркера `# configuration file <путь>:`; '' — не определён. */
  file: string;
  /** Все имена server_name (wildcard как есть); пусто — server_name нет. */
  serverNames: string[];
  /** Любой из listen имеет флаг default_server. */
  isDefault: boolean;
  listens: NginxListen[];
  target: NginxTarget;
  /** Число верхнеуровневых location-блоков. */
  locationsCount: number;
  /** null — ssl_certificate в конфиге не задан (ни на server, ни на http-уровне). */
  cert: NginxCert | null;
}

/** Результат `nginx -t`: вывод читается из stderr (nginx пишет туда). */
export interface NginxConfigTest {
  ok: boolean;
  output: string;
}

/** Источник конфигурации nginx: бинарь хоста или контейнер. */
export type NginxSourceRef =
  | { type: 'native'; bin: string }
  | { type: 'container'; containerId: string; containerName: string };

/** Один источник в снапшоте `GET /api/nginx`. */
export interface NginxSourceSnapshot {
  type: 'native' | 'container';
  containerId?: string;
  containerName?: string;
  /** Версия из `nginx -v` (пишет в stderr); null — не определилась. */
  version: string | null;
  configTest: NginxConfigTest;
  sites: NginxSite[];
  /** Источник целиком не прочитался (`nginx -T` упал) — причина; sites пуст. */
  error?: string;
}

export interface NginxSnapshot {
  timestamp: number;
  sources: NginxSourceSnapshot[];
}

