import { X509Certificate } from 'node:crypto';
import type { NginxListen, NginxSite, NginxTarget } from '../types.js';

/**
 * Чистый парсер вывода `nginx -T` (решение 1 плана: источник данных — только
 * раскрытый дамп; маркеры `# configuration file <путь>:` приписывают каждый
 * server-блок своему файлу). Без I/O — под unit-тесты (паттерн cron.ts/ports.ts).
 *
 * Парсер консервативен (решение 8): непонятное поле — пропуск/пусто, а не
 * ошибка; `map`/`upstream`/`geo`/`if`/`stream` игнорируются молча.
 */

export interface ParsedLocation {
  /** Первый аргумент location (матч: '/', '~ ^/api/' и т.п.). */
  match: string;
  /** proxy_pass на верхнем уровне location; null — нет. */
  proxyPass: string | null;
}

export interface ParsedServerBlock {
  /** Файл из маркера дампа; null — маркера не было (не должно случаться). */
  file: string | null;
  serverNames: string[];
  listens: NginxListen[];
  /** Последний root на уровне server-блока; null — нет. */
  root: string | null;
  /** Последний ssl_certificate на уровне server-блока; null — нет. */
  sslCertificate: string | null;
  /** Только верхнеуровневые location (прямые дети server). */
  locations: ParsedLocation[];
}

export interface ParsedNginxConfig {
  /**
   * ssl_certificate с http-уровня (общий сертификат, решение 7) — дефолт
   * для server-блоков без своего. null — на http-уровне сертификата нет.
   */
  httpSslCertificate: string | null;
  /** Верхнеуровневые server-блоки внутри http. */
  sites: ParsedServerBlock[];
}

const FILE_MARKER_RE = /^# configuration file (.+?):?$/;

/** Маркер `# configuration file <путь>:` — имя следующего файла. */
export function frameFile(line: string): string | null {
  const m = line.match(FILE_MARKER_RE);
  return m ? m[1] : null;
}

/** Раскадровка дампа по маркерам файлов (паттерн батча `/etc/cron.d`). */
export function splitDumpFrames(text: string): Array<{ file: string; text: string }> {
  const frames: Array<{ file: string; text: string }> = [];
  let current: { file: string; lines: string[] } | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const file = frameFile(line);
    if (file !== null) {
      if (current) frames.push({ file: current.file, text: current.lines.join('\n') });
      current = { file, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) frames.push({ file: current.file, text: current.lines.join('\n') });
  return frames;
}

interface NginxStatement {
  directive: string;
  args: string[];
  /** Есть — блочная директива (server, location, http, upstream, ...). */
  block?: NginxStatement[];
}

/**
 * Токенизация текста фрейма: слова, одинарные/двойные кавычки (значения
 * с пробелами и `#` внутри кавычек), `;` `{` `}` отдельными токенами.
 * Комментарии `#` — только вне кавычек, до конца строки: значение вида
 * `"a#b"` или `'it''s #1'` не обрезается (маркеры файлов уже сняты
 * раскадровкой, внутри фреймов `#` — комментарий). Скобки считаем
 * лексически (решение 8): `}` внутри строки/кавычек не учитывается —
 * кавычки экранируют.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let inComment = false;
  const push = () => {
    if (cur) {
      tokens.push(cur);
      cur = '';
    }
  };
  for (const ch of text) {
    if (inComment) {
      if (ch === '\n') inComment = false;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '#') {
      push();
      inComment = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ';' || ch === '{' || ch === '}') {
      push();
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return tokens;
}

/** Токены → дерево утверждений (стек блоков, brace-matching лексически). */
function parseStatements(tokens: string[]): NginxStatement[] {
  const root: NginxStatement[] = [];
  const stack: NginxStatement[][] = [root];
  let cur: { directive: string; args: string[] } | null = null;

  const pushStatement = (withBlock: boolean): void => {
    if (!cur) return;
    const st: NginxStatement = { directive: cur.directive, args: cur.args };
    if (withBlock) st.block = [];
    stack[stack.length - 1].push(st);
    if (withBlock && st.block) stack.push(st.block);
    cur = null;
  };

  for (const tok of tokens) {
    if (tok === ';') {
      pushStatement(false);
    } else if (tok === '{') {
      pushStatement(true);
    } else if (tok === '}') {
      pushStatement(false);
      if (stack.length > 1) stack.pop();
    } else if (cur) {
      cur.args.push(tok);
    } else {
      cur = { directive: tok, args: [] };
    }
  }
  return root;
}

/** Последнее значение простой директивы среди прямых детей (для nginx «последнее» побеждает). */
function lastDirectiveValue(statements: NginxStatement[], directive: string): string | null {
  let value: string | null = null;
  for (const st of statements) {
    if (!st.block && st.directive === directive && st.args.length > 0) {
      value = st.args[st.args.length - 1];
    }
  }
  return value;
}

/**
 * Разбор одного `listen`-утверждения. Форматы: `80`, `80 default_server`,
 * `443 ssl`, `127.0.0.1:8080`, `[::]:443 ssl`, `*:80`, `unix:/run/nginx.sock`.
 * Неопознанный формат — addr как есть, port null (не теряем факт прослушивания).
 */
export function parseListen(args: string[]): NginxListen | null {
  const first = args[0];
  if (!first) return null;
  const flags = args.slice(1);
  const ssl = flags.includes('ssl');
  const defaultServer = flags.includes('default_server');
  if (first.startsWith('unix:')) {
    return { addr: first, port: null, ssl: false, defaultServer };
  }
  if (/^\d+$/.test(first)) {
    return { addr: '', port: Number(first), ssl, defaultServer };
  }
  const m = first.match(/^(.*):(\d+)$/);
  if (m) {
    const addr = m[1] === '*' ? '' : m[1];
    return { addr, port: Number(m[2]), ssl, defaultServer };
  }
  return { addr: first, port: null, ssl, defaultServer };
}

function parseServerBlock(st: NginxStatement, file: string | null): ParsedServerBlock {
  const body = st.block ?? [];
  const serverNames: string[] = [];
  const listens: NginxListen[] = [];
  let root: string | null = null;
  let sslCertificate: string | null = null;
  const locations: ParsedLocation[] = [];

  for (const s of body) {
    if (!s.block) {
      switch (s.directive) {
        case 'server_name':
          serverNames.push(...s.args);
          break;
        case 'listen': {
          const l = parseListen(s.args);
          if (l) listens.push(l);
          break;
        }
        case 'root':
          if (s.args.length > 0) root = s.args[s.args.length - 1];
          break;
        case 'ssl_certificate':
          if (s.args.length > 0) sslCertificate = s.args[s.args.length - 1];
          break;
      }
    } else if (s.directive === 'location' && s.block) {
      // Только верхний уровень вложенности: вложенные location — внутри s.block,
      // сюда не попадают (как и if/limit_except и пр. — не считаем).
      // match — полный модификатор+паттерн: '/', '= /', '~ ^/api/'.
      locations.push({
        match: s.args.join(' '),
        proxyPass: lastDirectiveValue(s.block, 'proxy_pass'),
      });
    }
  }
  return { file, serverNames, listens, root, sslCertificate, locations };
}

/**
 * Разбор вывода `nginx -T`. Каждый фрейм (файл) парсится отдельно: http-уровень
 * нужен только для дефолта ssl_certificate (может лежать в nginx.conf/conf.d,
 * а server-блоки — в sites-enabled), server-блоки собираются по всем фреймам.
 *
 * Фрейм с `http {}` — его прямые дети. Фрейм без http-обёртки — контент
 * http-контекста из include (conf.d/*, sites-enabled/*): верхнеуровневые
 * директивы считаются http-уровнем, верхнеуровневые `server {}` — сайтами.
 * Известное ограничение v1: `stream`-файлы из `stream-enabled` тоже выглядят
 * как контент http-контекста — их server-блоки попадут в сайты (редко, и
 * колонки будут пустыми, не ложными).
 */
export function parseNginxDump(text: string): ParsedNginxConfig {
  let httpSslCertificate: string | null = null;
  const sites: ParsedServerBlock[] = [];

  for (const frame of splitDumpFrames(text)) {
    const statements = parseStatements(tokenize(frame.text));
    const http = statements.find((s) => s.directive === 'http' && s.block);
    if (http?.block) {
      const ssl = lastDirectiveValue(http.block, 'ssl_certificate');
      if (ssl) httpSslCertificate = ssl;
      for (const st of http.block) {
        if (st.directive === 'server' && st.block) {
          sites.push(parseServerBlock(st, frame.file));
        }
      }
      continue;
    }
    // Фрейм без http-блока — контент http-контекста из include.
    const ssl = lastDirectiveValue(statements, 'ssl_certificate');
    if (ssl) httpSslCertificate = ssl;
    for (const st of statements) {
      if (st.directive === 'server' && st.block) {
        sites.push(parseServerBlock(st, frame.file));
      }
    }
  }
  return { httpSslCertificate, sites };
}

/** Дефолты http-уровня для toSiteEntry (сейчас — только общий сертификат). */
export interface HttpDefaults {
  sslCertificate: string | null;
}

/**
 * Маппинг server-блока в строку таблицы (решение 7): proxy_pass из
 * `location /`, иначе из первого location с proxy_pass; нет — static по root;
 * совсем ничего — unknown. cert заполняет сборщик снапшота (нужен I/O).
 * Возвращаемое значение — NginxSite плюс служебное `certPath` (путь PEM
 * для батч-чтения); сборщик вычленяет его и наружу не отдаёт.
 */
export function toSiteEntry(
  block: ParsedServerBlock,
  httpDefaults: HttpDefaults,
): NginxSite & { certPath: string | null } {
  let target: NginxTarget;
  const withProxy = block.locations.filter((l) => l.proxyPass !== null);
  const rootLoc = block.locations.find((l) => l.match === '/' && l.proxyPass !== null);
  const proxy = rootLoc ?? withProxy[0];
  if (proxy?.proxyPass) {
    target = { kind: 'proxy', value: proxy.proxyPass };
  } else if (block.root) {
    target = { kind: 'static', value: block.root };
  } else {
    target = { kind: 'unknown', value: '' };
  }
  return {
    file: block.file ?? '',
    serverNames: block.serverNames,
    isDefault: block.listens.some((l) => l.defaultServer),
    listens: block.listens,
    target,
    locationsCount: block.locations.length,
    // Путь сертификата для сборщика: свой или общий с http-уровня (решение 7).
    cert: null,
    certPath: block.sslCertificate ?? httpDefaults.sslCertificate,
  };
}

/** Информация о сроке действия из PEM. */
export interface CertInfo {
  notAfter: Date;
  /** Целых дней до конца срока (может быть отрицательным — просрочен). */
  daysLeft: number;
}

/**
 * Локальный парсинг PEM через `crypto.X509Certificate` (Node 20, `validTo`).
 * Без удалённого `openssl` (решение 5): в alpine/distroless-образах его может
 * не быть, а срок сертификата не должен зависеть от состава образа.
 * Битый PEM → null. `now` — инъекция времени под тесты.
 */
export function certInfoFromPem(pem: string, now = Date.now()): CertInfo | null {
  try {
    const cert = new X509Certificate(pem);
    const notAfter = new Date(cert.validTo);
    if (Number.isNaN(notAfter.getTime())) return null;
    const daysLeft = Math.floor((notAfter.getTime() - now) / 86_400_000);
    return { notAfter, daysLeft };
  } catch {
    return null;
  }
}

/**
 * Раскадровка батч-вывода чтения сертификатов по маркерам `=== <путь>`
 * (паттерн `/etc/cron.d`). Файл, который не удалось прочитать, секции
 * в stdout не даёт (билдер команды гвардит `[ -f ]`) — в Map его нет.
 */
export function parseCertBatch(output: string): Map<string, string> {
  const result = new Map<string, string>();
  let current: string | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current !== null) result.set(current, lines.join('\n').replace(/\n$/, ''));
    lines.length = 0;
  };
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^=== (.+)$/);
    if (m) {
      flush();
      current = m[1];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return result;
}
