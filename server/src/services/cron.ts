import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

export interface CronEntry {
  /** Номер строки в файле (0-based) — ключ для мутаций пользовательского crontab. */
  index: number;
  /** Исходная строка файла как есть. */
  raw: string;
  /** false для закомментированных строк, парсящихся как cron-запись. */
  enabled: boolean;
  /** '@daily' или пять полей 'm h dom mon dow'. */
  schedule: string;
  command: string;
  /** Пользователь из колонки системного формата (/etc/crontab, /etc/cron.d). */
  user?: string;
  /** Человекочитаемое описание расписания (describeSchedule). */
  human: string;
}

export interface ParsedCrontab {
  entries: CronEntry[];
  /** Строки вида NAME=value (MAILTO, PATH, ...) — как есть. */
  env: string[];
  /** Комментарии, не являющиеся выключенными задачами. */
  comments: string[];
}

export interface CronSnapshot {
  /** Момент снимка (мс, серверное время ssh-commander). */
  timestamp: number;
  /** Имя SSH-пользователя (владелец пользовательского crontab). */
  username: string;
  /** null — crontab пользователя отсутствует. */
  userCrontab: (ParsedCrontab & { raw: string }) | null;
  /** /etc/crontab, null — файла нет или не читается. */
  systemCrontab: ParsedCrontab | null;
  /** Файлы /etc/cron.d/* (только записи задач). */
  cronD: { file: string; entries: CronEntry[] }[];
}

export type CronOp =
  | { type: 'add'; schedule: string; command: string }
  | { type: 'update'; index: number; expectedRaw: string; schedule: string; command: string }
  | { type: 'delete'; index: number; expectedRaw: string }
  | { type: 'toggle'; index: number; expectedRaw: string };

/** Crontab изменился между чтением и записью (или строка не найдена). */
export class CronConflictError extends Error {
  readonly code = 'CONFLICT';
}

const KEYWORDS = [
  '@reboot',
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
];

const NAMES_RE = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|sun|mon|tue|wed|thu|fri|sat)/gi;

/** Поле cron: цифры, звёздочка, слэш, запятая, дефис, либо имена месяцев/дней недели (mon-fri, jan и т.п.). */
function looksLikeField(f: string): boolean {
  if (!f) return false;
  const stripped = f.replace(NAMES_RE, '');
  if (!/^[\d*/,-]*$/.test(stripped)) return false;
  return stripped.length > 0 || stripped.length < f.length;
}

/**
 * Разбор одной строки как cron-записи. system=true — формат /etc/crontab и
 * /etc/cron.d с колонкой пользователя. Возвращает null, если строка не похожа
 * на задачу (комментарий, env, мусор).
 */
function parseCronLine(
  line: string,
  system: boolean,
): { schedule: string; command: string; user?: string } | null {
  const t = line.trim();
  if (!t) return null;
  if (t.startsWith('@')) {
    const m = t.match(/^(\S+)\s+(.+)$/);
    if (!m || !KEYWORDS.includes(m[1])) return null;
    return { schedule: m[1], command: m[2].trim() };
  }
  const fields = t.split(/\s+/);
  if (fields.length < (system ? 7 : 6)) return null;
  const sched = fields.slice(0, 5);
  if (!sched.every(looksLikeField)) return null;
  const rest = fields.slice(5);
  let user: string | undefined;
  let cmdParts = rest;
  if (system) {
    user = rest[0];
    cmdParts = rest.slice(1);
  }
  const command = cmdParts.join(' ').trim();
  if (!command) return null;
  return { schedule: sched.join(' '), command, user };
}

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

/**
 * Парсинг crontab-файла. Закомментированные строки, парсящиеся как задача,
 * попадают в entries с enabled=false; env-строки и прочие комментарии —
 * отдельно, чтобы UI мог показать их и не потерять при записи.
 */
export function parseCrontab(text: string, opts: { system: boolean }): ParsedCrontab {
  const entries: CronEntry[] = [];
  const env: string[] = [];
  const comments: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, index) => {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith('#')) {
      const disabled = parseCronLine(t.slice(1), opts.system);
      if (disabled) {
        entries.push({ index, raw: line, enabled: false, human: describeSchedule(disabled.schedule), ...disabled });
      } else {
        comments.push(line);
      }
      return;
    }
    if (ENV_RE.test(t)) {
      env.push(line);
      return;
    }
    const parsed = parseCronLine(t, opts.system);
    if (parsed) {
      entries.push({ index, raw: line, enabled: true, human: describeSchedule(parsed.schedule), ...parsed });
    }
    // Нераспознанные строки игнорируем (не теряем: raw crontab хранится в snapshot).
  });
  return { entries, env, comments };
}

const KEYWORD_HUMAN: Record<string, string> = {
  '@reboot': 'при загрузке системы',
  '@yearly': 'ежегодно',
  '@annually': 'ежегодно',
  '@monthly': 'ежемесячно',
  '@weekly': 'еженедельно',
  '@daily': 'ежедневно',
  '@midnight': 'ежедневно в 00:00',
  '@hourly': 'ежечасно',
};

const DOW_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Краткое описание частых расписаний на русском; нераспознанное — само выражение. */
export function describeSchedule(expr: string): string {
  const kw = KEYWORD_HUMAN[expr];
  if (kw) return kw;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f;
  if (f.every((x) => x === '*')) return 'каждую минуту';
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `каждые ${min.slice(2)} мин`;
  }
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `каждые ${hour.slice(2)} ч`;
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `ежечасно в :${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const t = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dow === '*') return `ежедневно в ${t}`;
    if (dow === '1-5') return `по будням в ${t}`;
    if (dow === '0-6') return `по выходным в ${t}`;
    if (/^\d+$/.test(dow)) {
      const n = Number(dow) % 7;
      return `еженедельно (${DOW_NAMES[n]}) в ${t}`;
    }
    return `в ${t}, дни недели: ${dow}`;
  }
  return expr;
}

/**
 * Валидация расписания из формы: @keyword или ровно 5 полей, значения
 * в диапазонах. null — валидно, иначе текст ошибки на русском.
 */
export function validateCronFields(schedule: string): string | null {
  const s = schedule.trim();
  if (!s) return 'Расписание не задано';
  if (s.startsWith('@')) {
    return KEYWORDS.includes(s) ? null : `Неизвестный пресет ${s} (доступны: ${KEYWORDS.join(' ')})`;
  }
  const fields = s.split(/\s+/);
  if (fields.length !== 5) return 'Нужно ровно 5 полей: минута час день месяц день-недели';
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const labels = ['минута', 'час', 'день месяца', 'месяц', 'день недели'];
  for (let i = 0; i < 5; i++) {
    const f = fields[i];
    if (!looksLikeField(f)) return `Недопустимое поле «${f}» (${labels[i]})`;
    for (const token of f.split(',')) {
      const nums = token
        .replace(/\*\/?/g, '')
        .replace(NAMES_RE, '')
        .split('-')
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      for (const n of nums) {
        if (n < ranges[i][0] || n > ranges[i][1]) {
          return `Значение ${n} вне диапазона ${ranges[i][0]}–${ranges[i][1]} (${labels[i]})`;
        }
      }
    }
  }
  return null;
}

function entryLine(schedule: string, command: string): string {
  return `${schedule.trim()} ${command.trim()}`;
}

/**
 * Применение операции к тексту пользовательского crontab. Комментарии,
 * env-строки и порядок строк сохраняются. expectedRaw — защита от гонки:
 * строка по index обязана совпасть, иначе CronConflictError.
 * Возвращает текст с завершающим переводом строки.
 */
export function applyCrontabOp(text: string, op: CronOp): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const check = (index: number, expectedRaw: string) => {
    if (!Number.isInteger(index) || index < 0 || index >= lines.length || lines[index] !== expectedRaw) {
      throw new CronConflictError('Crontab изменился — обновите страницу');
    }
  };

  switch (op.type) {
    case 'add':
      lines.push(entryLine(op.schedule, op.command));
      break;
    case 'update':
      check(op.index, op.expectedRaw);
      lines[op.index] = entryLine(op.schedule, op.command);
      break;
    case 'delete':
      check(op.index, op.expectedRaw);
      lines.splice(op.index, 1);
      break;
    case 'toggle': {
      check(op.index, op.expectedRaw);
      const t = lines[op.index].trim();
      lines[op.index] = t.startsWith('#') ? t.replace(/^#\s?/, '') : `# ${lines[op.index]}`;
      break;
    }
  }
  return lines.join('\n') + '\n';
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<CronSnapshot> }>();

/** crontab -l; отсутствие crontab (exit 1, пустой вывод) — null, не ошибка. */
async function fetchUserCrontab(profile: Profile): Promise<string | null> {
  const r = await exec(profile, 'crontab -l 2>/dev/null');
  if (r.code !== 0) {
    if (r.stdout.trim() === '') return null;
    throw new Error(`crontab -l завершился с кодом ${r.code}`);
  }
  return r.stdout;
}

/** /etc/crontab и /etc/cron.d/* одной командой; недоступные файлы — пусто. */
async function fetchSystemCron(profile: Profile): Promise<{ crontab: string | null; cronD: { file: string; text: string }[] }> {
  const cmd =
    'if [ -r /etc/crontab ]; then echo "=== /etc/crontab"; cat /etc/crontab; fi; ' +
    'for f in /etc/cron.d/*; do if [ -r "$f" ]; then echo "=== $f"; cat "$f"; fi; done';
  const r = await exec(profile, cmd);
  if (r.code !== 0 && r.stdout.trim() === '') return { crontab: null, cronD: [] };
  const files: { file: string; text: string }[] = [];
  let current: { file: string; lines: string[] } | null = null;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^=== (.+)$/);
    if (m) {
      current = { file: m[1], lines: [] };
      files.push({ file: current.file, text: '' });
    } else if (current) {
      current.lines.push(line);
      files[files.length - 1].text = current.lines.join('\n');
    }
  }
  const crontab = files.find((f) => f.file === '/etc/crontab')?.text ?? null;
  return { crontab, cronD: files.filter((f) => f.file !== '/etc/crontab') };
}

async function collectCronUncached(profile: Profile): Promise<CronSnapshot> {
  const [userRaw, system, whoami] = await Promise.all([
    fetchUserCrontab(profile),
    fetchSystemCron(profile),
    exec(profile, 'id -un'),
  ]);
  return {
    timestamp: Date.now(),
    username: whoami.stdout.trim() || profile.username,
    userCrontab: userRaw === null ? null : { ...parseCrontab(userRaw, { system: false }), raw: userRaw },
    systemCrontab: system.crontab === null ? null : parseCrontab(system.crontab, { system: true }),
    cronD: system.cronD.map((f) => ({ file: f.file, entries: parseCrontab(f.text, { system: true }).entries })),
  };
}

/**
 * Снимок cron-задач сервера. Кэш 2 с на профиль (параллельные вызовы делят
 * одни exec'и) — как у портов/метрик, чтобы polling не плодил SSH-команды.
 */
export function collectCron(profile: Profile): Promise<CronSnapshot> {
  const now = Date.now();
  const hit = cache.get(profile.id);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.promise;
  }
  const promise = collectCronUncached(profile);
  cache.set(profile.id, { at: now, promise });
  promise.catch(() => {
    if (cache.get(profile.id)?.promise === promise) {
      cache.delete(profile.id);
    }
  });
  return promise;
}

/**
 * Мутация пользовательского crontab: читаем заново (без кэша), применяем
 * операцию, пишем целиком через `crontab -` (stdin канала).
 */
export async function mutateUserCrontab(profile: Profile, op: CronOp): Promise<void> {
  const current = await fetchUserCrontab(profile);
  const next = applyCrontabOp(current ?? '', op);
  const r = await exec(profile, 'crontab -', { stdin: next });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    throw new Error(`crontab отклонил файл (код ${r.code})${detail ? `: ${detail}` : ''}`);
  }
  cache.delete(profile.id);
}
