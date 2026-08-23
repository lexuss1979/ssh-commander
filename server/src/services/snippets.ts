import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';
import { withTimeout } from '../util/async.js';

/**
 * Хранилище сохранённых команд (эпик 18): сниппет — «команда на всех или на
 * выбранных серверах». Паттерн `db-connections.ts`: zod-валидация, атомарная
 * запись tmp+rename, corrupt-guard. Секретов нет — safe-маппинг не нужен,
 * запись отдаётся наружу как есть (команда может содержать пароль — тот же
 * уровень доверия, что у терминала и `profiles.json`).
 */

export const snippetInputSchema = z.object({
  name: z.string().min(1, 'Укажите имя команды').max(100),
  command: z.string().min(1, 'Укажите команду').max(10000),
  description: z.string().max(500).optional(),
  // null — «доступен на всех серверах»; отсутствие поля означает то же самое.
  profileIds: z.array(z.string().min(1)).max(50).nullable().optional(),
});

export type SnippetInput = z.infer<typeof snippetInputSchema>;

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  profileIds?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

const snippetSchema = snippetInputSchema.extend({
  id: z.string().min(1),
  profileIds: z.array(z.string().min(1)).max(50).nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const storeSchema = z.object({ snippets: z.array(snippetSchema).default([]) });

let cache: Snippet[] | null = null;
// Set when the store file failed to parse: the broken file is moved aside
// (kept for recovery) and persist() refuses to run until a restart with a
// fixed file, so a corrupt store is never silently overwritten.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'snippets.json');
}

function load(): Snippet[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).snippets;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = [];
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(`snippets store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`, err);
        corrupt = true;
        cache = [];
      }
    }
  }
  return cache;
}

function persist(list: Snippet[]): void {
  if (corrupt) {
    throw new Error('snippets store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ snippets: list }, null, 2));
  fs.renameSync(tmp, storePath());
  cache = list;
}

export function listSnippets(): Snippet[] {
  // profileIds копируем глубже: наружу не должен уходить массив, общий с кэшем.
  return load().map((s) => ({
    ...s,
    profileIds: s.profileIds ? [...s.profileIds] : s.profileIds,
  }));
}

export function getSnippet(id: string): Snippet | undefined {
  return load().find((s) => s.id === id);
}

export function requireSnippet(id: string): Snippet {
  const snippet = getSnippet(id);
  if (!snippet) {
    throw new Error(`Сниппет ${id} не найден`);
  }
  return snippet;
}

function newId(list: Snippet[]): string {
  // 8 символов UUID — 32 бита; коллизию проверяем, иначе delete/update
  // задели бы обе записи.
  let id = crypto.randomUUID().slice(0, 8);
  while (list.some((s) => s.id === id)) {
    id = crypto.randomUUID().slice(0, 8);
  }
  return id;
}

export function createSnippet(input: unknown): Snippet {
  const data = snippetInputSchema.parse(input);
  const now = new Date().toISOString();
  const snippet: Snippet = {
    ...data,
    profileIds: data.profileIds ?? null,
    id: newId(load()),
    createdAt: now,
    updatedAt: now,
  };
  // Новый массив, а не мутация кэша: при отказе persist (corrupt/диск) кэш
  // в памяти не должен разойтись с файлом на диске.
  persist([...load(), snippet]);
  return { ...snippet };
}

/** Полная замена полей по схеме: секретов нет, частичный update не нужен. */
export function updateSnippet(id: string, input: unknown): Snippet {
  const list = load();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) {
    throw new Error(`Сниппет ${id} не найден`);
  }
  const existing = list[idx];
  const data = snippetInputSchema.parse(input);
  const updated: Snippet = {
    ...data,
    profileIds: data.profileIds ?? null,
    id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  persist(list.map((s, i) => (i === idx ? updated : s)));
  return { ...updated };
}

export function deleteSnippet(id: string): void {
  const list = load();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) {
    throw new Error(`Сниппет ${id} не найден`);
  }
  persist(next);
}

// ---------------------------------------------------------------------------
// Запуск на нескольких профилях
// ---------------------------------------------------------------------------

/** Таймаут на профиль: перезапуск службы бывает дольше дефолтных 60 c exec. */
export const RUN_TIMEOUT_MS = 120000;
/** Лимит целей за один запуск: по транзитному SSH-каналу на профиль. */
export const RUN_PROFILES_LIMIT = 10;
/** Обрезка вывода в ответе: 10 профилей × 2 МБ × 2 потока в один JSON нельзя. */
export const RUN_RESULT_TEXT_LIMIT = 100_000;

/** Тело POST /api/snippets/run: сниппет или разовая команда, XOR на схеме. */
export const snippetRunBodySchema = z
  .object({
    snippetId: z.string().min(1).optional(),
    command: z.string().min(1, 'Пустая команда').optional(),
    profileIds: z
      .array(z.string().min(1))
      .min(1, 'Укажите хотя бы один сервер')
      .max(RUN_PROFILES_LIMIT, `Не больше ${RUN_PROFILES_LIMIT} серверов за запуск`),
  })
  .superRefine((v, ctx) => {
    if (v.snippetId && v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Укажите только одно из snippetId или command' });
    } else if (!v.snippetId && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Укажите сниппет или команду' });
    }
  });

export type SnippetRunBody = z.infer<typeof snippetRunBodySchema>;

/** Результат запуска на одном профиле — элемент ответа /api/snippets/run. */
export interface SnippetRunResult {
  profileId: string;
  /** true — только exit code 0. */
  ok: boolean;
  /** null — транспортный отказ/таймаут, команда не завершилась. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Длительность попытки (мс), включая отказ по таймауту. */
  ms: number;
  /** stdout или stderr не влезли в лимит ответа. */
  truncated: boolean;
  /** Текст транспортного отказа (отсутствует, если команда завершилась). */
  error?: string;
}

/** Результат профиля до маппинга: settled-статус exec + замер времени. */
export interface SnippetRunEntry {
  profileId: string;
  ms: number;
  result: PromiseSettledResult<ExecResult>;
}

export function truncateRunText(text: string): { text: string; truncated: boolean } {
  if (text.length <= RUN_RESULT_TEXT_LIMIT) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, RUN_RESULT_TEXT_LIMIT), truncated: true };
}

/**
 * Чистый маппинг settled-результатов в элементы ответа (под unit-тесты).
 * Отказ профиля — ok:false с текстом ошибки, остальные результаты целы.
 */
export function mapRunResults(entries: SnippetRunEntry[]): SnippetRunResult[] {
  return entries.map(({ profileId, ms, result }) => {
    if (result.status === 'rejected') {
      const reason = result.reason;
      return {
        profileId,
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        ms,
        truncated: false,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    const stdout = truncateRunText(result.value.stdout);
    const stderr = truncateRunText(result.value.stderr);
    return {
      profileId,
      ok: result.value.code === 0,
      code: result.value.code,
      stdout: stdout.text,
      stderr: stderr.text,
      ms,
      truncated: stdout.truncated || stderr.truncated,
    };
  });
}

export type SnippetExecFn = (
  profile: Profile,
  command: string,
  opts: { timeoutMs?: number },
) => Promise<ExecResult>;

/**
 * Параллельный запуск команды на профилях. Команда передаётся в exec как
 * есть: это ручной инструмент уровня терминала — без deny-листа и без
 * экранирования (защита — подтверждение в UI со списком целей). На профиль —
 * guard-таймаут RUN_TIMEOUT_MS, чтобы один зависший сервер не держал ответ;
 * отказ одного профиля не роняет остальные (Promise.all-обёртки не бросают).
 */
export async function runSnippetOnProfiles(
  command: string,
  profiles: Profile[],
  deps: { execFn?: SnippetExecFn } = {},
): Promise<SnippetRunResult[]> {
  const execFn = deps.execFn ?? exec;
  const entries = await Promise.all(
    profiles.map(async (profile): Promise<SnippetRunEntry> => {
      const start = Date.now();
      try {
        const value = await withTimeout(
          execFn(profile, command, { timeoutMs: RUN_TIMEOUT_MS }),
          RUN_TIMEOUT_MS,
          `Превышено время выполнения (${RUN_TIMEOUT_MS / 1000} с)`,
        );
        return { profileId: profile.id, ms: Date.now() - start, result: { status: 'fulfilled', value } };
      } catch (reason) {
        return { profileId: profile.id, ms: Date.now() - start, result: { status: 'rejected', reason } };
      }
    }),
  );
  return mapRunResults(entries);
}
