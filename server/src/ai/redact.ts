import { aiStr } from './strings.js';
import type { PromptLang } from './prompts.js';

/**
 * Redaction of secrets on the "server → model → disk" path.
 *
 * The output of any agent tool immediately goes to three places: the model
 * context (i.e. over the network to the external provider), the UI and
 * `data/ai-dialogues.json`. Before this module there was no filter on that
 * path — private keys and passwords from `docker inspect`, `.env` and configs
 * landed in all three at once.
 *
 * The call site is a single one — `AgentSession.truncate()` (`ai/agent.ts`),
 * so redaction runs BEFORE truncation: a truncated PEM block can no longer
 * be recognized by its trailing `-----END` marker.
 *
 * The principle: better to redact too much than to miss. The variable/field
 * name is always kept — the model sees that a secret exists and can ask the
 * user to reveal the value via `exec` (with confirmation).
 */

/** A name fragment that makes the value a secret (`DB_PASSWORD`, `apiKey`). */
const SECRETISH_NAME_SRC =
  '[A-Za-z0-9_.\\-]*(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_.\\-]*';

/** `NAME=value`, `"NAME": "value"`, `NAME: value`. The separator is `=`/`:` only:
 * `PasswordAuthentication yes` in sshd_config (a space) stays readable. */
const ASSIGNMENT = new RegExp(
  `(${SECRETISH_NAME_SRC})(["']?\\s*[:=]\\s*)(["']?)([^\\s"',;}]+)`,
  'gi',
);

/** A complete private-key PEM block. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** A truncated PEM block (the file was read incompletely): everything after the header is the key. */
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/;

/** A password in a URL: `postgres://user:pass@host` — only the password is redacted. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:)([^\s:@/]+)(@)/gi;

/** Well-known token shapes — caught even without a telling name nearby. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
  /\bAIza[0-9A-Za-z_\-]{30,}/g,
  /\bey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]{16,}/g,
];

function marker(lang: PromptLang, hidden: string): string {
  return aiStr(lang, 'secretRedacted', { n: hidden.length });
}

/**
 * Redacts secrets from arbitrary text (tool output, file contents,
 * docker inspect JSON). Returns text of the same shape — with the marker
 * in place of the values.
 */
export function redactSecrets(text: string, lang: PromptLang = 'ru'): string {
  if (!text) return text;
  let out = text.replace(PEM_BLOCK, (m) => marker(lang, m));
  out = out.replace(PEM_OPEN, (m) => marker(lang, m));
  out = out.replace(URL_CREDENTIALS, (_m, head: string, pass: string, tail: string) =>
    `${head}${marker(lang, pass)}${tail}`,
  );
  out = out.replace(ASSIGNMENT, (_m, name: string, sep: string, quote: string, value: string) =>
    `${name}${sep}${quote}${marker(lang, value)}`,
  );
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (m) => marker(lang, m));
  }
  return out;
}

/**
 * Environment variables whose values are certainly not secret: they are
 * visible in any `docker inspect` and are genuinely needed for diagnostics.
 * Everything else in `Env` is hidden by name — guessing by value is
 * unreliable (`ADMIN=hunter2` is indistinguishable from `ADMIN=root`).
 */
const SAFE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'HOSTNAME', 'PWD', 'SHLVL', 'TERM', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TZ', 'NODE_ENV', 'ENV', 'DEBIAN_FRONTEND', 'container',
  'GOPATH', 'PYTHONUNBUFFERED', 'NPM_CONFIG_LOGLEVEL',
]);

const SAFE_ENV_PATTERN = /^(LC_[A-Z]+|[A-Z0-9_]*VERSION|[A-Z0-9_]*_HOME|[A-Z0-9_]*_PORT)$/;

function isSafeEnvName(name: string): boolean {
  return SAFE_ENV_NAMES.has(name) || SAFE_ENV_PATTERN.test(name);
}

/**
 * Structural redaction of `Env` in `docker inspect` output: the most reliable
 * source of foreign secrets on the server (the app's entire `.env` in one
 * piece). Variable names are kept — they show what the container has at all.
 * Recursive, because `Env` appears in `Config` and in `ContainerConfig` too.
 */
export function redactDockerEnv<T>(value: T, lang: PromptLang = 'ru'): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactDockerEnv(item, lang)) as unknown as T;
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'Env' && Array.isArray(raw)) {
      result[key] = raw.map((entry) => {
        if (typeof entry !== 'string') return entry;
        const eq = entry.indexOf('=');
        if (eq <= 0) return entry;
        const name = entry.slice(0, eq);
        const val = entry.slice(eq + 1);
        if (!val || isSafeEnvName(name)) return entry;
        return `${name}=${marker(lang, val)}`;
      });
      continue;
    }
    result[key] = redactDockerEnv(raw, lang);
  }
  return result as T;
}

/**
 * Files whose reading makes sense only for the sake of a secret. Such a
 * `read_file` (and `cat` via `exec_readonly`) stops being automatic and goes
 * to user confirmation: the redaction downstream is regex-based and gives no
 * full guarantee, and what was read would already be on its way to the
 * provider.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)($|[^A-Za-z0-9])/i,
  /\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$/i,
  /(^|\/)\.ssh\/(?!known_hosts|authorized_keys|config($|[^A-Za-z0-9]))/i,
  /(^|\/)(shadow|gshadow)$/i,
  /(^|\/)\.(pgpass|netrc|my\.cnf|git-credentials|npmrc|pypirc)$/i,
  /(^|\/)\.(aws|gnupg|docker)\//i,
  /(^|\/)(credentials|secrets?)(\.[A-Za-z0-9]+)?$/i,
];

/** Whether the path looks like a secrets file. */
export function isSensitivePath(path: string): boolean {
  const p = path.trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  // `.pub` — the public half of a key: not a secret in any directory,
  // including `.ssh/`, where everything else is gated.
  if (/\.pub$/i.test(p)) return false;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
}

/**
 * Command arguments that look like secret paths (`cat /root/.ssh/id_rsa`).
 * The first token — the command itself — is not checked.
 */
export function sensitivePathsIn(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter((t) => t && !t.startsWith('-') && isSensitivePath(t));
}
