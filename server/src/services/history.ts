import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 200;

export type HistoryFormat = 'bash' | 'zsh';

// Read the bash history, or zsh when it is absent. The @@BASH@@/@@ZSH@@
// marker tells the parser which format arrived (zsh uses the extended
// format `: 1234567890:0;command`).
// An `if` with no taken branch exits with code 0 — empty history is not an
// exec error. No user input is substituted into the command, so shq is not
// needed.
const READ_HISTORY_CMD =
  `if [ -s ~/.bash_history ]; then printf '@@BASH@@\\n'; cat ~/.bash_history;` +
  ` elif [ -s ~/.zsh_history ]; then printf '@@ZSH@@\\n'; cat ~/.zsh_history; fi`;

const ZSH_EXTENDED_RE = /^: \d+:\d+;/;

/**
 * Parses history file content into a list of commands.
 *
 * Deduplication: the file is written from oldest commands to newest, and
 * the result is returned newest first — walk the lines from the end and
 * keep the last occurrence of each command.
 *
 * Multi-line commands: neither bash nor zsh marks continuation lines, so a
 * continuation cannot be told apart from a standalone command — every
 * non-empty line is treated as a separate command (equivalent to cutting a
 * multi-line command down to its physical lines).
 */
export function parseHistory(content: string, format: HistoryFormat, limit: number): string[] {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
    let line = lines[i].trim();
    if (format === 'zsh') line = line.replace(ZSH_EXTENDED_RE, '').trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

/** Returns format and body from the READ_HISTORY_CMD output; null when there are no history files. */
export function splitHistoryOutput(stdout: string): { format: HistoryFormat; body: string } | null {
  const bashIdx = stdout.indexOf('@@BASH@@\n');
  if (bashIdx >= 0) return { format: 'bash', body: stdout.slice(bashIdx + '@@BASH@@\n'.length) };
  const zshIdx = stdout.indexOf('@@ZSH@@\n');
  if (zshIdx >= 0) return { format: 'zsh', body: stdout.slice(zshIdx + '@@ZSH@@\n'.length) };
  return null;
}

export async function fetchHistory(profile: Profile, limit: number): Promise<string[]> {
  const { code, stdout } = await exec(profile, READ_HISTORY_CMD);
  if (code !== 0) {
    throw new Error(`Не удалось прочитать историю (exit ${code ?? 'unknown'})`);
  }
  const parsed = splitHistoryOutput(stdout);
  if (!parsed) return [];
  return parseHistory(parsed.body, parsed.format, limit);
}
