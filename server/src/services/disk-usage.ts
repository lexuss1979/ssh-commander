import { exec, getSftp } from '../ssh/manager.js';
import { stat as sftpStat } from '../ssh/sftp.js';
import { shq } from '../util/shell.js';
import { basename } from '../util/path.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * «Что съело диск» — навигатор по du (эпик 16).
 *
 * Один уровень дерева за запрос: `du -x -d 1 -k` (сам каталог — последней
 * строкой в post-order, плюс прямые подкаталоги) и топ крупнейших файлов
 * через `find`. Всё read-only, команды собирает сервис (guard их не видит —
 * прецедент security_audit). stderr не глушится, а ловится: отказы доступа
 * дают честную пометку `incomplete`, чтобы цифры не выглядели враньём.
 *
 * Отклонения от roadmap: `-k` вместо `-B1` (BusyBox не знает `-B`, как
 * `df -P -k` в metrics.ts; парсер умножает на 1024), `2>/dev/null` не
 * используется (см. выше).
 */

export const DU_TIMEOUT_MS = 60000;
/** Максимум файлов в ответе режима «Файлы». */
export const DU_MAX_LIMIT = 500;
export const DU_DEFAULT_LIMIT = 100;
export const AGENT_DEFAULT_LIMIT = 10;
export const AGENT_MAX_LIMIT = 50;
/** Кэш только для тяжёлого du-снимка; find дешевле — не кэшируется. */
const DISK_USAGE_CACHE_TTL_MS = 2000;

export interface DiskUsageChild {
  name: string;
  path: string;
  bytes: number;
  /** Доля от суммы поддерева каталога (1 знак после запятой). */
  pctOfParent: number;
}

export interface DiskUsageSnapshot {
  path: string;
  totalBytes: number;
  /** Размер файлов прямо в каталоге (du в -d 1 их не печатает). */
  directBytes: number;
  children: DiskUsageChild[];
  /** Отказы доступа при обходе (строки stderr du/find). */
  incomplete: { unreadable: number } | null;
  /** Вывод du обрезан по лимиту exec — суммарная строка потерялась. */
  truncated: boolean;
}

export interface DiskUsageFile {
  path: string;
  bytes: number;
}

export interface TopFilesResult {
  path: string;
  files: DiskUsageFile[];
  incomplete: { unreadable: number } | null;
}

/**
 * Пользовательская ошибка (путь, права, утилиты) — маршрут отвечает 400.
 * Транспортные ошибки (exec reject, отказ SSH-соединения) не оборачиваются —
 * маршрут отвечает 502.
 */
export class DiskUsageError extends Error {}

/** exec-обёртка с инъекцией для тестов (паттерн systemd.ts: `deps.execFn`). */
export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

export interface DiskUsageDeps {
  execFn?: ExecFn;
  /** Предпроверка директории. Инъекция нужна тестам (без реального SFTP) и
   * агенту: он проверяет путь один раз на оба вызова (см. skipPrecheck). */
  precheckFn?: (profile: Profile, path: string) => Promise<void>;
  /** Пропустить предпроверку — вызывающий уже убедился, что путь — директория. */
  skipPrecheck?: boolean;
}

// ---------------------------------------------------------------------------
// Валидация пути. assertSafePath не годится: он запрещает `/`, а точка
// монтирования может быть корнем навигации.
// ---------------------------------------------------------------------------

/** Нормализация: trim, схлопывание `//`, снятие хвостового `/` (кроме корня). */
export function normalizeDiskPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  return trimmed.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

/** Абсолютный путь (`/` — можно), без сегментов `..`; иначе ошибка. */
export function assertNavigablePath(p: string): string {
  if (!p.startsWith('/')) {
    throw new DiskUsageError('Путь должен быть абсолютным (начинаться с /)');
  }
  if (p.split('/').some((part) => part === '..')) {
    throw new DiskUsageError("'..' не допускается в пути");
  }
  return p;
}

// ---------------------------------------------------------------------------
// Сборка команд (чистые билдеры). Конвейеры и редиректы здесь допустимы —
// команды собирает сервис, deny-лист guard.ts их не видит.
// ---------------------------------------------------------------------------

/** `du -x -d 1 -k`: одна ФС, уровень глубины 1, кибибайты (портируемо). */
export function buildDuCommand(path: string): string {
  return `du -x -d 1 -k -- ${shq(path)}`;
}

/** Топ файлов: GNU find с `-printf` (escape `\t` разворачивает сам find). */
export function buildTopFilesCommand(path: string, limit: number): string {
  return `find ${shq(path)} -xdev -type f -printf '%s\\t%p\\n' | sort -rn | head -n ${limit}`;
}

/**
 * Фолбэк без `-printf` (BusyBox): `stat -c '%s\t%n'`, где `\t` — литеральный
 * символ табуляции (0x09) внутри одинарных кавычек, а не escape-последова-
 * тельность: GNU stat разворачивает `\t` сам, BusyBox — нет, и парсер
 * получил бы строки без разделителя. С литеральным табом оба ведут себя
 * одинаково (shell передаёт байт через одинарные кавычки как есть).
 */
export function buildTopFilesStatCommand(path: string, limit: number): string {
  return `find ${shq(path)} -xdev -type f -exec stat -c '%s${'\t'}%n' {} + | sort -rn | head -n ${limit}`;
}

/**
 * Признак того, что find не понял опцию (у `-printf` и `-exec … +` — общий
 * класс). Формулировки расходятся сильнее, чем кажется: BusyBox —
 * `find: unrecognized: -printf`, GNU — `find: unknown predicate `-printf'`,
 * BSD — `find: -printf: unknown primary or operator`.
 */
export function needsStatFallback(stderr: string): boolean {
  return /unrecognized|unknown (primary|predicate|option)|invalid option|not supported/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Парсеры (чистые, терпимые к обрезанному выводу 2 МБ).
// ---------------------------------------------------------------------------

const DU_LINE_RE = /^\s*(\d+)\t(.+)$/;

/**
 * Вывод `du -x -d 1 -k` (строки `размер\tпуть`, разделитель — первый таб;
 * путь с пробелами/табами — хвост строки). Суммарная запись каталога ищется
 * по совпадению пути, а не по позиции: и GNU, и BusyBox печатают сам каталог
 * последней строкой (post-order), но надёжнее не полагаться на порядок.
 * Записи нет → `totalKb: null` — признак обрезанного вывода, не ошибка.
 */
export function parseDuKb(
  text: string,
  basePath: string,
): { totalKb: number | null; children: { path: string; kb: number }[] } {
  let totalKb: number | null = null;
  const children: { path: string; kb: number }[] = [];
  const prefix = basePath === '/' ? '/' : `${basePath}/`;
  for (const line of text.split('\n')) {
    const m = line.match(DU_LINE_RE);
    if (!m) continue;
    const kb = Number(m[1]);
    if (!Number.isFinite(kb)) continue;
    const p = m[2];
    if (p === basePath) {
      totalKb = kb;
    } else if (p.startsWith(prefix)) {
      children.push({ path: p, kb });
    }
  }
  return { totalKb, children };
}

function pctOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Сборка ответа: дети отсортированы по убыванию, `directBytes` — размер
 * файлов прямо в каталоге (clamp ≥ 0: du и df расходятся на незакрытых
 * удалённых файлах и т.п.). При `totalKb === null` и непустых детях —
 * деградация: сумма по детям, `truncated: true`; без детей — ошибка
 * (парсить действительно нечего).
 */
export function toDuSnapshot(
  path: string,
  totalKb: number | null,
  children: { path: string; kb: number }[],
): { totalBytes: number; directBytes: number; children: DiskUsageChild[]; truncated: boolean } {
  if (totalKb === null) {
    if (children.length === 0) {
      throw new DiskUsageError('du не вернул размер каталога (вывод обрезан)');
    }
    const totalBytes = children.reduce((s, c) => s + c.kb * 1024, 0);
    const out = children
      .map((c) => ({
        name: basename(c.path),
        path: c.path,
        bytes: c.kb * 1024,
        pctOfParent: pctOf(c.kb * 1024, totalBytes),
      }))
      .sort((a, b) => b.bytes - a.bytes);
    return { totalBytes, directBytes: 0, children: out, truncated: true };
  }
  const totalBytes = totalKb * 1024;
  const sumChildren = children.reduce((s, c) => s + c.kb * 1024, 0);
  const out = children
    .map((c) => ({
      name: basename(c.path),
      path: c.path,
      bytes: c.kb * 1024,
      pctOfParent: pctOf(c.kb * 1024, totalBytes),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes,
    directBytes: Math.max(0, totalBytes - sumChildren),
    children: out,
    truncated: false,
  };
}

/** Вывод `find … | sort -rn | head`: путь и размер, по убыванию. */
export function parseFindOutput(text: string): DiskUsageFile[] {
  const out: DiskUsageFile[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(DU_LINE_RE);
    if (!m) continue;
    const bytes = Number(m[1]);
    if (!Number.isFinite(bytes)) continue;
    out.push({ path: m[2], bytes });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/** Число строк отказа доступа в stderr — для пометки «доступно не всё». */
export function countUnreadable(stderr: string): number {
  let n = 0;
  for (const line of stderr.split('\n')) {
    if (/cannot (read|access)|Permission denied|Operation not permitted/i.test(line)) {
      n += 1;
    }
  }
  return n;
}

/** Целое 1..50 для инструмента агента; мусор/отсутствие — дефолт 10. */
export function clampAgentLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return AGENT_DEFAULT_LIMIT;
  return Math.min(AGENT_MAX_LIMIT, Math.round(n));
}

function humanSize(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Текстовый отчёт для инструмента агента disk_usage. */
export function formatAgentDiskUsage(
  path: string,
  snapshot: DiskUsageSnapshot,
  files: DiskUsageFile[],
  limit: number,
  filesNote?: string,
): string {
  const lines: string[] = [];
  lines.push(`Размер ${path}: ${snapshot.totalBytes} Б (${humanSize(snapshot.totalBytes)})`);
  lines.push('Крупнейшие подкаталоги:');
  if (snapshot.children.length === 0) {
    lines.push('  (подкаталогов нет)');
  }
  for (const [i, c] of snapshot.children.slice(0, limit).entries()) {
    lines.push(`  ${i + 1}. ${c.name} — ${c.bytes} Б (${c.pctOfParent}%)`);
  }
  lines.push('Крупнейшие файлы:');
  if (filesNote) {
    lines.push(`  ${filesNote}`);
  } else if (files.length === 0) {
    lines.push('  (файлов нет)');
  }
  for (const [i, f] of files.slice(0, limit).entries()) {
    lines.push(`  ${i + 1}. ${f.path} — ${f.bytes} Б`);
  }
  if (snapshot.incomplete) {
    lines.push(`(недоступно: ${snapshot.incomplete.unreadable} каталогов — нужны права доступа)`);
  }
  if (snapshot.truncated) {
    lines.push('(вывод du обрезан — сумма неполная)');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

/**
 * Предпроверка до тяжёлой команды: путь существует и это директория.
 * Разделение ошибок как в routes/metrics.ts: отказ stat (нет пути, нет прав) —
 * пользовательская ошибка (400), а отказ getSftp (соединение) пробрасывается
 * как есть — транспорт (502). Раньше вся ошибка withSftp заворачивалась в
 * DiskUsageError, и упавший SSH выглядел как «Путь недоступен: …» с кнопкой
 * «Повторить» вместо честного «Сервер недоступен».
 */
export async function precheckNavigableDir(profile: Profile, path: string): Promise<void> {
  // getSftp вне try: обрыв соединения — транспорт.
  const sftp = await getSftp(profile);
  let st;
  try {
    st = await sftpStat(sftp, path);
  } catch (err) {
    throw new DiskUsageError(`Путь недоступен: ${(err as Error).message}`);
  }
  if ((st.mode & 0o170000) !== 0o040000) {
    throw new DiskUsageError('Это не директория');
  }
}

/**
 * exec du/find с таймаутом. План называет долгий du риском №1 и обещает
 * «понятная ошибка „Превышено время ожидания"»: ssh/manager.ts бросает
 * английское «Command timed out…», которое иначе ушло бы в 502 «Сервер
 * недоступен» — сервер в порядке, это команда не уложилась. Сюда же попадает
 * агент: его деградированная строка «крупнейшие файлы недоступны» получила бы
 * тот же английский текст. Транспорт (не-таймаут) пробрасывается как есть.
 */
async function runDuExec(profile: Profile, command: string, execFn: ExecFn): Promise<ExecResult> {
  try {
    return await execFn(profile, command, { timeoutMs: DU_TIMEOUT_MS });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/timed out/i.test(msg)) {
      throw new DiskUsageError('Превышено время ожидания (60 с) — попробуйте начать с подкаталога');
    }
    throw err;
  }
}

interface CacheEntry {
  at: number;
  promise: Promise<DiskUsageSnapshot>;
}

// Ключ — "<profileId>\0<path>" (NUL не может встретиться в пути).
const duCache = new Map<string, CacheEntry>();

/**
 * Снимок du одного каталога. Кэш 2 с на (профиль, путь) — du самая тяжёлая
 * команда приложения; повторный клик по тому же каталогу не должен гонять
 * её снова. Ошибочный промис из кэша удаляется (паттерн collectMetrics).
 */
export function diskUsageSnapshot(
  profile: Profile,
  path: string,
  deps: DiskUsageDeps = {},
): Promise<DiskUsageSnapshot> {
  const key = `${profile.id}\0${path}`;
  const now = Date.now();
  const hit = duCache.get(key);
  if (hit && now - hit.at < DISK_USAGE_CACHE_TTL_MS) {
    return hit.promise;
  }
  const execFn = deps.execFn ?? exec;
  const precheckFn = deps.precheckFn ?? precheckNavigableDir;
  const promise = (async () => {
    if (!deps.skipPrecheck) {
      await precheckFn(profile, path);
    }
    const result = await runDuExec(profile, buildDuCommand(path), execFn);
    if (result.code !== 0) {
      // нет прав на сам путь, путь пропал между stat и du
      throw new DiskUsageError(result.stderr.trim() || `du завершился с кодом ${result.code}`);
    }
    const { totalKb, children } = parseDuKb(result.stdout, path);
    const snapshot = toDuSnapshot(path, totalKb, children);
    const unreadable = countUnreadable(result.stderr);
    return {
      ...snapshot,
      path,
      incomplete: unreadable > 0 ? { unreadable } : null,
    };
  })();
  duCache.set(key, { at: now, promise });
  promise.catch(() => {
    if (duCache.get(key)?.promise === promise) {
      duCache.delete(key);
    }
  });
  return promise;
}

/**
 * Топ крупнейших файлов каталога. Стратегия: пробуем `-printf`-вариант;
 * при признаке незнакомой опции (BusyBox) или пустом stdout с непустым
 * stderr (код пайплайна принадлежит head — провал find по коду не виден)
 * повторяем stat-вариантом. Эвристика «пустой stdout» сужена условием
 * `countUnreadable === 0`: штатный пустой каталог с отказами доступа в
 * подкаталогах не должен гонять второй (самый долгий) обход дерева вхолостую.
 * Один лишний exec только на BusyBox-серверах, решение не кэшируем — запрос
 * ручной и редкий.
 */
export async function topFiles(
  profile: Profile,
  path: string,
  limit: number,
  deps: DiskUsageDeps = {},
): Promise<TopFilesResult> {
  const execFn = deps.execFn ?? exec;
  const precheckFn = deps.precheckFn ?? precheckNavigableDir;
  if (!deps.skipPrecheck) {
    await precheckFn(profile, path);
  }
  let result = await runDuExec(profile, buildTopFilesCommand(path, limit), execFn);
  if (result.code !== 0 && !needsStatFallback(result.stderr)) {
    throw new DiskUsageError(result.stderr.trim() || `find завершился с кодом ${result.code}`);
  }
  if (
    needsStatFallback(result.stderr) ||
    (result.stdout.trim() === '' && result.stderr.trim() !== '' && countUnreadable(result.stderr) === 0)
  ) {
    const statResult = await runDuExec(profile, buildTopFilesStatCommand(path, limit), execFn);
    if (needsStatFallback(statResult.stderr)) {
      // и -exec … + не поддержан (экзотика): режим «Файлы» деградирует с пояснением
      throw new DiskUsageError('find не поддерживает -printf и -exec stat — режим «Файлы» недоступен на этом сервере');
    }
    if (statResult.code !== 0) {
      throw new DiskUsageError(statResult.stderr.trim() || `find завершился с кодом ${statResult.code}`);
    }
    result = statResult;
  }
  const unreadable = countUnreadable(result.stderr);
  return {
    path,
    files: parseFindOutput(result.stdout),
    incomplete: unreadable > 0 ? { unreadable } : null,
  };
}
