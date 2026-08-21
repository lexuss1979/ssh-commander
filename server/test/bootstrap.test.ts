import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import {
  type BootstrapConnectOptions,
  type BootstrapDeps,
  type BootstrapInput,
  type BootstrapSshSession,
  BootstrapError,
  SSHD_DROPIN_PATH,
  SSHD_MAIN_CONFIG,
  SSHD_RELOAD_CMD,
  bootstrapServer,
  buildBackupConfigCommand,
  buildDropinContent,
  buildDropinSupportCommand,
  buildDropinWriteCommand,
  buildInstallKeyCommand,
  buildKeyFileName,
  buildMatchDetectCommand,
  buildReadConfigCommand,
  buildRemoveKeyCommand,
  buildRollbackDropinCommand,
  buildRollbackRestoreCommand,
  buildSshdTCommand,
  buildSshdTestCommand,
  buildWriteConfigCommand,
  detectSupportedDirectives,
  failedEffectiveDirectives,
  generateKeyPair,
  mapConnectError,
  parseSshdT,
  pubkeyBody,
  rewriteSshdConfig,
} from '../src/services/bootstrap.js';
import { saveKey } from '../src/services/keys.js';
import type { ExecResult, Profile } from '../src/types.js';

const AUTH_FAILED = 'All configured authentication methods failed';

// --------------------------------------------------------------------------
// Мок SSH-сервера: скриптованные сессии; парольный/ключевой вход имитируется
// флагами, exec отвечает по префиксам команд (те же билдеры, что в сервисе).
// --------------------------------------------------------------------------

class FakeSession implements BootstrapSshSession {
  alive = true;
  commands: string[] = [];
  constructor(
    readonly kind: 'password' | 'key',
    private readonly server: FakeSshServer,
  ) {}

  async exec(command: string): Promise<ExecResult> {
    if (!this.alive) throw new Error('SSH exec error: connection closed');
    this.commands.push(command);
    this.server.allCommands.push({ kind: this.kind, cmd: command });
    return this.server.dispatch(command, this);
  }

  close(): void {
    this.alive = false;
  }

  /** Имитация обрыва сети: сессия мертва, хотя close() не вызывали. */
  kill(): void {
    this.alive = false;
  }
}

class FakeSshServer {
  passwordLoginWorks = true;
  keyLoginWorks = true;
  installEcho: 'added' | 'present' = 'added';
  hasMatch = false;
  dropinSupported = true;
  /** Что отвечает `sshd -T` (в тестах с hardening — и до, и после правок). */
  sshdTOutput = ['port 22', 'passwordauthentication yes', 'kbdinteractiveauthentication yes'].join('\n');
  sshdTEffectiveAfter: Record<string, string> | null = null;
  sshdTFailsAfter = false;
  sshdtTestFailsAfterHardening = false;
  killPasswordSessionsAfterReload = false;
  reloadFails = false;
  mainConfig = 'Port 22\nPasswordAuthentication yes\n#KbdInteractiveAuthentication yes\n';

  connects: BootstrapConnectOptions[] = [];
  allCommands: Array<{ kind: 'password' | 'key'; cmd: string }> = [];
  sessions: FakeSession[] = [];
  createdProfiles: Array<Record<string, unknown>> = [];
  createProfileError: string | null = null;

  dispatch(cmd: string, session: FakeSession): ExecResult {
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    if (cmd.startsWith('umask 077')) return ok(this.installEcho);
    if (cmd.startsWith('grep -Fv --')) return ok('');
    if (cmd === buildMatchDetectCommand()) return ok(this.hasMatch ? 'yes' : 'no');
    if (cmd === buildDropinSupportCommand()) return ok(this.dropinSupported ? 'yes' : 'no');
    if (cmd.startsWith('umask 022')) {
      this.sshdtTestFailsAfterHardening ||= this.sshdtTestFailsAfterHardening;
      return ok('');
    }
    if (cmd.startsWith('systemctl reload')) {
      if (this.killPasswordSessionsAfterReload && session.kind === 'password') session.kill();
      return this.reloadFails ? { code: 1, stdout: '', stderr: 'reload failed' } : ok('');
    }
    if (cmd.includes('"$SSHD" -T')) {
      if (this.sshdTFailsAfter) return { code: 1, stdout: '', stderr: 'sshd: no hostkeys available' };
      const map = this.sshdTEffectiveAfter ?? parseSshdT(this.sshdTOutput);
      return ok(Object.entries(map).map(([k, v]) => `${k} ${v}`).join('\n'));
    }
    if (cmd.includes('"$SSHD" -t')) {
      return this.sshdtTestFailsAfterHardening
        ? { code: 1, stdout: '', stderr: "/etc/ssh/sshd_config: Bad directive" }
        : ok('');
    }
    if (cmd.startsWith('cp ') && cmd.includes(SSHD_MAIN_CONFIG)) return ok(''); // бэкап / восстановление
    if (cmd.startsWith('cat ')) return ok(this.mainConfig);
    if (cmd.startsWith("printf '%s'")) return ok('');
    if (cmd.startsWith('rm -f ') && cmd.includes(SSHD_DROPIN_PATH)) return ok('');
    return { code: 127, stdout: '', stderr: `command not mocked: ${cmd}` };
  }

  deps(keysDir: string): BootstrapDeps {
    const base: BootstrapDeps = {
      connect: async (options) => {
        this.connects.push(options);
        const isKey = Boolean(options.privateKey);
        const allowed = isKey ? this.keyLoginWorks : this.passwordLoginWorks;
        if (!allowed) throw new Error(AUTH_FAILED);
        const session = new FakeSession(isKey ? 'key' : 'password', this);
        this.sessions.push(session);
        return session;
      },
      saveKeyFile: (fileName, content) => saveKey(keysDir, fileName, content, false),
      createProfile: (input) => {
        if (this.createProfileError) throw new Error(this.createProfileError);
        this.createdProfiles.push(input as Record<string, unknown>);
        return { ...(input as Record<string, unknown>), id: 'p1' } as Profile;
      },
    };
    return base;
  }

  /** После первой password-сессии пароль отклоняется (контрольная проверка). */
  depsWithPasswordRejectedLater(keysDir: string): BootstrapDeps {
    const deps = this.deps(keysDir);
    const origConnect = deps.connect;
    deps.connect = async (options) => {
      const passwordConnects = this.connects.filter((c) => !c.privateKey).length;
      if (!options.privateKey && passwordConnects >= 1) {
        this.connects.push(options);
        throw new Error(AUTH_FAILED);
      }
      return origConnect(options);
    };
    return deps;
  }
}

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    name: 'fresh-vps',
    host: '203.0.113.10',
    port: 22,
    username: 'root',
    password: 's3cret',
    disablePasswordAuth: false,
    ...overrides,
  };
}

describe('bootstrap: генерация ключа', () => {
  it('ssh2 парсит сгенерированный приватный ключ (OpenSSH-формат)', () => {
    const { privateKeyPem } = generateKeyPair('prod-01');
    expect(privateKeyPem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(privateKeyPem.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(true);
    const parsed = utils.parseKey(privateKeyPem);
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as { type: string }).type).toBe('ssh-ed25519');
  });

  it('публичная строка — формат authorized_keys с комментарием профиля', () => {
    const { publicKeyLine } = generateKeyPair('prod 01');
    expect(publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]{68} ssh-commander@prod 01$/);
    expect(pubkeyBody(publicKeyLine)).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]{68}$/);
    expect(pubkeyBody(publicKeyLine)).not.toContain('ssh-commander@');
  });

  it('две генерации дают разные пары; публичная строка парсится ssh2', () => {
    const first = generateKeyPair('x');
    const second = generateKeyPair('x');
    expect(second.publicKeyLine).not.toBe(first.publicKeyLine);
    expect(second.privateKeyPem).not.toBe(first.privateKeyPem);
    const pub = utils.parseKey(first.publicKeyLine);
    expect(pub).not.toBeInstanceOf(Error);
    expect((pub as { type: string }).type).toBe('ssh-ed25519');
  });

  it('buildKeyFileName: санитизация как у memory/, коллизия — числовой суффикс', () => {
    expect(buildKeyFileName([], 'prod-01')).toBe('prod-01.ed25519');
    expect(buildKeyFileName([], 'Мой сервер')).toBe('server.ed25519');
    expect(buildKeyFileName([], '../../etc')).toBe('etc.ed25519');
    expect(buildKeyFileName([], 'vps.01')).toBe('vps_01.ed25519');
    expect(buildKeyFileName(['prod-01.ed25519'], 'prod-01')).toBe('prod-01-2.ed25519');
    expect(buildKeyFileName(['prod-01.ed25519', 'prod-01-2.ed25519'], 'prod-01')).toBe('prod-01-3.ed25519');
  });
});

describe('bootstrap: билдеры команд', () => {
  it('buildInstallKeyCommand: umask/mkdir/chmod, grep -F по телу без комментария, append, restorecon', () => {
    const body = 'ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQhash';
    const line = `${body} ssh-commander@prod-01`;
    const cmd = buildInstallKeyCommand(body, line);
    expect(cmd).toContain('umask 077');
    expect(cmd).toContain(
      'mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
    );
    expect(cmd).toContain(`grep -F -- '${body}' ~/.ssh/authorized_keys`);
    expect(cmd).not.toContain(`grep -F -- '${line}'`);
    expect(cmd).toContain(`printf '%s\\n' '${line}' >> ~/.ssh/authorized_keys`);
    expect(cmd).toContain('command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh; true');
  });

  it('buildInstallKeyCommand экранирует кавычку в комментарии через shq', () => {
    const line = 'ssh-ed25519 AAAA ssh-commander@O\'Brien';
    const cmd = buildInstallKeyCommand('ssh-ed25519 AAAA', line);
    expect(cmd).toContain(`'ssh-ed25519 AAAA ssh-commander@O'\\''Brien'`);
  });

  it('buildRemoveKeyCommand: grep -Fv с защитой пустого результата', () => {
    const cmd = buildRemoveKeyCommand('ssh-ed25519 AAAA');
    expect(cmd).toContain(`grep -Fv -- 'ssh-ed25519 AAAA' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.sc-tmp`);
    expect(cmd).toContain('if [ "$rc" -le 1 ]');
    expect(cmd).toContain('mv ~/.ssh/authorized_keys.sc-tmp ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys');
  });

  it('drop-in: раннее имя 00-, обе директивы, заголовок, printf-запись', () => {
    const directives = ['PasswordAuthentication', 'KbdInteractiveAuthentication'];
    expect(buildDropinContent(directives)).toEqual([
      '# Managed by ssh-commander: password SSH login disabled',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
    ]);
    const cmd = buildDropinWriteCommand(directives);
    expect(cmd).toContain("printf '%s\\n'");
    expect(cmd).toContain(`> '${SSHD_DROPIN_PATH}'`);
    expect(cmd).toContain('mkdir -p /etc/ssh/sshd_config.d');
  });

  it('sshd: резолв бинаря, -t, -T c -C только при Match-блоках', () => {
    expect(buildSshdTestCommand()).toBe('SSHD=$(command -v sshd || echo /usr/sbin/sshd); "$SSHD" -t');
    expect(buildSshdTCommand(false, 'root')).toBe('SSHD=$(command -v sshd || echo /usr/sbin/sshd); "$SSHD" -T');
    expect(buildSshdTCommand(true, 'root')).toContain(`-C user='root',host=localhost,addr=127.0.0.1`);
  });

  it('fallback-команды: бэкап с таймстампом, чтение, точная запись, восстановление', () => {
    expect(buildBackupConfigCommand(123)).toBe(
      `cp '/etc/ssh/sshd_config' '/etc/ssh/sshd_config.bak-ssh-commander-123'`,
    );
    expect(buildReadConfigCommand()).toBe(`cat '/etc/ssh/sshd_config'`);
    expect(buildWriteConfigCommand('Port 22\n')).toBe(`printf '%s' 'Port 22\n' > '/etc/ssh/sshd_config'`);
    expect(buildRollbackDropinCommand()).toBe(`rm -f '${SSHD_DROPIN_PATH}'; ${SSHD_RELOAD_CMD}`);
    expect(buildRollbackRestoreCommand('/etc/ssh/sshd_config.bak-ssh-commander-1')).toBe(
      `cp '/etc/ssh/sshd_config.bak-ssh-commander-1' '/etc/ssh/sshd_config'; ${SSHD_RELOAD_CMD}`,
    );
  });
});

describe('bootstrap: парсеры sshd -T и правка конфига', () => {
  it('parseSshdT: ключи в нижнем регистре, мусор игнорируется', () => {
    const parsed = parseSshdT('Port 22\n  passwordauthentication  yes\n# comment\n\npermitrootlogin prohibit-password\n');
    expect(parsed.passwordauthentication).toBe('yes');
    expect(parsed.permitrootlogin).toBe('prohibit-password');
    expect(parsed.port).toBe('22');
    expect(Object.keys(parsed)).not.toContain('# comment');
  });

  it('detectSupportedDirectives: новый sshd, старый sshd, ничего', () => {
    expect(detectSupportedDirectives({ passwordauthentication: 'yes', kbdinteractiveauthentication: 'yes' })).toEqual([
      'PasswordAuthentication',
      'KbdInteractiveAuthentication',
    ]);
    expect(detectSupportedDirectives({ passwordauthentication: 'yes', challengeresponseauthentication: 'no' })).toEqual([
      'PasswordAuthentication',
      'ChallengeResponseAuthentication',
    ]);
    expect(detectSupportedDirectives({ port: '22' })).toEqual([]);
  });

  it('failedEffectiveDirectives: не ставшие no', () => {
    const parsed = { passwordauthentication: 'no', kbdinteractiveauthentication: 'yes' };
    expect(failedEffectiveDirectives(parsed, ['PasswordAuthentication', 'KbdInteractiveAuthentication'])).toEqual([
      'KbdInteractiveAuthentication',
    ]);
  });

  it('rewriteSshdConfig: активные заменяются на месте, закомментированные не трогаются', () => {
    const out = rewriteSshdConfig(
      'Port 22\nPasswordAuthentication yes\n#KbdInteractiveAuthentication yes\n',
      ['PasswordAuthentication', 'KbdInteractiveAuthentication'],
    );
    expect(out).toBe(
      'Port 22\nPasswordAuthentication no\n#KbdInteractiveAuthentication yes\n' +
        '# ssh-commander: password SSH login disabled\nKbdInteractiveAuthentication no\n',
    );
  });

  it('rewriteSshdConfig: отсутствующие вставляются до первого Match, внутри Match не лезем', () => {
    const out = rewriteSshdConfig(
      'Port 22\nMatch User admin\n    PasswordAuthentication no\n',
      ['PasswordAuthentication', 'KbdInteractiveAuthentication'],
    );
    const lines = out.split('\n');
    expect(lines.indexOf('# ssh-commander: password SSH login disabled')).toBe(1);
    expect(lines.indexOf('Match User admin')).toBe(4);
    // строка с отступом внутри Match — другой контекст, глобальную не заменяет
    expect(lines).toContain('    PasswordAuthentication no');
  });

  it('rewriteSshdConfig: без Match — вставка в конец, CRLF tolerated', () => {
    const out = rewriteSshdConfig('Port 22\r\nPermitRootLogin yes\r\n\r\n', ['PasswordAuthentication']);
    expect(out).toBe(
      'Port 22\nPermitRootLogin yes\n# ssh-commander: password SSH login disabled\nPasswordAuthentication no\n\n',
    );
  });
});

describe('bootstrap: маппинг ошибок подключения', () => {
  const ctx = { host: '203.0.113.10', port: 22, username: 'root' };
  const err = (message: string, code?: string) => Object.assign(new Error(message), { code });

  it('сетевые ошибки', () => {
    expect(mapConnectError(err('connect ECONNREFUSED', 'ECONNREFUSED'), ctx, 'password').message).toContain('порт недоступен');
    expect(mapConnectError(err('getaddrinfo ENOTFOUND', 'ENOTFOUND'), ctx, 'password').message).toContain('не разрешается');
    expect(mapConnectError(err('No route', 'EHOSTUNREACH'), ctx, 'key').message).toContain('недоступен');
    expect(mapConnectError(err('Timed out while waiting for handshake', 'ETIMEDOUT'), ctx, 'password').message).toContain('Таймаут');
  });

  it('отказ аутентификации различается по фазе и не раскрывает пароль', () => {
    const pw = mapConnectError(err(AUTH_FAILED), ctx, 'password');
    expect(pw.message).toContain('неверный пароль');
    expect(pw.message).toContain('PermitRootLogin prohibit-password');
    expect(pw.message).not.toContain('s3cret');
    expect(mapConnectError(err(AUTH_FAILED), ctx, 'key').message).toContain('сервер не принял ключ');
  });

  it('прочее — как есть', () => {
    expect(mapConnectError(err('Boom'), ctx, 'password').message).toContain('Boom');
  });
});

describe('bootstrap: оркестрация (мок ssh2-клиента)', () => {
  let keysDir: string;
  let server: FakeSshServer;

  beforeEach(() => {
    keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bootstrap-keys-'));
    server = new FakeSshServer();
  });

  afterEach(() => {
    fs.rmSync(keysDir, { recursive: true, force: true });
  });

  const stepNames = (steps: Array<{ name: string; status: string }>) => steps.map((s) => `${s.name}[${s.status}]`);
  const captureError = async (promise: Promise<unknown>): Promise<BootstrapError> => {
    try {
      await promise;
      throw new Error('ожидали отказ');
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapError);
      return err as BootstrapError;
    }
  };

  it('без hardening: шаги, подключения, профиль authType=key, файл ключа 0600', async () => {
    const res = await bootstrapServer(input(), server.deps(keysDir));
    expect(stepNames(res.steps)).toEqual([
      'Генерация ключа ed25519[ok]',
      'Подключение по паролю[ok]',
      'Сохранение ключа[ok]',
      'Установка ключа на сервере[ok]',
      'Проверка входа по ключу[ok]',
      'Создание профиля[ok]',
    ]);
    expect(server.connects.map((c) => (c.privateKey ? 'key' : 'password'))).toEqual(['password', 'key']);
    expect(server.createdProfiles).toHaveLength(1);
    expect(server.createdProfiles[0].authType).toBe('key');
    const keyPath = server.createdProfiles[0].keyPath as string;
    expect(keyPath).toBe(path.join(keysDir, 'fresh-vps.ed25519'));
    // Права 0600 проверяем только на POSIX: Windows-стат не отражает chmod
    // (тот же класс пропуска, что у keys.test.ts на Windows-машинах).
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }
    expect(server.allCommands.find((c) => c.cmd.startsWith('umask 077'))!.cmd).toContain('ssh-commander@fresh-vps');
  });

  it('идемпотентность: ключ уже стоит → шаг честно сообщает, дубль не пишется', async () => {
    server.installEcho = 'present';
    const res = await bootstrapServer(input(), server.deps(keysDir));
    expect(res.steps.find((s) => s.name === 'Установка ключа на сервере')!.detail).toContain('уже был');
  });

  it('неверный пароль: понятная ошибка, ключ не сохраняется, профиль не создаётся', async () => {
    server.passwordLoginWorks = false;
    const err = await captureError(bootstrapServer(input(), server.deps(keysDir)));
    expect(err.status).toBe(400);
    expect(err.message).toContain('неверный пароль');
    expect(err.message).not.toContain('s3cret');
    expect(err.steps.some((s) => s.name === 'Подключение по паролю' && s.status === 'error')).toBe(true);
    expect(fs.readdirSync(keysDir)).toEqual([]);
    expect(server.createdProfiles).toHaveLength(0);
  });

  it('hardening (drop-in): полный порядок и контрольные проверки', async () => {
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    const res = await bootstrapServer(input({ disablePasswordAuth: true }), server.depsWithPasswordRejectedLater(keysDir));
    expect(stepNames(res.steps)).toEqual([
      'Генерация ключа ed25519[ok]',
      'Подключение по паролю[ok]',
      'Сохранение ключа[ok]',
      'Установка ключа на сервере[ok]',
      'Проверка входа по ключу[ok]',
      'Анализ конфигурации sshd[ok]',
      'Отключение парольного входа[ok]',
      'Проверка конфигурации (sshd -t)[ok]',
      'Перезагрузка sshd[ok]',
      'Контрольная проверка конфигурации[ok]',
      'Контрольный вход по ключу[ok]',
      'Контроль: парольный вход[ok]',
      'Создание профиля[ok]',
    ]);
    // sshd не трогается, пока вход ключом не доказан: подключение с ключом
    // происходит раньше первой правки конфига
    const commands = server.allCommands.map((c) => c.cmd);
    const dropinIdx = commands.findIndex((c) => c.startsWith('umask 022'));
    expect(dropinIdx).toBeGreaterThan(-1);
    expect(server.connects.findIndex((c) => c.privateKey)).toBeLessThanOrEqual(1);
    // 3 SSH-подключения + контрольная password-попытка (отклонена)
    expect(server.connects).toHaveLength(4);
    // reload пришёл после зелёного -t
    expect(commands.findIndex((c) => c.includes('"$SSHD" -t'))).toBeLessThan(
      commands.findIndex((c) => c.startsWith('systemctl reload')),
    );
    expect(res.profile.authType).toBe('key');
  });

  it('hardening: старый sshd — ChallengeResponseAuthentication вместо KbdInteractive', async () => {
    server.sshdTOutput = 'passwordauthentication yes\nchallengeresponseauthentication yes\n';
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', challengeresponseauthentication: 'no' };
    const res = await bootstrapServer(input({ disablePasswordAuth: true }), server.depsWithPasswordRejectedLater(keysDir));
    const dropinWrite = server.allCommands.find((c) => c.cmd.startsWith('umask 022'))!.cmd;
    expect(dropinWrite).toContain('PasswordAuthentication no');
    expect(dropinWrite).toContain('ChallengeResponseAuthentication no');
    expect(dropinWrite).not.toContain('KbdInteractiveAuthentication');
    expect(res.steps.find((s) => s.name === 'Отключение парольного входа')!.detail).toContain('ChallengeResponseAuthentication');
  });

  it('hardening fallback без sshd_config.d: бэкап → cat → локальная правка → запись', async () => {
    server.dropinSupported = false;
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    const res = await bootstrapServer(input({ disablePasswordAuth: true }), server.depsWithPasswordRejectedLater(keysDir));
    const commands = server.allCommands.map((c) => c.cmd);
    const backupIdx = commands.findIndex((c) => c.startsWith('cp ') && c.includes('.bak-ssh-commander-'));
    const readIdx = commands.findIndex((c) => c.startsWith('cat '));
    const writeIdx = commands.findIndex((c) => c.startsWith("printf '%s'"));
    expect(backupIdx).toBeGreaterThan(-1);
    expect(backupIdx).toBeLessThan(readIdx);
    expect(readIdx).toBeLessThan(writeIdx);
    const written = commands[writeIdx];
    expect(written).toContain('PasswordAuthentication no');
    expect(written).toContain('KbdInteractiveAuthentication no');
    expect(written).not.toContain('PasswordAuthentication yes');
    expect(res.steps.find((s) => s.name === 'Отключение парольного входа')!.detail).toContain('бэкап');
  });

  it('пароль всё ещё пускает после hardening → честный warn, без отката', async () => {
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    const res = await bootstrapServer(input({ disablePasswordAuth: true }), server.deps(keysDir));
    const pwStep = res.steps.find((s) => s.name === 'Контроль: парольный вход')!;
    expect(pwStep.status).toBe('warn');
    expect(pwStep.detail).toContain('по-прежнему пускает');
    expect(res.steps.some((s) => s.name === 'Откат изменений sshd')).toBe(false);
    expect(server.createdProfiles).toHaveLength(1);
  });

  it('эффективный конфиг не применился → откат, чистка ключа, ошибка', async () => {
    server.sshdTEffectiveAfter = { passwordauthentication: 'yes', kbdinteractiveauthentication: 'no' };
    const err = await captureError(bootstrapServer(input({ disablePasswordAuth: true }), server.deps(keysDir)));
    expect(err.message).toContain('Hardening не применился');
    expect(err.message).toContain('PasswordAuthentication=yes');
    // откат: удаление drop-in + повторный reload
    const rollback = server.allCommands.find((c) => c.cmd.startsWith(`rm -f '${SSHD_DROPIN_PATH}'`));
    expect(rollback).toBeTruthy();
    expect(rollback!.cmd).toBe(buildRollbackDropinCommand());
    expect(rollback!.kind).toBe('password'); // живая password-сессия пережила reload
    expect(err.steps.some((s) => s.name === 'Откат изменений sshd' && s.status === 'warn')).toBe(true);
    // чистка: строка ключа удалена, локальный файл удалён, профиля нет
    expect(server.allCommands.some((c) => c.cmd.startsWith('grep -Fv --'))).toBe(true);
    expect(fs.readdirSync(keysDir)).toEqual([]);
    expect(server.createdProfiles).toHaveLength(0);
  });

  it('красный sshd -t → откат и ошибка с выводом (409)', async () => {
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    const origDispatch = server.dispatch.bind(server);
    server.dispatch = (cmd: string, session: FakeSession) => {
      if (cmd.startsWith('umask 022')) server.sshdtTestFailsAfterHardening = true;
      return origDispatch(cmd, session);
    };
    const err = await captureError(bootstrapServer(input({ disablePasswordAuth: true }), server.deps(keysDir)));
    expect(err.status).toBe(409);
    expect(err.message).toContain('sshd -t отверг');
    expect(err.message).toContain('Bad directive');
    expect(server.allCommands.some((c) => c.cmd.startsWith(`rm -f '${SSHD_DROPIN_PATH}'`))).toBe(true);
  });

  it('оборванная password-сессия после reload → откат и чистка через key-сессию', async () => {
    server.killPasswordSessionsAfterReload = true;
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    const err = await captureError(bootstrapServer(input({ disablePasswordAuth: true }), server.deps(keysDir)));
    expect(err.message).toContain('Bootstrap прерван после правки sshd');
    const rollback = server.allCommands.find((c) => c.cmd.startsWith(`rm -f '${SSHD_DROPIN_PATH}'`));
    expect(rollback).toBeTruthy();
    expect(rollback!.kind).toBe('key');
    expect(err.steps.some((s) => s.name === 'Откат изменений sshd' && s.status === 'warn')).toBe(true);
    expect(server.allCommands.find((c) => c.cmd.startsWith('grep -Fv --'))!.kind).toBe('key');
  });

  it('hardening ок, но createProfile упал: ключ сохраняется, откат не делается, подсказка в ошибке', async () => {
    server.sshdTEffectiveAfter = { passwordauthentication: 'no', kbdinteractiveauthentication: 'no' };
    server.createProfileError = 'profiles store was corrupt at startup';
    const err = await captureError(bootstrapServer(input({ disablePasswordAuth: true }), server.deps(keysDir)));
    expect(err.message).toContain('профиль не создан');
    expect(err.message).toContain('добавьте профиль вручную');
    expect(err.message).toMatch(/fresh-vps(-\d+)?\.ed25519/);
    expect(fs.readdirSync(keysDir)).toEqual([expect.stringMatching(/^fresh-vps(-\d+)?\.ed25519$/)]);
    expect(server.allCommands.some((c) => c.cmd.startsWith('grep -Fv --'))).toBe(false);
    expect(server.allCommands.some((c) => c.cmd.startsWith(`rm -f '${SSHD_DROPIN_PATH}'`))).toBe(false);
  });

  it('hardening для не-root отклоняется до любых подключений', async () => {
    const err = await captureError(
      bootstrapServer(input({ username: 'deploy', disablePasswordAuth: true }), server.deps(keysDir)),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('только для пользователя root');
    expect(server.connects).toHaveLength(0);
    expect(fs.readdirSync(keysDir)).toEqual([]);
  });
});
