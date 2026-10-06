import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { exec } from '../ssh/manager.js';
import type { ExecResult, Profile } from '../types.js';
import { withTimeout } from '../util/async.js';

/**
 * Saved commands store (epic 18): a snippet is "a command on all or selected
 * servers". The `db-connections.ts` pattern: zod validation, atomic
 * tmp+rename write, corrupt-guard. No secrets — no safe mapping needed, the
 * record is returned as is (a command may contain a password — the same
 * trust level as the terminal and `profiles.json`).
 */

export const snippetInputSchema = z.object({
  name: z.string().min(1, 'Укажите имя команды').max(100),
  command: z.string().min(1, 'Укажите команду').max(10000),
  description: z.string().max(500).optional(),
  // null — "available on all servers"; a missing field means the same.
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
  // 0600: saved commands may contain secrets (a terminal-level risk).
  fs.writeFileSync(tmp, JSON.stringify({ snippets: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = list;
}

export function listSnippets(): Snippet[] {
  // profileIds is copied deeper: the array shared with the cache must not leak out.
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
  // 8 UUID characters — 32 bits; collisions are checked, otherwise
  // delete/update would hit both records.
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
  // A new array, not a cache mutation: if persist fails (corrupt/disk), the
  // in-memory cache must not diverge from the file on disk.
  persist([...load(), snippet]);
  return { ...snippet };
}

/** Full replacement of fields per the schema: no secrets, a partial update is not needed. */
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
// Running on multiple profiles
// ---------------------------------------------------------------------------

/** Timeout per profile: a service restart can take longer than the exec default of 60 s. */
export const RUN_TIMEOUT_MS = 120000;
/** Target limit per run: one transit SSH channel per profile. */
export const RUN_PROFILES_LIMIT = 10;
/** Output truncation in the response: 10 profiles × 2 MB × 2 streams must not go into one JSON. */
export const RUN_RESULT_TEXT_LIMIT = 100_000;

/** POST /api/snippets/run body: a snippet or an ad-hoc command, XOR at the schema level. */
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

/** Result of a run on one profile — an element of the /api/snippets/run response. */
export interface SnippetRunResult {
  profileId: string;
  /** true — exit code 0 only. */
  ok: boolean;
  /** null — transport failure/timeout, the command did not finish. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Attempt duration (ms), including a timeout failure. */
  ms: number;
  /** stdout or stderr did not fit into the response limit. */
  truncated: boolean;
  /** Transport failure text (absent if the command finished). */
  error?: string;
}

/** Profile result before mapping: the exec settled status + a time measurement. */
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
 * Pure mapping of settled results to response items (for unit tests).
 * A profile failure — ok:false with the error text, the other results are
 * intact.
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
 * Parallel command run on profiles. The command is passed to exec as is:
 * this is a manual terminal-level tool — no command filtering and no
 * escaping (the protection is the UI confirmation with the list of targets).
 * Per profile — the RUN_TIMEOUT_MS guard timeout, so that one hung server
 * does not hold the response; one profile's failure does not fail the others
 * (the Promise.all wrappers do not throw).
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
