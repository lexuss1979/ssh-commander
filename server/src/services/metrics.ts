import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

export interface CpuMetrics {
  /** Загрузка CPU в процентах (0–100, 1 знак после запятой) или null, если не удалось посчитать. */
  percent: number | null;
  cores: number | null;
}

export interface MemoryMetrics {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
}

export interface DiskMetrics {
  filesystem: string;
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number | null;
}

export interface ProcessInfo {
  user: string;
  pid: number;
  cpuPercent: number | null;
  memPercent: number | null;
  command: string;
}

export interface ServerMetrics {
  /** Момент снимка (мс, серверное время ssh-commander). */
  timestamp: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  uptimeSeconds: number | null;
  loadAverage: [number, number, number] | null;
  processes: ProcessInfo[];
}

// Один exec на весь снимок. Секции разделены маркерами @@NAME@@, чтобы
// вывод утилит не смешивался. Источники читаем из /proc, а не из локализуемых
// команд (uptime, free): формат /proc не зависит от локали сервера.
// CPU считаем по двум чтениям /proc/stat с паузой 0.5 c внутри того же exec —
// снимок самодостаточен и не зависит от истории опросов.
// df: -P заставляет писать по строке на ФС (без переносов длинных имён),
// -k — килобайты (портируемо, включая busybox). -x исключает псевдо-ФС там,
// где df это понимает; парсер дополнительно фильтрует их по имени устройства.
const COLLECT_CMD = [
  `printf '@@STAT1@@\\n'; head -n 1 /proc/stat`,
  `sleep 0.5`,
  `printf '@@STAT2@@\\n'; head -n 1 /proc/stat`,
  `printf '@@CORES@@\\n'; grep -c '^cpu[0-9]' /proc/stat`,
  `printf '@@MEM@@\\n'; cat /proc/meminfo`,
  `printf '@@DF@@\\n'; df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -P -k`,
  `printf '@@UPTIME@@\\n'; cat /proc/uptime`,
  `printf '@@LOAD@@\\n'; cat /proc/loadavg`,
  `printf '@@PS@@\\n'; (ps aux --sort=-%cpu 2>/dev/null || ps aux) | head -n 11`,
].join('; ');

function toNum(s: string | undefined): number | null {
  if (!s) return null;
  // Числа с запятой встречаются в локализованном выводе (напр. ps в ru_RU).
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function cpuLineFields(text: string): number[] | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const fields = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((f) => Number(f));
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
  return fields;
}

/**
 * Процент загрузки CPU по двум снимкам агрегированной строки `cpu` из
 * /proc/stat: доля не-idle времени между снимками. idle включает iowait.
 */
export function parseCpuPercent(before: string, after: string): number | null {
  const a = cpuLineFields(before);
  const b = cpuLineFields(after);
  if (!a || !b) return null;
  const len = Math.min(a.length, b.length);
  let totalDelta = 0;
  for (let i = 0; i < len; i++) totalDelta += b[i] - a[i];
  const idleDelta = (b[3] - a[3]) + ((b[4] ?? 0) - (a[4] ?? 0));
  if (totalDelta <= 0) return null;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/** Количество ядер — вывод `grep -c '^cpu[0-9]' /proc/stat`. */
export function parseCores(grepCount: string): number | null {
  const n = Number(grepCount.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseMeminfo(text: string): MemoryMetrics {
  const get = (name: string): number | null => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get('MemTotal');
  let available = get('MemAvailable');
  if (available === null) {
    // Старые ядра без MemAvailable: приближение free + buffers + cached.
    const free = get('MemFree');
    if (free !== null) {
      available = free + (get('Buffers') ?? 0) + (get('Cached') ?? 0);
    }
  }
  const used =
    total !== null && available !== null ? Math.max(0, total - available) : null;
  const usedPercent =
    used !== null && total ? Math.round((used / total) * 1000) / 10 : null;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usedPercent,
  };
}

// Псевдо-ФС: не диски, в списке не нужны (дублирует -x флаги df — страховка
// для систем, где df не понимает -x и отработал фолбэк).
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|shm|none)$/;

/** Вывод `df -P -k`: по строке на ФС, размеры в килобайтах. */
export function parseDf(text: string): DiskMetrics[] {
  const disks: DiskMetrics[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [fs, totalKb, usedKb, availKb, cap] = parts;
    // Точка монтирования может содержать пробелы — собираем хвост строки.
    const mount = parts.slice(5).join(' ');
    const total = Number(totalKb);
    const used = Number(usedKb);
    const avail = Number(availKb);
    // Заголовок (в любой локали) и мусорные строки отбрасываются по числам.
    if (![total, used, avail].every((n) => Number.isFinite(n))) continue;
    if (!/%$/.test(cap)) continue;
    if (SKIP_FS.test(fs)) continue;
    let pct = toNum(cap.replace('%', ''));
    if (pct === null && total > 0) pct = (used / total) * 100;
    disks.push({
      filesystem: fs,
      mount,
      totalBytes: total * 1024,
      usedBytes: used * 1024,
      availableBytes: avail * 1024,
      usedPercent: pct !== null ? Math.round(pct * 10) / 10 : null,
    });
  }
  return disks;
}

/** /proc/uptime: "секунды_аптайма секунды_idle". */
export function parseProcUptime(text: string): number | null {
  const n = toNum(text.trim().split(/\s+/)[0]);
  return n !== null ? Math.floor(n) : null;
}

/** /proc/loadavg: "1мин 5мин 15мин running/total last_pid". */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/);
  const a = toNum(parts[0]);
  const b = toNum(parts[1]);
  const c = toNum(parts[2]);
  return a !== null && b !== null && c !== null ? [a, b, c] : null;
}

/** Вывод `ps aux` (с заголовком), до 10 процессов. */
export function parsePsAux(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(
      /^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/,
    );
    if (!m || m[1] === 'USER') continue;
    out.push({
      user: m[1],
      pid: Number(m[2]),
      cpuPercent: toNum(m[3]),
      memPercent: toNum(m[4]),
      command: m[5].trim(),
    });
    if (out.length >= 10) break;
  }
  return out;
}

function splitSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^@@([A-Z0-9]+)@@\s*$/);
    if (m) {
      current = m[1];
      sections.set(current, '');
      continue;
    }
    if (current !== null) {
      sections.set(current, (sections.get(current) ?? '') + line + '\n');
    }
  }
  return sections;
}

/** Разбор полного вывода COLLECT_CMD в типизированный снимок. */
export function parseMetricsOutput(raw: string): ServerMetrics {
  const s = splitSections(raw);
  return {
    timestamp: Date.now(),
    cpu: {
      percent: parseCpuPercent(s.get('STAT1') ?? '', s.get('STAT2') ?? ''),
      cores: parseCores(s.get('CORES') ?? ''),
    },
    memory: parseMeminfo(s.get('MEM') ?? ''),
    disks: parseDf(s.get('DF') ?? ''),
    uptimeSeconds: parseProcUptime(s.get('UPTIME') ?? ''),
    loadAverage: parseLoadavg(s.get('LOAD') ?? ''),
    processes: parsePsAux(s.get('PS') ?? ''),
  };
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<ServerMetrics> }>();

/**
 * Снимок метрик сервера. Последний результат кэшируется на 2 c на профиль
 * (и параллельные вызовы делят один exec), чтобы частые опросы с нескольких
 * вкладок не плодили SSH-команды. Ошибочный промис из кэша удаляется —
 * следующий опрос попробует снова.
 */
export function collectMetrics(profile: Profile): Promise<ServerMetrics> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = exec(profile, COLLECT_CMD).then((result) => {
    if (result.code !== 0 && !result.stdout.includes('@@STAT2@@')) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`metrics command exited with code ${result.code}${detail ? `: ${detail}` : ''}`);
    }
    return parseMetricsOutput(result.stdout);
  });
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}
