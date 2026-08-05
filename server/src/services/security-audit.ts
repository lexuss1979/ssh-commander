import { exec } from '../ssh/manager.js';
import { shq } from '../util/shell.js';
import { inspect, listContainers, type DockerEntity } from './docker.js';
import type { ExecResult, Profile } from '../types.js';

/**
 * Детерминированный аудит безопасности сервера: фиксированный белый список
 * read-only команд по секциям. Произвольный shell инструмент НЕ принимает,
 * поэтому через guard.ts он не проходит — команды зашиты здесь.
 *
 * Привилегированный режим: root-only команды выполняются через
 * `sudo -S -p '' -- sh -c <cmd>`, пароль подаётся в stdin канала (НЕ в
 * командной строке — пароль не появляется в ps и логах). Без пароля или при
 * нерабочем sudo root-подсекции помечаются «пропущено: нет прав».
 */

export type AuditSectionId = 'auth' | 'network' | 'updates' | 'activity' | 'docker' | 'filesystem';

export const ALL_SECTIONS: AuditSectionId[] = [
  'auth',
  'network',
  'updates',
  'activity',
  'docker',
  'filesystem',
];

/** Общий лимит вывода аудита: результат должен укладываться в ~10 КБ. */
const TOTAL_LIMIT = 9500;
const DEFAULT_MAX_LINES = 60;
/** Лимит символов на подсекцию (строки бывают очень длинными). */
const SUBSECTION_MAX_CHARS = 1500;
/** SUID-find по всей ФС может быть долгим — отдельный лимит времени. */
const FIND_TIMEOUT_MS = 55000;

export interface AuditCommand {
  /** Название подсекции в отчёте. */
  title: string;
  /** Команда, выполняемая без прав root. */
  command: string;
  /** Вариант команды для root (выполняется через sudo вместо command, если sudo доступен). */
  rootCommand?: string;
  /** Подсекция только для root: без sudo — пропуск с пометкой. */
  rootOnly?: boolean;
  /** Лимит строк вывода подсекции. */
  maxLines?: number;
  timeoutMs?: number;
}

/** Команды секции — чистая функция, фиксированный белый список. */
export function commandsForSection(section: AuditSectionId): AuditCommand[] {
  switch (section) {
    case 'auth':
      return [
        {
          title: 'Настройки sshd',
          command:
            `grep -Ei '^[[:space:]]*(PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords|MaxAuthTries|Port)[[:space:]]' ` +
            `/etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true`,
        },
        {
          title: 'Пользователи с UID 0',
          command: `awk -F: '$3==0 {print $1}' /etc/passwd`,
        },
        {
          title: 'Пользователи с login-shell',
          command: `awk -F: '$7 ~ /(bash|sh|zsh)$/ {print $1, $7}' /etc/passwd`,
          maxLines: 40,
        },
        {
          title: 'Пустые пароли (/etc/shadow)',
          command: `awk -F: '$2=="" {print $1}' /etc/shadow`,
          rootOnly: true,
        },
        {
          title: 'NOPASSWD в sudoers',
          command: `grep -r NOPASSWD /etc/sudoers /etc/sudoers.d/ 2>/dev/null`,
          rootOnly: true,
        },
        {
          title: 'Ключи root (/root/.ssh/authorized_keys)',
          command: `cat /root/.ssh/authorized_keys 2>/dev/null || true`,
          rootOnly: true,
          maxLines: 40,
        },
      ];
    case 'network':
      return [
        {
          title: 'Утилиты фаервола',
          command: `command -v ufw iptables nft firewall-cmd 2>/dev/null || echo '(утилиты фаервола не найдены)'`,
        },
        {
          title: 'Открытые порты',
          command: `ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo '(нет ни ss, ни netstat)'`,
          rootCommand: `ss -tulpn 2>/dev/null || netstat -tulnp 2>/dev/null || echo '(нет ни ss, ни netstat)'`,
          maxLines: 80,
        },
        {
          title: 'Статус фаервола (ufw/iptables)',
          command: `ufw status 2>/dev/null; iptables -L -n 2>/dev/null | head -50; true`,
          rootOnly: true,
          maxLines: 60,
        },
      ];
    case 'updates':
      return [
        {
          title: 'Пакетный менеджер',
          command: `command -v apt-get dnf yum apk zypper 2>/dev/null`,
        },
        {
          title: 'Доступные обновления',
          command:
            `if command -v apt-get >/dev/null 2>&1; then\n` +
            `  apt list --upgradable 2>/dev/null | head -100\n` +
            `elif command -v dnf >/dev/null 2>&1; then\n` +
            `  dnf check-update 2>/dev/null | head -100\n` +
            `elif command -v yum >/dev/null 2>&1; then\n` +
            `  yum check-update 2>/dev/null | head -100\n` +
            `elif command -v apk >/dev/null 2>&1; then\n` +
            `  apk version -l '<' 2>/dev/null | head -100\n` +
            `else\n` +
            `  echo 'неизвестный пакетный менеджер — проверка обновлений пропущена'\n` +
            `fi`,
          maxLines: 100,
        },
        {
          title: 'Автообновления (unattended-upgrades)',
          command:
            `if command -v apt-get >/dev/null 2>&1; then\n` +
            `  dpkg -l unattended-upgrades 2>/dev/null | grep '^ii'\n` +
            `  ls -l /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null\n` +
            `else\n` +
            `  echo 'не apt-система — проверка пропущена'\n` +
            `fi`,
        },
      ];
    case 'activity':
      return [
        {
          title: 'Последние входы (last)',
          command: `last -n 20 2>/dev/null || true`,
          maxLines: 25,
        },
        {
          title: 'Неудачные входы (lastb)',
          command: `lastb -n 20 2>/dev/null || echo '(lastb недоступен)'`,
          rootOnly: true,
          maxLines: 25,
        },
        {
          title: 'Неудачные SSH-логины из журнала',
          command:
            `journalctl -u ssh -u sshd --no-pager -n 200 2>/dev/null | grep -i failed | tail -20; ` +
            `grep -i 'failed' /var/log/auth.log 2>/dev/null | tail -20; true`,
          rootOnly: true,
          maxLines: 45,
        },
        {
          title: 'Топ процессов по CPU',
          command: `ps aux --sort=-%cpu | head -15`,
          maxLines: 20,
        },
        {
          title: 'SUID-бинарники',
          command: `find / -xdev -perm -4000 -type f 2>/dev/null | head -100`,
          maxLines: 100,
          timeoutMs: FIND_TIMEOUT_MS,
        },
      ];
    case 'filesystem':
      return [
        {
          title: 'Права на ключевые файлы',
          command: `ls -l /etc/shadow /etc/passwd /etc/ssh/sshd_config 2>/dev/null`,
        },
        {
          title: 'World-writable файлы в системных путях',
          command: `find /etc /usr /bin /sbin -xdev -type f -perm -0002 2>/dev/null | head -50`,
          maxLines: 50,
          timeoutMs: FIND_TIMEOUT_MS,
        },
        {
          title: 'Cron (текущий пользователь и системный)',
          command:
            `crontab -l 2>/dev/null; echo '--- /etc/crontab:'; cat /etc/crontab 2>/dev/null; ` +
            `echo '--- /etc/cron.d:'; ls -la /etc/cron.d/ 2>/dev/null; true`,
          maxLines: 60,
        },
        {
          title: 'Cron root',
          command: `crontab -l -u root 2>/dev/null || true`,
          rootOnly: true,
          maxLines: 40,
        },
      ];
    case 'docker':
      // Секция собирается через services/docker.ts (listContainers + inspect),
      // а не фиксированными shell-командами.
      return [];
  }
}

/**
 * Обёртка для запуска команды через sudo: пароль НЕ попадает в строку
 * команды — он подаётся в stdin канала (`sudo -S`), промпт подавлен (`-p ''`).
 */
export function sudoWrap(command: string): string {
  return `sudo -S -p '' -- sh -c ${shq(command)}`;
}

/** Обрезка вывода подсекции по строкам и символам с пометкой. */
export function limitLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  let body =
    lines.length <= maxLines
      ? text
      : `${lines.slice(0, maxLines).join('\n')}\n… (обрезано: показано ${maxLines} из ${lines.length} строк)`;
  if (body.length > SUBSECTION_MAX_CHARS) {
    body = `${body.slice(0, SUBSECTION_MAX_CHARS)}\n… (обрезано по объёму)`;
  }
  return body;
}

/** Проблемы контейнера по данным docker inspect — чистая функция. */
export function findContainerIssues(inspectData: DockerEntity): string[] {
  const issues: string[] = [];
  const hostConfig = (inspectData.HostConfig ?? {}) as Record<string, unknown>;
  if (hostConfig.Privileged === true) {
    issues.push('privileged-режим');
  }
  if (hostConfig.NetworkMode === 'host') {
    issues.push('сеть host');
  }
  const sources: string[] = [];
  if (Array.isArray(hostConfig.Binds)) {
    for (const bind of hostConfig.Binds) {
      sources.push(String(bind).split(':')[0]);
    }
  }
  if (Array.isArray(inspectData.Mounts)) {
    for (const mount of inspectData.Mounts as Array<Record<string, unknown>>) {
      if (typeof mount.Source === 'string') sources.push(mount.Source);
    }
  }
  if (sources.some((s) => s === '/var/run/docker.sock')) {
    issues.push('монтирует /var/run/docker.sock');
  }
  if (sources.some((s) => s === '/')) {
    issues.push('монтирует корень ФС (/)');
  }
  return issues;
}

export type ExecFn = (
  profile: Profile,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string },
) => Promise<ExecResult>;

export interface AuditDeps {
  execFn?: ExecFn;
  listContainersFn?: typeof listContainers;
  inspectFn?: typeof inspect;
}

export interface AuditOptions {
  sections?: string[];
  /** Запрошен привилегированный режим (root-подсекции через sudo). */
  privileged?: boolean;
  /** sudo-пароль из сессии агента; в вывод и команды не попадает. */
  sudoPassword?: string;
}

export function normalizeSections(sections?: string[]): AuditSectionId[] {
  if (!sections?.length) return ALL_SECTIONS;
  const valid = sections.filter((s): s is AuditSectionId =>
    (ALL_SECTIONS as string[]).includes(s),
  );
  return valid.length ? valid : ALL_SECTIONS;
}

async function auditDocker(
  profile: Profile,
  deps: AuditDeps,
): Promise<string[]> {
  const listFn = deps.listContainersFn ?? listContainers;
  const inspectFn = deps.inspectFn ?? inspect;
  let containers: DockerEntity[];
  try {
    containers = await listFn(profile);
  } catch (err) {
    return [`docker недоступен: ${String((err as Error).message ?? err)}`];
  }
  if (!containers.length) return ['контейнеров нет'];
  const lines: string[] = [];
  for (const c of containers.slice(0, 25)) {
    const id = String(c.ID ?? c.ContainerID ?? '');
    const name = String(c.Names ?? id.slice(0, 12));
    try {
      const [data] = await inspectFn(profile, id);
      const issues = data ? findContainerIssues(data) : [];
      lines.push(issues.length ? `${name}: ${issues.join('; ')}` : `${name}: ok`);
    } catch (err) {
      lines.push(`${name}: не удалось выполнить inspect (${String((err as Error).message ?? err)})`);
    }
  }
  return lines;
}

/**
 * Выполняет аудит и возвращает компактный текстовый отчёт с сырыми данными
 * по секциям (анализ и severity — задача модели). Мягкая деградация: без
 * пароля или при нерабочем sudo root-подсекции помечаются «пропущено».
 */
export async function runSecurityAudit(
  profile: Profile,
  opts: AuditOptions = {},
  deps: AuditDeps = {},
): Promise<string> {
  const execFn = deps.execFn ?? exec;
  const sections = normalizeSections(opts.sections);
  const password = opts.privileged && opts.sudoPassword ? opts.sudoPassword : null;

  // Проверяем sudo один раз: пароль уходит в stdin, не в командную строку.
  let sudoOk = false;
  if (password) {
    try {
      const check = await execFn(profile, sudoWrap('true'), { stdin: `${password}\n` });
      sudoOk = check.code === 0;
    } catch {
      sudoOk = false;
    }
  }

  const parts: string[] = [];
  if (opts.privileged && !sudoOk) {
    parts.push(
      password
        ? '> Привилегированный режим запрошен, но sudo не сработал — root-проверки пропущены.'
        : '> sudo-пароль не задан — root-проверки пропущены (мягкая деградация).',
    );
  }
  let total = parts.join('\n').length;
  let truncated = false;

  for (const section of sections) {
    if (truncated) break;
    const sectionParts: string[] = [`## ${section}`];
    if (section === 'docker') {
      sectionParts.push(...(await auditDocker(profile, deps)));
    } else {
      for (const cmd of commandsForSection(section)) {
        const useSudo = sudoOk && (cmd.rootOnly || cmd.rootCommand != null);
        if (cmd.rootOnly && !sudoOk) {
          sectionParts.push(`### ${cmd.title}\nпропущено: нет прав (нужен sudo)`);
          continue;
        }
        const command = useSudo ? sudoWrap(cmd.rootCommand ?? cmd.command) : cmd.command;
        const stdin = useSudo && password ? `${password}\n` : undefined;
        let body: string;
        try {
          const result = await execFn(profile, command, {
            timeoutMs: cmd.timeoutMs,
            stdin,
          });
          body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          if (!body) body = '(пустой вывод)';
          if (result.code !== 0) body += `\n(exit code: ${result.code ?? 'unknown'})`;
        } catch (err) {
          body = `ошибка выполнения: ${String((err as Error).message ?? err)}`;
        }
        sectionParts.push(`### ${cmd.title}\n${limitLines(body, cmd.maxLines ?? DEFAULT_MAX_LINES)}`);
      }
    }
    const sectionText = sectionParts.join('\n');
    if (total + sectionText.length > TOTAL_LIMIT) {
      truncated = true;
      parts.push(
        `… (вывод обрезан по объёму: секция «${section}» и далее пропущены — запросите их отдельно через параметр sections)`,
      );
      break;
    }
    parts.push(sectionText);
    total += sectionText.length;
  }

  return parts.join('\n\n');
}
