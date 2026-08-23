import { exec, withSftp } from '../ssh/manager.js';
import { stat as sftpStat } from '../ssh/sftp.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Обновления пакетов (эпик 19).
 *
 * Read-only часть: детект менеджера (`command -v apt-get || dnf || yum ||
 * apk`), список обновлений и признаки рестарта одним exec с маркерами,
 * возраст индекса apt через SFTP-stat. Применение — отдельный маршрут
 * (`POST /api/packages/apply`) со sudo-зондом до стрима (см. `routes/
 * packages.ts`); инструмент агента для пакетов не заводится (обновления
 * уже покрыты секцией `updates` аудита).
 *
 * Код возврата списка берётся из маркера `@@LIST_CODE@@`, а не из
 * `result.code`: снимок — одна команда из двух частей, и код всей строки
 * принадлежит последней части (reboot-проверке). У dnf/yum `check-update`
 * возвращает 100 = есть обновления — это не ошибка.
 */

export type PackageManager = 'apt' | 'dnf' | 'yum' | 'apk';

export interface PackageUpdate {
  /** Имя пакета (для dnf — `name.arch` как в check-update). */
  name: string;
  /** Установленная версия; null, если менеджер её не показывает. */
  current: string | null;
  /** Доступная версия. */
  available: string;
  /** Suite/repo (apt) или репозиторий (dnf); у apk — null. */
  source: string | null;
}

export interface PackagesSnapshot {
  /** Момент снимка (мс, серверное время ssh-commander). */
  timestamp: number;
  /** Обнаруженный менеджер; null — не найден (не ошибка, заглушка в UI). */
  pm: PackageManager | null;
  updates: PackageUpdate[];
  rebootRequired: boolean;
  rebootPackages: string[];
  /** Возраст индекса apt (мс); null — нет конвенции или файла. */
  indexAgeMs: number | null;
  /** Причина отсутствия менеджера — для карточки UI. */
  error?: string;
}

export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; maxOutput?: number; stdin?: string },
) => Promise<ExecResult>;

export const PACKAGES_CACHE_TTL_MS = 60000;
/** Таймаут быстрых exec'ов (детект менеджера). */
export const PROBE_TIMEOUT_MS = 15000;
/**
 * Таймаут снимка списка обновлений: dnf check-update ходит в сеть, dpkg-lock
 * бывает занят — без явного предела exec висел бы до дефолтных 60 с, держа
 * SSH-канал. 30 с — компромисс «не мгновенно, но не вечно» (кэш 60 с гасит
 * повторы).
 */
export const SNAPSHOT_TIMEOUT_MS = 30000;

const LIST_CODE_MARKER = '@@LIST_CODE@@';
const REBOOT_MARKER = '@@REBOOT@@';
const RESTART_CODE_MARKER = '@@RESTART_CODE@@';
const APT_INDEX_STAMP = '/var/lib/apt/periodic/update-success-stamp';

// ---------------------------------------------------------------------------
// Чистые функции: детект, команды, парсеры
// ---------------------------------------------------------------------------

/** Детект менеджера одним exec: первая найденная команда. */
export function detectPmCommand(): string {
  return 'command -v apt-get || command -v dnf || command -v yum || command -v apk';
}

/** Первая непустая строка → basename пути → менеджер (незнакомый → null). */
export function parsePmDetection(text: string): PackageManager | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const base = (t.split(/[\\/]/).pop() ?? t).trim();
    if (base === 'apt-get') return 'apt';
    if (base === 'dnf' || base === 'yum' || base === 'apk') return base;
    return null;
  }
  return null;
}

export function listUpdatesCommand(pm: PackageManager): string {
  switch (pm) {
    case 'apt':
      return 'apt list --upgradable';
    case 'dnf':
      return 'dnf -q check-update';
    case 'yum':
      return 'yum -q check-update';
    case 'apk':
      // Статическая строка — shell сам съест кавычки, apk принимает литерал '<'.
      return "apk version -l '<'";
  }
}

/** Код 100 у dnf/yum = есть обновления, не ошибка (roadmap). null — код не получен. */
export function isUpdatesExitCode(pm: PackageManager, code: number | null): boolean {
  if (code === null) return false;
  if (pm === 'dnf' || pm === 'yum') return code === 0 || code === 100;
  return code === 0;
}

/** Код списка из маркера `@@LIST_CODE@@N`; маркера нет → null (отказ). */
export function parseListCode(text: string): number | null {
  const m = new RegExp(`${LIST_CODE_MARKER}(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

/** Текст списка — всё до маркера кода (после — код и reboot-секция). */
export function splitListSection(text: string): string {
  const idx = text.indexOf(LIST_CODE_MARKER);
  return idx >= 0 ? text.slice(0, idx) : text;
}

/**
 * `apt list --upgradable`: `name/suite version arch [upgradable from: cur]`.
 * Имя — до первого `/` (может содержать `+`/`-`/цифры), suite — без пробелов
 * (`stable-security`, `jammy-updates`), version — второй токен (доступная),
 * current — из скобки (нет скобки → null). Заголовок `Listing…` и мусор без
 * `/` пропускаются. WARNING apt про нестабильный CLI приходит в stderr —
 * парсер stdout его не видит.
 */
export function parseAptList(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([^\s/]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from:\s*(.*)\])?\s*$/.exec(t);
    if (!m) continue;
    out.push({
      name: m[1],
      current: m[5] ?? null,
      available: m[3],
      source: m[2],
    });
  }
  return out;
}

/**
 * `dnf -q check-update`: `name.arch version repo` (3 токена). name.arch не
 * расщепляем — колонка «Пакет» и так читается. Текущая версия из
 * check-update недоступна (отклонение от строки roadmap — колонка «— →
 * версия»). После списка обновлений идёт блок `Obsoleting Packages`: его
 * заголовок (2 токена) останавливает парсинг, иначе записи блока (та же
 * форма) завысили бы счётчик. Строки короче 3 токенов до начала списка —
 * мусор (заголовки), пропускаются.
 */
export function parseDnfCheckUpdate(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  let started = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) {
      // После первой записи короткая строка — конец списка обновлений
      // (пустая строка или заголовок «Obsoleting Packages»).
      if (started || /^obsoleting packages$/i.test(trimmed)) return out;
      continue;
    }
    out.push({ name: fields[0], current: null, available: fields[1], source: fields[2] });
    started = true;
  }
  return out;
}

/**
 * `apk version -l '<'`: `name-version < version` (справа может быть только
 * версия). Имя — до последнего дефиса с цифровым хвостом
 * (`alpine-baselayout-3.4.3-r1` → `alpine-baselayout` / `3.4.3-r1`).
 * Многострочный перенос (apk режет по ширине терминала): строка без `<`
 * после записи — продолжение её available; до первой записи — мусор (WARNING
 * про APKINDEX), пропускается.
 */
const APK_RE = /^(.+)-(\d[^\s<]*)\s*<\s*(.*)$/;

export function parseApkVersionLt(text: string): PackageUpdate[] {
  const out: PackageUpdate[] = [];
  let last: PackageUpdate | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = APK_RE.exec(line);
    if (m) {
      const entry: PackageUpdate = {
        name: m[1],
        current: m[2],
        available: m[3].trim(),
        source: null,
      };
      out.push(entry);
      last = entry;
    } else if (last !== null) {
      last.available += line;
    }
  }
  return out;
}

/**
 * Признак рестарта в конце команды снимка (каждый вариант начинается с
 * `'; '` — склейка с командой списка идёт встык). apt: маркер печатается
 * только при существующем `/var/run/reboot-required` (+ список `.pkgs`);
 * dnf/yum: `needs-restarting -r`, код 1 = нужен рестарт; apk: конвенции нет.
 */
export function rebootCheckSuffix(pm: PackageManager): string {
  switch (pm) {
    case 'apt':
      return (
        `; if [ -f /var/run/reboot-required ]; then echo '${REBOOT_MARKER}'; ` +
        `cat /var/run/reboot-required.pkgs 2>/dev/null; fi`
      );
    case 'dnf':
    case 'yum':
      return (
        `; if command -v needs-restarting >/dev/null 2>&1; then echo '${REBOOT_MARKER}'; ` +
        `needs-restarting -r; echo "${RESTART_CODE_MARKER}$?"; fi`
      );
    case 'apk':
      return '';
  }
}

/** Полная команда снимка: список + маркер кода + reboot-проверка. */
export function snapshotCommand(pm: PackageManager): string {
  return `${listUpdatesCommand(pm)}; echo "${LIST_CODE_MARKER}$?"${rebootCheckSuffix(pm)}`;
}

/** Разбор reboot-секции (текст после `@@REBOOT@@`): код needs-restarting и пакеты `.pkgs`. */
export function parseRebootSection(text: string): { code: number | null; packages: string[] } {
  const idx = text.indexOf(REBOOT_MARKER);
  if (idx < 0) return { code: null, packages: [] };
  const section = text.slice(idx + REBOOT_MARKER.length);
  const codeMatch = new RegExp(`${RESTART_CODE_MARKER}(\\d+)`).exec(section);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  const packages = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes(RESTART_CODE_MARKER));
  return { code, packages };
}

function parseUpdates(pm: PackageManager, text: string): PackageUpdate[] {
  switch (pm) {
    case 'apt':
      return parseAptList(text);
    case 'dnf':
    case 'yum':
      return parseDnfCheckUpdate(text);
    case 'apk':
      return parseApkVersionLt(text);
  }
}

/** Дедуп по имени, первое вхождение выигрывает. */
export function dedupeByName(updates: PackageUpdate[]): PackageUpdate[] {
  const seen = new Set<string>();
  const out: PackageUpdate[] = [];
  for (const u of updates) {
    if (seen.has(u.name)) continue;
    seen.add(u.name);
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Применение (мутация)
// ---------------------------------------------------------------------------

/**
 * Команда применения обновлений. С sudo — прямая форма `sudo -S -p '' --`
 * без `sh -c` (инвариант эпика 13); пароль уходит первой строкой stdin
 * канала. `env DEBIAN_FRONTEND=noninteractive` — dpkg-промпты примут дефолт,
 * а не зависнут на EOF-stdin. Статические строки — пользовательский ввод
 * не интерполируется нигде.
 */
export function buildApplyCommand(pm: PackageManager, withSudo: boolean): string {
  const sudo = withSudo ? `sudo -S -p '' -- ` : '';
  switch (pm) {
    case 'apt':
      return `${sudo}env DEBIAN_FRONTEND=noninteractive apt-get -y upgrade`;
    case 'dnf':
      return `${sudo}dnf -y upgrade`;
    case 'yum':
      return `${sudo}yum -y upgrade`;
    case 'apk':
      return `${sudo}apk upgrade`;
  }
}

// ---------------------------------------------------------------------------
// Исполнители (снимок + детект, кэш 60 с)
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; promise: Promise<PackagesSnapshot> }>();

/** Сброс кэша после применения — refetch вернёт свежий список. */
export function invalidatePackagesCache(profileId: string): void {
  cache.delete(profileId);
}

/** Свежий детект менеджера (для применения — не из кэша снимка). */
export async function detectPackageManager(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<PackageManager | null> {
  const execFn = deps.execFn ?? exec;
  const r = await execFn(profile, detectPmCommand(), { timeoutMs: PROBE_TIMEOUT_MS });
  return parsePmDetection(r.stdout);
}

/** Возраст индекса apt через SFTP-stat; файла нет или stat упал — тихий null. */
async function aptIndexAge(profile: Profile): Promise<number | null> {
  try {
    const st = await withSftp(profile, (sftp) => sftpStat(sftp, APT_INDEX_STAMP));
    const mtime = st.mtime;
    if (mtime == null) return null;
    return Math.max(0, Date.now() - mtime * 1000);
  } catch {
    return null;
  }
}

/**
 * Снимок обновлений. Кэш 60 с на профиль (паттерн `collectMetrics`):
 * список меняется редко, команда не мгновенная; параллельные вызовы делят
 * один exec, ошибочный промис из кэша удаляется. `pm: null` — не ошибка:
 * это штатный результат детекта «менеджера нет» (заглушка в UI).
 */
export function collectPackagesSnapshot(
  profile: Profile,
  deps: { execFn?: ExecFn } = {},
): Promise<PackagesSnapshot> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < PACKAGES_CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const promise = buildSnapshot(profile, execFn);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

async function buildSnapshot(profile: Profile, execFn: ExecFn): Promise<PackagesSnapshot> {
  const detection = await execFn(profile, detectPmCommand(), { timeoutMs: PROBE_TIMEOUT_MS });
  const pm = parsePmDetection(detection.stdout);
  if (pm === null) {
    return {
      timestamp: Date.now(),
      pm: null,
      updates: [],
      rebootRequired: false,
      rebootPackages: [],
      indexAgeMs: null,
      error: 'Менеджер пакетов не найден (apt/dnf/yum/apk)',
    };
  }
  const result = await execFn(profile, snapshotCommand(pm), { timeoutMs: SNAPSHOT_TIMEOUT_MS });
  const listCode = parseListCode(result.stdout);
  if (!isUpdatesExitCode(pm, listCode)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${pm}: ${detail || `код ${listCode ?? 'unknown'}`}`);
  }
  const updates = dedupeByName(parseUpdates(pm, splitListSection(result.stdout)));
  const reboot = parseRebootSection(result.stdout);
  const rebootRequired =
    pm === 'apt' ? result.stdout.includes(REBOOT_MARKER) : reboot.code === 1;
  const indexAgeMs = pm === 'apt' ? await aptIndexAge(profile) : null;
  return {
    timestamp: Date.now(),
    pm,
    updates,
    rebootRequired,
    rebootPackages: reboot.packages,
    indexAgeMs,
  };
}
