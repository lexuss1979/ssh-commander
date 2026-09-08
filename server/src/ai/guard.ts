/**
 * Гейт автоматически выполняемых команд агента (`exec_readonly`).
 *
 * Разрешающий список, а не запрещающий. Запрещающий здесь принципиально
 * проигрывает: перечислить все способы назвать `rm` нельзя — `/bin/rm`,
 * `\rm`, `busybox rm` и любой ещё не придуманный псевдоним обходили список
 * имён, а `socat`/`nc`/`curl -T` уносили файл наружу, ни разу не совпав со
 * словом из запрета. Всё, чего нет в списке ниже, отправляется в `exec`,
 * то есть к пользователю на подтверждение.
 *
 * В список входят только утилиты, которые читают и печатают. Сетевых
 * клиентов (`curl`, `nc`, `socat`, `ssh`, `dig`, `ping`) здесь нет намеренно:
 * без них команда, выполненная без подтверждения, физически не может
 * отправить данные наружу. Интерпретаторов и обёрток-исполнителей
 * (`sh`, `python`, `awk`, `sed`, `env`, `xargs`, `timeout`, `sudo`) нет по
 * той же причине — они выполняют произвольный код в первом же аргументе.
 */

/** Утилиты, выполняемые без подтверждения: только чтение и печать. */
export const ALLOWED_COMMANDS = new Set([
  // файлы и каталоги
  'ls', 'cat', 'head', 'tail', 'stat', 'file', 'find', 'du', 'df', 'wc',
  'readlink', 'realpath', 'dirname', 'basename', 'pwd', 'tree', 'lsblk',
  'blkid', 'findmnt', 'mountpoint', 'zcat', 'zgrep',
  // текст и поиск
  'grep', 'egrep', 'fgrep', 'sort', 'uniq', 'cut', 'nl', 'tac', 'rev', 'tr',
  'strings', 'od', 'xxd', 'diff', 'cmp',
  // контрольные суммы
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum',
  // система
  'uname', 'hostname', 'uptime', 'date', 'whoami', 'id', 'groups', 'w', 'who',
  'last', 'lastlog', 'arch', 'nproc', 'lscpu', 'lsmem', 'lsusb', 'lspci',
  'lsof', 'free', 'vmstat', 'iostat', 'mpstat', 'dmesg', 'journalctl',
  'getconf', 'locale', 'printenv', 'echo', 'printf',
  // процессы и сеть (только состояние, без трафика)
  'ps', 'pgrep', 'pidof', 'pstree', 'top', 'ss', 'netstat',
]);

/** Каталоги, из которых допустим запуск по абсолютному пути. `/tmp/evil/cat`
 * с подходящим basename так не проходит. */
const ALLOWED_BIN_DIRS = [
  '/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/',
];

/**
 * Метасимволы шелла. Перевод строки — тоже разделитель команд, без него
 * вторая строка вообще не проверялась бы (проверяется только первый токен).
 * Скобки закрывают подстановку и подоболочки.
 */
const CONTROL_CHARS = /[><|&;`$(){}\n\r]/;
const CODE_EXECUTION = /\b(eval|source|system\s*\(|exec\s*\(|popen\s*\()/;

/**
 * Флаги, превращающие разрешённую утилиту в пишущую или исполняющую.
 * Проверяются только у своей команды: `-o` у `sort` пишет файл, а у `grep`
 * это безобидный `--only-matching`.
 */
const DANGEROUS_FLAGS: Record<string, RegExp> = {
  find: /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)$/,
  sort: /^(-o|--output(=.*)?)$/,
  journalctl: /^(--vacuum-[a-z]+(=.*)?|--rotate|--flush|--sync|--setup-keys|--relinquish-var)$/,
  dmesg: /^(-C|-c|--clear|--read-clear)$/,
  top: /^(-w)$/,
};

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Имя запускаемой утилиты из первого токена: снимает кавычки и ведущие `\`
 * (`\rm` — обход алиасов, шелл выполнит `rm`), для абсолютного пути отдаёт
 * basename, но только из системных каталогов.
 */
function resolveCommandName(token: string): { name: string } | { error: string } {
  const cleaned = token.replace(/^["']+|["']+$/g, '').replace(/^\\+/, '');
  if (!cleaned) return { error: 'Empty command' };
  if (!cleaned.includes('/')) return { name: cleaned };
  if (!ALLOWED_BIN_DIRS.some((dir) => cleaned.startsWith(dir))) {
    return {
      error: `Command '${cleaned}' is not a system binary — only ${ALLOWED_BIN_DIRS.join(', ')} may be used by path`,
    };
  }
  return { name: cleaned.slice(cleaned.lastIndexOf('/') + 1) };
}

export function checkReadOnlyCommand(command: string): GuardResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Empty command' };
  }
  if (trimmed.length > 2000) {
    return { ok: false, reason: 'Command is too long' };
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return {
      ok: false,
      reason: 'Command contains shell control characters (pipes, redirection, chaining, substitution)',
    };
  }
  if (CODE_EXECUTION.test(trimmed)) {
    return { ok: false, reason: 'Command contains code execution constructs' };
  }

  const tokens = trimmed.split(/\s+/);
  const resolved = resolveCommandName(tokens[0]);
  if ('error' in resolved) {
    return { ok: false, reason: resolved.error };
  }
  if (!ALLOWED_COMMANDS.has(resolved.name)) {
    return {
      ok: false,
      reason:
        `Command '${resolved.name}' is not in the read-only allow-list — ` +
        'use the exec tool instead (it asks the user for confirmation)',
    };
  }

  const dangerous = DANGEROUS_FLAGS[resolved.name];
  if (dangerous) {
    const flag = tokens.slice(1).find((t) => dangerous.test(t.replace(/^["']+|["']+$/g, '')));
    if (flag) {
      return { ok: false, reason: `Flag '${flag}' is not allowed in read-only mode` };
    }
  }
  return { ok: true };
}
