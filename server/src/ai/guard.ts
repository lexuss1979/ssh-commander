/**
 * Gate for the agent's auto-run commands (`exec_readonly`).
 *
 * An allow-list, not a deny-list. A deny-list fundamentally loses here:
 * there is no way to enumerate every way to name `rm` — `/bin/rm`,
 * `\rm`, `busybox rm` and any yet-uninvented alias slipped past the name
 * list, while `socat`/`nc`/`curl -T` carried files out without ever
 * matching a banned word. Anything missing from the list below goes to
 * `exec`, i.e. to the user for confirmation.
 *
 * The list contains only utilities that read and print. Network clients
 * (`curl`, `nc`, `socat`, `ssh`, `dig`, `ping`) are deliberately absent:
 * without them a command run without confirmation physically cannot send
 * data outside. Interpreters and exec wrappers (`sh`, `python`, `awk`,
 * `sed`, `env`, `xargs`, `timeout`, `sudo`) are absent for the same
 * reason — they execute arbitrary code given as the first argument.
 */

/** Utilities run without confirmation: read and print only. */
export const ALLOWED_COMMANDS = new Set([
  // files and directories
  'ls', 'cat', 'head', 'tail', 'stat', 'file', 'find', 'du', 'df', 'wc',
  'readlink', 'realpath', 'dirname', 'basename', 'pwd', 'tree', 'lsblk',
  'blkid', 'findmnt', 'mountpoint', 'zcat', 'zgrep',
  // text and search
  'grep', 'egrep', 'fgrep', 'sort', 'uniq', 'cut', 'nl', 'tac', 'rev', 'tr',
  'strings', 'od', 'xxd', 'diff', 'cmp',
  // checksums
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum',
  // system
  'uname', 'hostname', 'uptime', 'date', 'whoami', 'id', 'groups', 'w', 'who',
  'last', 'lastlog', 'arch', 'nproc', 'lscpu', 'lsmem', 'lsusb', 'lspci',
  'lsof', 'free', 'vmstat', 'iostat', 'mpstat', 'dmesg', 'journalctl',
  'getconf', 'locale', 'printenv', 'echo', 'printf',
  // processes and network (state only, no traffic)
  'ps', 'pgrep', 'pidof', 'pstree', 'top', 'ss', 'netstat',
]);

/** Directories an absolute-path run may come from. `/tmp/evil/cat`
 * with a suitable basename does not get through this way. */
const ALLOWED_BIN_DIRS = [
  '/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/',
];

/**
 * Shell metacharacters. A newline is a command separator too — without it
 * the second line would not be checked at all (only the first token is).
 * Parentheses/braces close off substitution and subshells.
 */
const CONTROL_CHARS = /[><|&;`$(){}\n\r]/;
const CODE_EXECUTION = /\b(eval|source|system\s*\(|exec\s*\(|popen\s*\()/;

/**
 * Flags that turn an allowed utility into a writing or executing one.
 * Checked only against their own command: `-o` on `sort` writes a file,
 * while on `grep` it is the harmless `--only-matching`.
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
 * The runnable utility's name from the first token: strips quotes and
 * leading `\` (`\rm` bypasses aliases — the shell would run `rm`); for an
 * absolute path returns the basename, but only from system directories.
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
