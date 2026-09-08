import { aiStr } from './strings.js';
import type { PromptLang } from './prompts.js';

/**
 * Редакция секретов на пути «сервер → модель → диск».
 *
 * Вывод любого инструмента агента уходит сразу в три места: в контекст модели
 * (то есть по сети внешнему провайдеру), в UI и в `data/ai-dialogues.json`.
 * До этого модуля фильтра там не было — приватные ключи и пароли из
 * `docker inspect`, `.env` и конфигов попадали во все три разом.
 *
 * Точка вызова одна — `AgentSession.truncate()` (`ai/agent.ts`), поэтому
 * редакция идёт ДО обрезки: обрезанный PEM-блок уже не опознать по хвостовому
 * маркеру `-----END`.
 *
 * Принцип: лучше вырезать лишнее, чем пропустить. Имя переменной/поля
 * сохраняется всегда — модель видит, что секрет есть, и может попросить
 * пользователя показать значение через `exec` (с подтверждением).
 */

/** Кусок имени, по которому значение считается секретом (`DB_PASSWORD`, `apiKey`). */
const SECRETISH_NAME_SRC =
  '[A-Za-z0-9_.\\-]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_.\\-]*';

/** `NAME=значение`, `"NAME": "значение"`, `NAME: значение`. Разделитель — только `=`/`:`:
 * `PasswordAuthentication yes` в sshd_config (пробел) остаётся читаемым. */
const ASSIGNMENT = new RegExp(
  `(${SECRETISH_NAME_SRC})(["']?\\s*[:=]\\s*)(["']?)([^\\s"',;}]+)`,
  'gi',
);

/** Завершённый PEM-блок приватного ключа. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Оборванный PEM-блок (файл прочитан не до конца): всё после заголовка — ключ. */
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/;

/** Пароль в URL: `postgres://user:pass@host` — вырезаем только пароль. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:)([^\s:@/]+)(@)/gi;

/** Токены известного вида — ловятся и без говорящего имени рядом. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
  /\bAIza[0-9A-Za-z_\-]{30,}/g,
  /\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]{16,}/g,
];

function marker(lang: PromptLang, hidden: string): string {
  return aiStr(lang, 'secretRedacted', { n: hidden.length });
}

/**
 * Вырезает секреты из произвольного текста (вывод инструмента, содержимое
 * файла, JSON docker inspect). Возвращает текст той же формы — с маркером
 * вместо значений.
 */
export function redactSecrets(text: string, lang: PromptLang = 'ru'): string {
  if (!text) return text;
  let out = text.replace(PEM_BLOCK, (m) => marker(lang, m));
  out = out.replace(PEM_OPEN, (m) => marker(lang, m));
  out = out.replace(URL_CREDENTIALS, (_m, head: string, pass: string, tail: string) =>
    `${head}${marker(lang, pass)}${tail}`,
  );
  out = out.replace(ASSIGNMENT, (_m, name: string, sep: string, quote: string, value: string) =>
    `${name}${sep}${quote}${marker(lang, value)}`,
  );
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (m) => marker(lang, m));
  }
  return out;
}

/**
 * Переменные окружения, значения которых заведомо не секрет: их видно в любом
 * `docker inspect` и они реально нужны для диагностики. Всё остальное в `Env`
 * скрывается по имени — угадывать по значению ненадёжно
 * (`ADMIN=hunter2` неотличим от `ADMIN=root`).
 */
const SAFE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'HOSTNAME', 'PWD', 'SHLVL', 'TERM', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TZ', 'NODE_ENV', 'ENV', 'DEBIAN_FRONTEND', 'container',
  'GOPATH', 'PYTHONUNBUFFERED', 'NPM_CONFIG_LOGLEVEL',
]);

const SAFE_ENV_PATTERN = /^(LC_[A-Z]+|[A-Z0-9_]*VERSION|[A-Z0-9_]*_HOME|[A-Z0-9_]*_PORT)$/;

function isSafeEnvName(name: string): boolean {
  return SAFE_ENV_NAMES.has(name) || SAFE_ENV_PATTERN.test(name);
}

/**
 * Структурная редакция `Env` в выводе `docker inspect`: самый надёжный
 * источник чужих секретов на сервере (весь `.env` приложения одним куском).
 * Имена переменных остаются — по ним видно, что в контейнере вообще есть.
 * Рекурсивно, потому что `Env` встречается и в `Config`, и в `ContainerConfig`.
 */
export function redactDockerEnv<T>(value: T, lang: PromptLang = 'ru'): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactDockerEnv(item, lang)) as unknown as T;
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'Env' && Array.isArray(raw)) {
      result[key] = raw.map((entry) => {
        if (typeof entry !== 'string') return entry;
        const eq = entry.indexOf('=');
        if (eq <= 0) return entry;
        const name = entry.slice(0, eq);
        const val = entry.slice(eq + 1);
        if (!val || isSafeEnvName(name)) return entry;
        return `${name}=${marker(lang, val)}`;
      });
      continue;
    }
    result[key] = redactDockerEnv(raw, lang);
  }
  return result as T;
}

/**
 * Файлы, чтение которых осмысленно только ради секрета. Такой `read_file`
 * (и `cat` через `exec_readonly`) перестаёт быть автоматическим и уходит на
 * подтверждение пользователю: редакция ниже по потоку регулярная и полной
 * гарантии не даёт, а прочитанное уже ушло бы провайдеру.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)($|[^A-Za-z0-9])/i,
  /\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$/i,
  /(^|\/)\.ssh\/(?!known_hosts|authorized_keys|config($|[^A-Za-z0-9]))/i,
  /(^|\/)(shadow|gshadow)$/i,
  /(^|\/)\.(pgpass|netrc|my\.cnf|git-credentials|npmrc|pypirc)$/i,
  /(^|\/)\.(aws|gnupg|docker)\//i,
  /(^|\/)(credentials|secrets?)(\.[A-Za-z0-9]+)?$/i,
];

/** Похож ли путь на файл секретов. */
export function isSensitivePath(path: string): boolean {
  const p = path.trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  // `.pub` — публичная половина ключа: не секрет ни в каком каталоге,
  // включая `.ssh/`, где всё остальное закрыто.
  if (/\.pub$/i.test(p)) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

/**
 * Аргументы команды, похожие на пути к секретам (`cat /root/.ssh/id_rsa`).
 * Первый токен — сама команда — не проверяется.
 */
export function sensitivePathsIn(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter((t) => t && !t.startsWith('-') && isSensitivePath(t));
}
