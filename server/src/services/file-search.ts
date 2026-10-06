import { exec } from '../ssh/manager.js';
import { shq } from '../util/shell.js';
import type { Profile } from '../types.js';

export const SEARCH_MAX_DEPTH = 10;
export const SEARCH_MAX_RESULTS = 500;
export const SEARCH_TIMEOUT_MS = 30000;

const MAX_GREP_MATCHES_PER_FILE = 5;
const PREVIEW_MAX_LEN = 200;

export type SearchMode = 'name' | 'content';

export interface FileSearchResult {
  path: string;
  line?: number;
  preview?: string;
}

export interface SearchOptions {
  path: string;
  pattern: string;
  mode: SearchMode;
  glob?: string;
  limit: number;
}

/**
 * pattern — a glob for -iname (e.g. `*.log`), passed strictly as a
 * separate escaped argument.
 */
export function buildNameSearchCommand(path: string, pattern: string): string {
  return `find ${shq(path)} -maxdepth ${SEARCH_MAX_DEPTH} -iname ${shq(pattern)}`;
}

/**
 * -F: the pattern is treated as a fixed string, not a regex — predictable
 * and safer (special characters do not break the search); -e guards a
 * pattern starting with '-'; `--` separates the path from the flags.
 */
export function buildContentSearchCommand(path: string, pattern: string, glob?: string): string {
  const include = glob?.trim() ? ` --include=${shq(glob.trim())}` : '';
  return `grep -rInF -m ${MAX_GREP_MATCHES_PER_FILE}${include} -e ${shq(pattern)} -- ${shq(path)}`;
}

export function parseNameSearchOutput(stdout: string, limit: number): FileSearchResult[] {
  const results: FileSearchResult[] = [];
  for (const line of stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    results.push({ path: p });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * The grep -n format: `path:lineno:text`. A path containing ':' is parsed
 * by the non-greedy match (the last `path:number:` variant wins); the edge
 * case of «a file name ending in :number» stays ambiguous.
 */
export function parseContentSearchOutput(stdout: string, limit: number): FileSearchResult[] {
  const results: FileSearchResult[] = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    const m = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    let preview = m[3].trim();
    if (preview.length > PREVIEW_MAX_LEN) {
      preview = `${preview.slice(0, PREVIEW_MAX_LEN)}…`;
    }
    results.push({ path: m[1], line: Number(m[2]), preview });
    if (results.length >= limit) break;
  }
  return results;
}

function friendlyError(err: Error): Error {
  if (/timed out/i.test(err.message)) {
    return new Error('Поиск занял больше 30 секунд и был остановлен — сузьте каталог или шаблон');
  }
  return err;
}

export async function searchFiles(profile: Profile, opts: SearchOptions): Promise<FileSearchResult[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), SEARCH_MAX_RESULTS);
  try {
    if (opts.mode === 'name') {
      const result = await exec(profile, buildNameSearchCommand(opts.path, opts.pattern), {
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
      const results = parseNameSearchOutput(result.stdout, limit);
      // find returns 1 on partial access errors — return what was found
      if (result.code !== 0 && results.length === 0) {
        throw new Error(result.stderr.trim() || `find exited with code ${result.code}`);
      }
      return results;
    }
    const result = await exec(profile, buildContentSearchCommand(opts.path, opts.pattern, opts.glob), {
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    // grep: 0 — matches found, 1 — not found (not an error), >=2 — error
    if (result.code !== null && result.code >= 2) {
      throw new Error(result.stderr.trim() || `grep exited with code ${result.code}`);
    }
    return parseContentSearchOutput(result.stdout, limit);
  } catch (err) {
    throw friendlyError(err as Error);
  }
}
