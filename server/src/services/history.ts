import { exec } from '../ssh/manager.js';
import type { Profile } from '../types.js';

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 200;

export type HistoryFormat = 'bash' | 'zsh';

// Читаем bash-историю, при её отсутствии — zsh. Маркер @@BASH@@/@@ZSH@@ говорит
// парсеру, какой формат пришёл (у zsh extended-формат `: 1234567890:0;команда`).
// `if` без выполненной ветки завершается с кодом 0 — пустая история не считается
// ошибкой exec. Ввод пользователя в команду не подставляется, shq не нужен.
const READ_HISTORY_CMD =
  `if [ -s ~/.bash_history ]; then printf '@@BASH@@\\n'; cat ~/.bash_history;` +
  ` elif [ -s ~/.zsh_history ]; then printf '@@ZSH@@\\n'; cat ~/.zsh_history; fi`;

const ZSH_EXTENDED_RE = /^: \d+:\d+;/;

/**
 * Разбирает содержимое файла истории в список команд.
 *
 * Дедупликация: файл пишется от старых команд к новым, результат отдаём
 * свежими сверху — идём по строкам с конца и оставляем последнее вхождение
 * каждой команды.
 *
 * Многострочные команды: ни bash, ни zsh не помечают строки-продолжения,
 * поэтому отличить продолжение от самостоятельной команды нельзя — каждая
 * непустая строка трактуется как отдельная команда (эквивалент обрезки
 * многострочной команды до её физических строк).
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

/** Возвращает формат и тело по выводу READ_HISTORY_CMD; пусто, если файлов истории нет. */
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
