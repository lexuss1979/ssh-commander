import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as ssh2 from 'ssh2';
import type { Client } from 'ssh2';
import { config } from '../config.js';
import { createProfile } from '../profiles.js';
import type { ExecResult, Profile } from '../types.js';
import { shq } from '../util/shell.js';
import { saveKey } from './keys.js';

// Именованный ESM-импорт `{ utils }` из CJS-пакета ssh2 не резолвится в
// чистом Node: cjs-module-lexer видит только часть имён, полный
// module.exports (с utils) доступен через default. Витестовский interop,
// наоборот, кладёт всё в namespace — поэтому fallback.
const ssh2Pkg = ((ssh2 as unknown as { default?: typeof ssh2 }).default ?? ssh2) as typeof ssh2;
const { Client: Ssh2Client, utils } = ssh2Pkg;

// Эпик «Новый сервер (root + пароль)» — план docs/bootstrap-plan.md.
// Сценарий: генерация отдельного ed25519-ключа → подключение по паролю →
// идемпотентная установка pubkey → верификация входа ключом отдельным
// подключением → (опционально) hardening sshd с reload только после зелёного
// `sshd -t` и контрольными проверками → создание профиля с authType=key.
// Пароль живёт только в памяти запроса: не persist'ится, не логируется и
// не попадает в сообщения об ошибках.

export interface BootstrapStep {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly steps: BootstrapStep[] = [],
  ) {
    super(message);
  }
}

export interface BootstrapInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  disablePasswordAuth: boolean;
}

export interface BootstrapResult {
  profile: Profile;
  steps: BootstrapStep[];
}

export interface BootstrapConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

/** Одно прямое SSH-подключение (профиля ещё нет, менеджер не нужен). */
export interface BootstrapSshSession {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  close(): void;
  readonly alive: boolean;
}

export interface BootstrapDeps {
  connect(options: BootstrapConnectOptions): Promise<BootstrapSshSession>;
  saveKeyFile(fileName: string, content: string): { name: string; path: string };
  createProfile(input: unknown): Profile;
}

// ---------------------------------------------------------------------------
// Генерация ключа: node:crypto ed25519 → OpenSSH-формат (ssh2 не читает PKCS#8)
// ---------------------------------------------------------------------------

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export function pubkeyBody(line: string): string {
  // `ssh-ed25519 <base64> <комментарий>` → `ssh-ed25519 <base64>`: комментарий
  // содержит имя профиля (пробелы, меняется при переименовании) — в сравнениях
  // идемпотентности не участвует.
  const parts = line.split(/\s+/);
  return parts.slice(0, 2).join(' ');
}

/**
 * Минимальный энкодер unencrypted OpenSSH private key (cipher/kdf = none,
 * паддинг 1..n до 8 байт — как ssh-keygen). Совместим и с ssh2, и с
 * `ssh-keygen -y`. Публичная часть — строка authorized_keys с комментарием
 * `ssh-commander@<имя профиля>` (видно, откуда ключ; точечный отзыв).
 */
export function generateKeyPair(profileName: string): {
  privateKeyPem: string;
  publicKeyLine: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  // SPKI/PKCS#8 DER для ed25519 — фиксированные заголовки + 32 байта payload.
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  if (pubRaw.length !== 32 || seed.length !== 32) {
    throw new Error('Неожиданный формат DER от node:crypto (ed25519)');
  }

  const type = Buffer.from('ssh-ed25519', 'utf8');
  const comment = `ssh-commander@${profileName}`;
  const pubBlob = Buffer.concat([sshString(type), sshString(pubRaw)]);
  // Приватная секция — поля ключа напрямую, без внешней ssh-строки-обёртки
  // (см. комментарий в ssh2 keyParser: «the entirety of the private key
  // content is not contained within a string field»).
  const seedWithPub = Buffer.concat([seed, pubRaw]); // OpenSSH хранит seed || public
  const check = crypto.randomBytes(4);
  let privSection = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pubRaw),
    sshString(seedWithPub),
    sshString(Buffer.from(comment, 'utf8')),
  ]);
  const padLen = (8 - (privSection.length % 8)) % 8;
  privSection = Buffer.concat([privSection, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))]);

  const nkeys = Buffer.alloc(4);
  nkeys.writeUInt32BE(1, 0);
  const openssh = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshString(Buffer.from('none', 'utf8')),
    sshString(Buffer.from('none', 'utf8')),
    sshString(Buffer.alloc(0)),
    nkeys,
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const b64 = openssh.toString('base64').replace(/(.{70})/g, '$1\n');
  const privateKeyPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const publicKeyLine = `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`;

  // Сгенерированный ключ обязан читаться самим ssh2 — иначе профиль станет
  // unusable; проверяем на месте, а не первым подключением к серверу.
  const parsed = utils.parseKey(privateKeyPem);
  if (parsed instanceof Error) {
    throw new Error(`Сгенерированный ключ не парсится ssh2: ${parsed.message}`);
  }
  return { privateKeyPem, publicKeyLine };
}

/** Имя файла ключа: санитизация как у memory/, коллизия — числовой суффикс. */
export function buildKeyFileName(existing: string[], profileName: string): string {
  const slug = profileName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const base = slug || 'server';
  if (!existing.includes(`${base}.ed25519`)) return `${base}.ed25519`;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}.ed25519`;
    if (!existing.includes(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Чистые билдеры команд и парсеры (unit-тесты)
// ---------------------------------------------------------------------------

export const SSHD_MAIN_CONFIG = '/etc/ssh/sshd_config';
export const SSHD_DROPIN_PATH = '/etc/ssh/sshd_config.d/00-ssh-commander.conf';
// Раннее имя drop-in: OpenSSH — «первое вхождение побеждает», Include стоит
// наверху sshd_config, поэтому 00- перекрывает cloud-init 50/60-*.conf с
// PasswordAuthentication yes (правка основного конфига в конце молча не
// перебьёт).
export const SSHD_RESOLVE = 'SSHD=$(command -v sshd || echo /usr/sbin/sshd)';
// reload не рвёт установленные сессии. Хвост цепочки — про sshd без
// systemd/service (docker-контейнер из ручного теста): SIGHUP старейшему sshd,
// это master (слушает с самой загрузки); на VPS сработает systemctl/service.
export const SSHD_RELOAD_CMD =
  'systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || ' +
  'service ssh reload >/dev/null 2>&1 || service sshd reload >/dev/null 2>&1 || ' +
  'kill -HUP "$(pgrep -x sshd | sort -n | head -1)"';

/** Установка ключа идемпотентна: grep -F по телу ключа без комментария. */
export function buildInstallKeyCommand(pubkeyBodyWithoutComment: string, pubkeyLine: string): string {
  return [
    'umask 077',
    'mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
    `if grep -F -- ${shq(pubkeyBodyWithoutComment)} ~/.ssh/authorized_keys >/dev/null 2>&1; then echo present; ` +
      `else printf '%s\\n' ${shq(pubkeyLine)} >> ~/.ssh/authorized_keys && echo added; fi`,
    // SELinux-страховка (RHEL): контекст authorized_keys после правки папки.
    'command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh; true',
  ].join('; ');
}

/** Best-effort удаление строки ключа (чистка после провала до создания профиля). */
export function buildRemoveKeyCommand(pubkeyBodyWithoutComment: string): string {
  return [
    `grep -Fv -- ${shq(pubkeyBodyWithoutComment)} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.sc-tmp`,
    'rc=$?',
    'if [ "$rc" -le 1 ]; then mv ~/.ssh/authorized_keys.sc-tmp ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; ' +
      'else rm -f ~/.ssh/authorized_keys.sc-tmp; fi',
  ].join('; ');
}

export function buildMatchDetectCommand(): string {
  return `grep -Eiq ${shq('^[[:space:]]*Match')} ${shq(SSHD_MAIN_CONFIG)} && echo yes || echo no`;
}

/**
 * Эффективный конфиг. При наличии Match-блоков — с -C (иначе -T показывает
 * только глобальную секцию, а Match может перекрывать директивы для юзера).
 */
export function buildSshdTCommand(withConnectionSpec: boolean, username: string): string {
  const spec = withConnectionSpec ? ` -C user=${shq(username)},host=localhost,addr=127.0.0.1` : '';
  return `${SSHD_RESOLVE}; "$SSHD" -T${spec}`;
}

export function buildSshdTestCommand(): string {
  return `${SSHD_RESOLVE}; "$SSHD" -t`;
}

export function buildDropinSupportCommand(): string {
  const includeRe = '^[[:space:]]*Include[[:space:]]+[^#]*sshd_config[.]d';
  return (
    `if grep -Eiq ${shq(includeRe)} ${shq(SSHD_MAIN_CONFIG)} && [ -d /etc/ssh/sshd_config.d ]; ` +
    'then echo yes; else echo no; fi'
  );
}

export function buildDropinContent(directives: string[]): string[] {
  return ['# Managed by ssh-commander: password SSH login disabled', ...directives.map((d) => `${d} no`)];
}

export function buildDropinWriteCommand(directives: string[]): string {
  const lines = buildDropinContent(directives).map(shq).join(' ');
  return `umask 022; mkdir -p /etc/ssh/sshd_config.d; printf '%s\\n' ${lines} > ${shq(SSHD_DROPIN_PATH)}`;
}

export function buildBackupConfigCommand(ts: number): string {
  return `cp ${shq(SSHD_MAIN_CONFIG)} ${shq(`${SSHD_MAIN_CONFIG}.bak-ssh-commander-${ts}`)}`;
}

export function buildReadConfigCommand(): string {
  return `cat ${shq(SSHD_MAIN_CONFIG)}`;
}

/** Точная побайтовая запись (printf %s — без добавления переводов строк). */
export function buildWriteConfigCommand(content: string): string {
  return `printf '%s' ${shq(content)} > ${shq(SSHD_MAIN_CONFIG)}`;
}

export function buildRollbackDropinCommand(): string {
  return `rm -f ${shq(SSHD_DROPIN_PATH)}; ${SSHD_RELOAD_CMD}`;
}

export function buildRollbackRestoreCommand(backupPath: string): string {
  return `cp ${shq(backupPath)} ${shq(SSHD_MAIN_CONFIG)}; ${SSHD_RELOAD_CMD}`;
}

/** Разбор вывода `sshd -T`: строки `directive value` → карта в нижнем регистре. */
export function parseSshdT(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const raw of output.split('\n')) {
    const m = /^([a-z0-9]+)[ \t]+(.+)$/.exec(raw.trim().toLowerCase());
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/**
 * Какие директивы отключения пароля понимает этот sshd — по выводу sshd -T
 * на НЕмодифицированном конфиге (заодно baseline: конфиг валиден до правок).
 * До OpenSSH 8.7 нет KbdInteractiveAuthentication (там
 * ChallengeResponseAuthentication), а неизвестная директива валит sshd -t.
 */
export function detectSupportedDirectives(parsed: Record<string, string>): string[] {
  const out: string[] = [];
  if ('passwordauthentication' in parsed) out.push('PasswordAuthentication');
  if ('kbdinteractiveauthentication' in parsed) {
    out.push('KbdInteractiveAuthentication');
  } else if ('challengeresponseauthentication' in parsed) {
    out.push('ChallengeResponseAuthentication');
  }
  return out;
}

/** Директивы, чьё эффективное значение не стало `no` (проверка по факту). */
export function failedEffectiveDirectives(parsed: Record<string, string>, directives: string[]): string[] {
  return directives.filter((d) => parsed[d.toLowerCase()] !== 'no');
}

/**
 * Fallback без sshd_config.d/Include: активные директивы заменяются на месте
 * («первое вхождение побеждает» — замена в конце могла бы проиграть активной
 * строке выше), отсутствующие вставляются до первого Match (директивы
 * глобального контекста внутри Match невалидны) либо в конец файла.
 */
export function rewriteSshdConfig(content: string, directives: string[]): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const seen = new Map(directives.map((d) => [d.toLowerCase(), false]));
  for (let i = 0; i < lines.length; i++) {
    // только top-level директивы (без отступа): строка с отступом внутри
    // Match-блока — другой контекст, глобальную директиву не заменяет
    const m = /^([A-Za-z]+)(\s+)(.*?)\s*$/.exec(lines[i]);
    if (m && seen.has(m[1].toLowerCase())) {
      lines[i] = `${m[1]} no`;
      seen.set(m[1].toLowerCase(), true);
    }
  }
  const missing = directives.filter((d) => !seen.get(d.toLowerCase()));
  if (missing.length) {
    const block = ['# ssh-commander: password SSH login disabled', ...missing.map((d) => `${d} no`)];
    const firstMatch = lines.findIndex((l) => /^\s*Match\b/i.test(l));
    if (firstMatch === -1) {
      let insertAt = lines.length;
      while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, ...block);
    } else {
      lines.splice(firstMatch, 0, ...block);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Маппинг ошибок подключения (пароль в сообщения не подставляется)
// ---------------------------------------------------------------------------

export function mapConnectError(
  err: Error & { code?: string },
  ctx: { host: string; port: number; username: string },
  phase: 'password' | 'key',
): Error {
  const where = `${ctx.host}:${ctx.port}`;
  if (err.code === 'ECONNREFUSED') return new Error(`Подключение к ${where}: порт недоступен (connection refused)`);
  if (err.code === 'ENOTFOUND') return new Error(`Хост ${ctx.host} не разрешается (DNS)`);
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return new Error(`Хост ${ctx.host} недоступен`);
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) {
    return new Error(`Таймаут подключения к ${where} (30 c)`);
  }
  if (/all configured authentication methods failed/i.test(err.message)) {
    return phase === 'password'
      ? new Error(
          `Аутентификация по паролю не удалась: неверный пароль, либо парольный вход для пользователя ` +
            `${ctx.username} запрещён на сервере (например, PermitRootLogin prohibit-password)`,
        )
      : new Error('Вход по сгенерированному ключу не удался: сервер не принял ключ');
  }
  return new Error(`Подключение к ${where} не удалось: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Продакшн-подключения: прямые ssh2-клиенты, timeout 30 c, close в finally
// ---------------------------------------------------------------------------

function execOnClient(client: Client, command: string, timeoutMs = 60000): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) {
        reject(new Error(`SSH exec error: ${err.message}`));
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      let code: number | null = null;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          channel.close();
        } catch {
          /* noop */
        }
        if (error) reject(error);
        else resolve({ code, stdout, stderr });
      };
      const timer = setTimeout(() => finish(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
      channel.on('data', (d: Buffer) => {
        if (stdout.length < 1024 * 1024) stdout += d.toString();
      });
      channel.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 1024 * 1024) stderr += d.toString();
      });
      channel.on('close', (exitCode: number | null) => {
        code = exitCode;
        finish();
      });
      channel.on('error', (e: Error) => finish(e));
    });
  });
}

export function connectSsh(options: BootstrapConnectOptions): Promise<BootstrapSshSession> {
  return new Promise((resolve, reject) => {
    const client = new Ssh2Client();
    const state = { alive: true };
    const session: BootstrapSshSession = {
      get alive() {
        return state.alive;
      },
      exec: (command, opts = {}) => execOnClient(client, command, opts.timeoutMs),
      close: () => {
        try {
          client.end();
        } catch {
          /* noop */
        }
      },
    };
    client.on('close', () => {
      state.alive = false;
    });
    client.once('ready', () => resolve(session));
    // on, а не once: слушатель живёт и после ready — поздняя ошибка сети
    // помечает сессию мёртвой (reject на resolved-промисе — no-op), а второй
    // error-эвент без слушателя ронял бы процесс.
    client.on('error', (err) => {
      state.alive = false;
      try {
        client.end();
      } catch {
        /* noop */
      }
      reject(err);
    });
    try {
      client.connect({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        privateKey: options.privateKey,
        readyTimeout: 30000,
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}

function listKeyFileNames(): string[] {
  try {
    return fs.readdirSync(config.keysDir).filter((name) => {
      try {
        return fs.statSync(path.join(config.keysDir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function defaultDeps(): BootstrapDeps {
  return {
    connect: (options) => connectSsh(options),
    saveKeyFile: (fileName, content) => saveKey(config.keysDir, fileName, content, false),
    createProfile: (input) => createProfile(input),
  };
}

// ---------------------------------------------------------------------------
// Оркестрация
// ---------------------------------------------------------------------------

function formatOutput(r: ExecResult, limit = 2000): string {
  const text = `${r.stdout}${r.stderr}`.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function bootstrapServer(
  input: BootstrapInput,
  deps: BootstrapDeps = defaultDeps(),
): Promise<BootstrapResult> {
  if (input.disablePasswordAuth && input.username !== 'root') {
    throw new BootstrapError(
      'Запрет парольного входа SSH доступен только для пользователя root (hardening требует прав на правку sshd_config)',
      400,
    );
  }

  const steps: BootstrapStep[] = [];
  const ok = (name: string, detail = '') => steps.push({ name, status: 'ok', detail });
  const warn = (name: string, detail: string) => steps.push({ name, status: 'warn', detail });
  const fail = (name: string, detail: string) => steps.push({ name, status: 'error', detail });

  const keyPair = generateKeyPair(input.name);
  const privateKeyPem = keyPair.privateKeyPem;
  const body = pubkeyBody(keyPair.publicKeyLine);
  ok('Генерация ключа ed25519', `отдельная пара для этого сервера, комментарий ssh-commander@${input.name}`);

  let passwordSession: BootstrapSshSession | null = null;
  let keySession: BootstrapSshSession | null = null; // живёт до конца — откат через key-сессию
  let keyFilePath: string | null = null;
  let keepKeyFile = false; // кейс «hardening ок, а профиль не создался» — ключ сохраняем

  const connectOrThrow = async (
    phase: 'password' | 'key',
    stepName: string,
  ): Promise<BootstrapSshSession> => {
    try {
      return await deps.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: phase === 'password' ? input.password : undefined,
        privateKey: phase === 'key' ? privateKeyPem : undefined,
      });
    } catch (err) {
      const mapped = mapConnectError(err as Error & { code?: string }, input, phase);
      fail(stepName, mapped.message);
      throw new BootstrapError(mapped.message, 400, steps);
    }
  };

  // Живая password-сессия переживает reload; если оборвалась — откат через
  // key-сессию (вход ключом верифицирован до hardening, hardening его не закрывает).
  const execViaExistingSessions = async (command: string): Promise<ExecResult | null> => {
    if (passwordSession?.alive) {
      try {
        return await passwordSession.exec(command);
      } catch {
        /* сессия умерла — следующий кандидат */
      }
    }
    if (keySession?.alive) {
      try {
        return await keySession.exec(command);
      } catch {
        /* живых сессий нет */
      }
    }
    return null;
  };

  const execViaAliveSession = async (command: string, connectStepName: string): Promise<ExecResult> => {
    const existing = await execViaExistingSessions(command);
    if (existing) return existing;
    // Для отката оправдано свежее подключение ключом; для best-effort чистки —
    // нет (шумный error-шаг, когда ключ и не устанавливался).
    const fresh = await connectOrThrow('key', connectStepName);
    try {
      return await fresh.exec(command);
    } finally {
      fresh.close();
    }
  };

  const rollbackHardening = async (mode: 'dropin' | 'fallback', backupPath: string | null): Promise<void> => {
    const command = mode === 'dropin' ? buildRollbackDropinCommand() : buildRollbackRestoreCommand(backupPath!);
    try {
      const r = await execViaAliveSession(command, 'Откат изменений sshd');
      steps.push({
        name: 'Откат изменений sshd',
        status: r.code === 0 ? 'warn' : 'error',
        detail:
          r.code === 0
            ? mode === 'dropin'
              ? 'drop-in удалён, reload выполнен — конфигурация возвращена'
              : 'конфиг восстановлен из бэкапа, reload выполнен'
            : `откат не завершился (exit ${r.code}): ${formatOutput(r)} — проверьте конфигурацию sshd вручную`,
      });
    } catch (err) {
      steps.push({
        name: 'Откат изменений sshd',
        status: 'error',
        detail: `откат не выполнен: ${(err as Error).message} — восстановите конфигурацию sshd вручную`,
      });
    }
  };

  try {
    passwordSession = await connectOrThrow('password', 'Подключение по паролю');
    ok('Подключение по паролю', `SSH-сессия установлена (${input.host}:${input.port}, ${input.username})`);

    const fileName = buildKeyFileName(listKeyFileNames(), input.name);
    const saved = deps.saveKeyFile(fileName, keyPair.privateKeyPem);
    keyFilePath = saved.path;
    ok('Сохранение ключа', `${saved.path} (права 0600)`);

    const install = await passwordSession.exec(buildInstallKeyCommand(body, keyPair.publicKeyLine));
    if (install.code !== 0) {
      fail('Установка ключа на сервере', formatOutput(install));
      throw new BootstrapError(
        `Не удалось прописать ключ в ~/.ssh/authorized_keys на сервере: ${formatOutput(install)}`,
        500,
        steps,
      );
    }
    ok(
      'Установка ключа на сервере',
      install.stdout.includes('present')
        ? 'ключ уже был в ~/.ssh/authorized_keys (идемпотентно, дубль не создан)'
        : 'строка добавлена в ~/.ssh/authorized_keys',
    );

    keySession = await connectOrThrow('key', 'Проверка входа по ключу');
    ok('Проверка входа по ключу', 'отдельное новое подключение с новым ключом прошло');

    if (input.disablePasswordAuth) {
      // --- анализ на немодифицированном конфиге ----------------------------
      const matchDetect = await passwordSession.exec(buildMatchDetectCommand());
      const hasMatch = matchDetect.stdout.trim() === 'yes';
      const sshdT = buildSshdTCommand(hasMatch, input.username);
      const baseline = await passwordSession.exec(sshdT);
      if (baseline.code !== 0) {
        fail('Анализ конфигурации sshd', `sshd -T упал ещё до наших правок:\n${formatOutput(baseline)}`);
        throw new BootstrapError(
          'Конфигурация sshd на сервере невалидна ещё до изменений (sshd -T) — bootstrap прерван до любых правок',
          400,
          steps,
        );
      }
      const directives = detectSupportedDirectives(parseSshdT(baseline.stdout));
      if (directives.length === 0) {
        fail('Анализ конфигурации sshd', 'sshd -T не сообщил ни одной директивы парольного входа');
        throw new BootstrapError(
          'Не удалось определить поддерживаемые директивы парольного входа (вывод sshd -T неожиданный) — правки не выполнялись',
          500,
          steps,
        );
      }
      ok(
        'Анализ конфигурации sshd',
        `отключаем: ${directives.join(', ')}; Match-блоки: ${hasMatch ? 'есть (sshd -T с -C)' : 'нет'}`,
      );

      // --- применение: drop-in приоритетно, fallback — правка основного ----
      const dropinSupport = await passwordSession.exec(buildDropinSupportCommand());
      const useDropin = dropinSupport.stdout.trim() === 'yes';
      const applyFailure = (detail: string, message: string): BootstrapError => {
        fail('Отключение парольного входа', detail);
        return new BootstrapError(message, 500, steps);
      };
      let hardeningMode: 'dropin' | 'fallback';
      let backupPath: string | null = null;
      if (useDropin) {
        const w = await passwordSession.exec(buildDropinWriteCommand(directives));
        if (w.code !== 0) {
          throw applyFailure(
            `не удалось записать ${SSHD_DROPIN_PATH}: ${formatOutput(w)}`,
            `Не удалось записать drop-in ${SSHD_DROPIN_PATH}: ${formatOutput(w)}`,
          );
        }
        hardeningMode = 'dropin';
        ok('Отключение парольного входа', `drop-in ${SSHD_DROPIN_PATH}: ${directives.map((d) => `${d} no`).join(', ')}`);
      } else {
        const ts = Date.now();
        backupPath = `${SSHD_MAIN_CONFIG}.bak-ssh-commander-${ts}`;
        const backup = await passwordSession.exec(buildBackupConfigCommand(ts));
        if (backup.code !== 0) {
          throw applyFailure(
            `не удалось сделать бэкап ${backupPath}: ${formatOutput(backup)}`,
            `Не удалось сделать бэкап ${backupPath}: ${formatOutput(backup)}`,
          );
        }
        const read = await passwordSession.exec(buildReadConfigCommand());
        if (read.code !== 0) {
          throw applyFailure(
            `не удалось прочитать ${SSHD_MAIN_CONFIG}: ${formatOutput(read)}`,
            `Не удалось прочитать ${SSHD_MAIN_CONFIG}: ${formatOutput(read)}`,
          );
        }
        const rewritten = rewriteSshdConfig(read.stdout, directives);
        const w = await passwordSession.exec(buildWriteConfigCommand(rewritten));
        if (w.code !== 0) {
          throw applyFailure(
            `не удалось записать ${SSHD_MAIN_CONFIG}: ${formatOutput(w)}`,
            `Не удалось записать ${SSHD_MAIN_CONFIG}: ${formatOutput(w)}`,
          );
        }
        hardeningMode = 'fallback';
        ok(
          'Отключение парольного входа',
          `правка ${SSHD_MAIN_CONFIG} (${directives.map((d) => `${d} no`).join(', ')}); бэкап: ${backupPath}`,
        );
      }

      // --- всё после первой правки конфига: любой провал (красный sshd -t,
      // отказ reload, оборвавшаяся сессия, не применившийся эффективный
      // конфиг, отвалившийся контрольный вход ключом) → откат и ошибка наверх.
      try {
        const test = await passwordSession.exec(buildSshdTestCommand());
        if (test.code !== 0) {
          fail('Проверка конфигурации (sshd -t)', formatOutput(test));
          throw new BootstrapError(
            `sshd -t отверг конфигурацию после правок — изменения отменены (откат). Вывод sshd -t:\n${formatOutput(test)}`,
            409,
            steps,
          );
        }
        ok('Проверка конфигурации (sshd -t)', 'конфигурация валидна');

        const reload = await passwordSession.exec(SSHD_RELOAD_CMD);
        if (reload.code !== 0) {
          fail('Перезагрузка sshd', `reload не сработал: ${formatOutput(reload)}`);
          throw new BootstrapError(
            'Не удалось перезагрузить sshd (systemctl/service reload) — изменения отменены (откат)',
            500,
            steps,
          );
        }
        ok('Перезагрузка sshd', 'reload выполнен; установленные сессии не рвутся');

        // --- контрольные проверки по факту, не на слово --------------------
        const effective = await passwordSession.exec(sshdT);
        if (effective.code !== 0) {
          fail('Контрольная проверка конфигурации', `sshd -T упал после правок:\n${formatOutput(effective)}`);
          throw new BootstrapError(
            `sshd -T упал после правок — изменения отменены (откат):\n${formatOutput(effective)}`,
            500,
            steps,
          );
        }
        const effectiveMap = parseSshdT(effective.stdout);
        const failed = failedEffectiveDirectives(effectiveMap, directives);
        if (failed.length) {
          const observed = failed.map((d) => `${d}=${effectiveMap[d.toLowerCase()]}`).join(', ');
          fail('Контрольная проверка конфигурации', `эффективные значения не применились: ${observed}`);
          throw new BootstrapError(
            `Hardening не применился (${observed}) — вероятно, конфиг перекрыт Match-блоком; изменения отменены (откат)`,
            500,
            steps,
          );
        }
        ok('Контрольная проверка конфигурации', `эффективно: ${directives.map((d) => `${d} no`).join(', ')}`);

        const keyCheck = await connectOrThrow('key', 'Контрольный вход по ключу');
        keyCheck.close();
        ok('Контрольный вход по ключу', 'вход по ключу работает после reload');
      } catch (err) {
        await rollbackHardening(hardeningMode, backupPath);
        if (err instanceof BootstrapError) throw err;
        fail('Неожиданная ошибка на этапе hardening', (err as Error).message);
        throw new BootstrapError(
          `Bootstrap прерван после правки sshd (${(err as Error).message}) — изменения отменены (откат)`,
          500,
          steps,
        );
      }

      try {
        const pwCheck = await deps.connect({
          host: input.host,
          port: input.port,
          username: input.username,
          password: input.password,
        });
        pwCheck.close();
        warn(
          'Контроль: парольный вход',
          'пароль по-прежнему пускает — sshd мог не перечитать конфиг; проверьте вручную (reload/перезапуск sshd)',
        );
      } catch (err) {
        if (/all configured authentication methods failed/i.test((err as Error).message)) {
          ok('Контроль: парольный вход', 'пароль больше не принимается');
        } else {
          warn('Контроль: парольный вход', `не удалось проверить: ${(err as Error).message}`);
        }
      }
    }

    let profile: Profile;
    try {
      profile = deps.createProfile({
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authType: 'key',
        keyPath: keyFilePath!,
        dockerCommand: 'docker',
      });
    } catch (err) {
      // Состояние консистентно: сервер захарден, ключ на диске. Откат hardening
      // в этой точке не делаем — восстановимо руками (профиль с этим ключом).
      keepKeyFile = true;
      fail('Создание профиля', (err as Error).message);
      throw new BootstrapError(
        `Сервер настроен, но профиль не создан: ${(err as Error).message}. Ключ сохранён: ${keyFilePath} — ` +
          'добавьте профиль вручную с этим ключом (authType=key).',
        500,
        steps,
      );
    }
    ok('Создание профиля', `профиль «${input.name}»: вход по ключу ${keyFilePath}`);
    return { profile, steps };
  } catch (err) {
    // Провал до создания профиля: удалить локальный файл ключа; строку pubkey
    // убрать из authorized_keys best-effort через живую сессию. Исключение —
    // кейс createProfile (keepKeyFile): ключ и строку оставляем.
    if (!keepKeyFile) {
      // best-effort и только через живые сессии: чистка не должна шуметь
      // ошибками подключения, когда ключ и не устанавливался
      await execViaExistingSessions(buildRemoveKeyCommand(body));
      if (keyFilePath) {
        try {
          fs.unlinkSync(keyFilePath);
        } catch {
          /* мог не создаться */
        }
      }
    }
    if (err instanceof BootstrapError) throw err;
    fail('Неожиданная ошибка', (err as Error).message);
    throw new BootstrapError(`Bootstrap упал с неожиданной ошибкой: ${(err as Error).message}`, 500, steps);
  } finally {
    passwordSession?.close();
    keySession?.close();
  }
}
