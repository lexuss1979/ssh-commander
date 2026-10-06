import type { ToolDef } from './client.js';
import type { PromptLang } from './prompts.js';
import { isSensitivePath, sensitivePathsIn } from './redact.js';
import { isSearchConfigured } from './web-search.js';

// Tool descriptions are bilingual (stage 0, docs/en-comments-plan.md):
// the ru values are the verbatim former literals (do not edit them along
// with anything else), en added alongside; the language is picked in
// buildToolDefs(lang) by the session lang.
const pick = (lang: PromptLang, ru: string, en: string) => (lang === 'en' ? en : ru);
const str = (lang: PromptLang, ru: string, en: string) => ({ type: 'string', description: pick(lang, ru, en) });
const required = (lang: PromptLang, name: string, ru: string, en: string) => ({
  type: 'object',
  properties: { [name]: str(lang, ru, en) },
  required: [name],
});

// Server addressing in a multi-server dialogue: an optional profile name
// from list_servers; without the parameter the tool runs on the home server.
const serverParam = (lang: PromptLang) =>
  str(
    lang,
    'Имя профиля сервера из list_servers; без параметра — домашний сервер диалога',
    'Server profile name from list_servers; without it the tool runs on the dialogue home server',
  );

/**
 * Tool schemas declared to the model, assembled in the session lang.
 * Only the descriptions change; tool and parameter names are not translated.
 */
export function buildToolDefs(lang: PromptLang): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'exec_readonly',
        description: pick(
          lang,
          'Выполнить безопасную команду чтения на сервере. Выполняется автоматически без подтверждения. ' +
            'Разрешён фиксированный список утилит чтения: ls, cat, head, tail, stat, file, find, du, df, wc, grep, sort, uniq, cut, ' +
            'strings, od, xxd, diff, sha256sum, uname, hostname, uptime, date, whoami, id, w, who, last, lscpu, lsblk, lsof, free, ' +
            'vmstat, dmesg, journalctl, printenv, ps, pgrep, pstree, top, ss, netstat (полный список — allow-лист сервера). ' +
            'Конвейеры, перенаправление и подстановка команд запрещены; интерпретаторы (sh, python, awk, sed), сетевые клиенты ' +
            '(curl, nc, socat, ssh) и любые изменяющие команды — только через exec, с подтверждением пользователя.',
          'Run a safe read-only command on the server. Runs automatically without confirmation. ' +
            'A fixed set of read-only utilities is allowed: ls, cat, head, tail, stat, file, find, du, df, wc, grep, sort, uniq, cut, ' +
            'strings, od, xxd, diff, sha256sum, uname, hostname, uptime, date, whoami, id, w, who, last, lscpu, lsblk, lsof, free, ' +
            'vmstat, dmesg, journalctl, printenv, ps, pgrep, pstree, top, ss, netstat (full list: server-side allow-list). ' +
            'Pipes, redirection and command substitution are forbidden; interpreters (sh, python, awk, sed), network clients ' +
            '(curl, nc, socat, ssh) and any mutating commands go only through exec, with user confirmation.',
        ),
        parameters: {
          type: 'object',
          properties: {
            command: str(lang, 'Команда для выполнения', 'Command to execute'),
            server: serverParam(lang),
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'exec',
        description: pick(
          lang,
          'Выполнить произвольную shell-команду на сервере (включая команды записи/удаления/управления). Требует подтверждения пользователя.',
          'Run an arbitrary shell command on the server (including write/delete/manage commands). Requires user confirmation.',
        ),
        parameters: {
          type: 'object',
          properties: {
            command: str(lang, 'Команда для выполнения', 'Command to execute'),
            server: serverParam(lang),
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: pick(
          lang,
          'Прочитать текстовый файл на сервере (до 256 КБ).',
          'Read a text file on the server (up to 256 KB).',
        ),
        parameters: {
          type: 'object',
          properties: {
            path: str(lang, 'Абсолютный путь к файлу', 'Absolute file path'),
            server: serverParam(lang),
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: pick(
          lang,
          'Прочитать MEMORY.md профиля — заметки, накопленные в прошлых сессиях. Это память приложения, а не файл на удалённом сервере. ' +
            'В начале сессии её содержимое уже загружено в контекст; вызывай, когда нужно освежить полный текст (например, в длинной сессии). ' +
            'Память ведётся отдельно для каждого сервера — параметр server выбирает, чью память читать.',
          'Read the profile MEMORY.md — notes accumulated in past sessions. This is application memory, not a file on the remote server. ' +
            'At session start its contents are already loaded into the context; call it when you need the full text refreshed (e.g. in a long session). ' +
            'Memory is kept separately per server — the server parameter selects whose memory to read.',
        ),
        parameters: {
          type: 'object',
          properties: { server: serverParam(lang) },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description: pick(
          lang,
          'Обновить MEMORY.md профиля — записать важные находки для будущих сессий. Требует подтверждения пользователя. ' +
            'content — это полный новый текст файла: обязательно сохраняй все существующие записи и только добавляй/правь нужное, без дублей. ' +
            'Память ведётся отдельно для каждого сервера — параметр server выбирает, чью память обновить.',
          'Update the profile MEMORY.md — record important findings for future sessions. Requires user confirmation. ' +
            'content is the full new file text: always keep all existing entries and only add or edit what is needed, without duplicates. ' +
            'Memory is kept separately per server — the server parameter selects whose memory to update.',
        ),
        parameters: {
          type: 'object',
          properties: {
            content: str(
              lang,
              'Полный новый текст MEMORY.md (существующие записи + изменения)',
              'Full new MEMORY.md text (existing entries + changes)',
            ),
            reason: str(
              lang,
              'Короткое пояснение для пользователя, что и зачем записывается',
              'Short explanation for the user: what is being recorded and why',
            ),
            server: serverParam(lang),
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: pick(
          lang,
          'Показать содержимое директории на сервере.',
          'List directory contents on the server.',
        ),
        parameters: {
          type: 'object',
          properties: {
            path: str(lang, 'Абсолютный путь к директории', 'Absolute directory path'),
            server: serverParam(lang),
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: pick(
          lang,
          'Записать текстовый файл на сервере (создать или перезаписать). Требует подтверждения пользователя.',
          'Write a text file on the server (create or overwrite). Requires user confirmation.',
        ),
        parameters: {
          type: 'object',
          properties: {
            path: str(lang, 'Абсолютный путь к файлу', 'Absolute file path'),
            content: str(lang, 'Содержимое файла', 'File contents'),
            server: serverParam(lang),
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'docker_ps',
        description: pick(
          lang,
          'Список контейнеров Docker (все, включая остановленные).',
          'List Docker containers (all, including stopped).',
        ),
        parameters: {
          type: 'object',
          properties: { server: serverParam(lang) },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'docker_logs',
        description: pick(
          lang,
          'Последние строки логов контейнера Docker.',
          'Recent lines of a Docker container log.',
        ),
        parameters: {
          type: 'object',
          properties: {
            containerId: str(lang, 'ID или имя контейнера', 'Container ID or name'),
            tail: str(lang, 'Количество строк (по умолчанию 100)', 'Number of lines (default 100)'),
            server: serverParam(lang),
          },
          required: ['containerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'docker_inspect',
        description: pick(
          lang,
          'Подробная информация о контейнере, образе, volume или сети Docker.',
          'Detailed information about a Docker container, image, volume or network.',
        ),
        parameters: {
          type: 'object',
          properties: {
            target: str(lang, 'ID или имя объекта Docker', 'Docker object ID or name'),
            server: serverParam(lang),
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'security_audit',
        description: pick(
          lang,
          'Проверка безопасности сервера: фиксированный набор read-only команд по секциям ' +
            '(auth, network, updates, activity, docker, filesystem). Произвольные команды не принимает. ' +
            'Возвращает сырые данные — проанализируй их и оформи отчёт с severity (критично/предупреждение/ок) и рекомендациями.',
          'Server security check: a fixed set of read-only commands grouped by section ' +
            '(auth, network, updates, activity, docker, filesystem). Does not accept arbitrary commands. ' +
            'Returns raw data — analyze it and produce a report with severity (critical/warning/ok) and recommendations.',
        ),
        parameters: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              items: { type: 'string' },
              description: pick(
                lang,
                'Секции аудита: auth, network, updates, activity, docker, filesystem (по умолчанию все)',
                'Audit sections: auth, network, updates, activity, docker, filesystem (default: all)',
              ),
            },
            privileged: {
              type: 'boolean',
              description: pick(
                lang,
                'Выполнить root-проверки через sudo (работает, только если пользователь ввёл sudo-пароль в интерфейсе; пароль модели недоступен)',
                'Run root checks via sudo (works only if the user entered the sudo password in the UI; the password is never exposed to the model)',
              ),
            },
            server: serverParam(lang),
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'disk_usage',
        description: pick(
          lang,
          'Что занимает место на диске: размер каталога, крупнейшие подкаталоги и файлы ' +
            '(du/find, read-only, выполняется автоматически). path — абсолютный путь, по умолчанию /; ' +
            'limit — число записей, по умолчанию 10. ' +
            'Типовой сценарий «почему кончился диск»: начни с /, затем спускайся по крупнейшим подкаталогам.',
          'What takes up disk space: directory size, largest subdirectories and files ' +
            '(du/find, read-only, runs automatically). path — absolute path, default /; ' +
            'limit — number of entries, default 10. ' +
            'Typical "why did the disk fill up" scenario: start at /, then descend into the largest subdirectories.',
        ),
        parameters: {
          type: 'object',
          properties: {
            path: str(lang, 'Абсолютный путь к каталогу (по умолчанию /)', 'Absolute directory path (default /)'),
            limit: str(lang, 'Число записей в списках (по умолчанию 10)', 'Number of entries in the lists (default 10)'),
            server: serverParam(lang),
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'docker_action',
        description: pick(
          lang,
          'Управляющее действие с Docker: start/stop/restart/rm для контейнера, pull/rmi для образа, run для запуска контейнера. Требует подтверждения пользователя.',
          'Docker control action: start/stop/restart/rm for a container, pull/rmi for an image, run to start a container. Requires user confirmation.',
        ),
        parameters: {
          type: 'object',
          properties: {
            action: str(lang, 'Одно из: start, stop, restart, rm, pull, rmi, run', 'One of: start, stop, restart, rm, pull, rmi, run'),
            target: str(
              lang,
              'ID или имя контейнера/образа (для start/stop/restart/rm/rmi)',
              'Container/image ID or name (for start/stop/restart/rm/rmi)',
            ),
            image: str(lang, 'Образ для pull/run', 'Image for pull/run'),
            name: str(lang, 'Имя контейнера (для run)', 'Container name (for run)'),
            ports: {
              type: 'array',
              items: { type: 'string' },
              description: pick(lang, 'Проброс портов вида "8080:80" (для run)', 'Port mappings like "8080:80" (for run)'),
            },
            env: {
              type: 'array',
              items: { type: 'string' },
              description: pick(
                lang,
                'Переменные окружения вида "KEY=VALUE" (для run)',
                'Environment variables like "KEY=VALUE" (for run)',
              ),
            },
            command: str(lang, 'Команда внутри контейнера (для run)', 'Command inside the container (for run)'),
            server: serverParam(lang),
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_servers',
        description: pick(
          lang,
          'Список всех серверов (профилей подключения) приложения: имя, host, порт, пользователь, заметка и признак подключения к текущему диалогу. ' +
            'Секреты не возвращаются. Выполняется автоматически без подтверждения. ' +
            'Инструменты можно выполнять только на подключённых к диалогу серверах (connected=true) — остальные подключай через connect_server.',
          'List all application servers (connection profiles): name, host, port, user, note and whether connected to the current dialogue. ' +
            'Secrets are never returned. Runs automatically without confirmation. ' +
            'Tools can run only on servers connected to the dialogue (connected=true) — connect others via connect_server.',
        ),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'connect_server',
        description: pick(
          lang,
          'Подключить сервер к текущему диалогу по имени из list_servers, чтобы выполнять на нём инструменты. Требует подтверждения пользователя.',
          'Connect a server to the current dialogue by name from list_servers, so that tools can run on it. Requires user confirmation.',
        ),
        parameters: required(lang, 'server', 'Имя профиля из list_servers', 'Profile name from list_servers'),
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: pick(
          lang,
          'Поиск в интернете: документация, man, changelog, актуальные версии пакетов, сообщения об ошибках. ' +
            'Выполняется автоматически без подтверждения. Используй, когда факт может быть устаревшим или неизвестен ' +
            '(версии, релизы, свежие настройки сервисов), — не отвечай по памяти.',
          'Web search: documentation, man pages, changelogs, current package versions, error reports. ' +
            'Runs automatically without confirmation. Use it whenever a fact may be outdated or unknown ' +
            '(versions, releases, recent service settings) — do not answer from memory.',
        ),
        parameters: required(
          lang,
          'query',
          'Поисковый запрос (краткий, на языке искомых документов)',
          'Search query (short, in the language of the documents you are looking for)',
        ),
      },
    },
  ];
}

export const READ_ONLY_TOOLS = new Set([
  'exec_readonly',
  'read_file',
  'read_memory',
  'list_dir',
  'docker_ps',
  'docker_logs',
  'docker_inspect',
  'security_audit',
  'disk_usage',
  'web_search',
  'list_servers',
]);

/**
 * Whether the call runs automatically, without user confirmation.
 *
 * Read-only is not enough: reading a secrets file (`.env`, `id_rsa`,
 * `.pgpass`) is also "read-only", but whatever is read immediately goes to
 * the external provider and cannot be recalled. Redaction (`ai/redact.ts`)
 * is regex-based and gives no full guarantee, so such reads go through a
 * regular approve — the decision stays with the user.
 */
export function isAutoRunnable(name: string, args: Record<string, unknown>): boolean {
  if (!READ_ONLY_TOOLS.has(name)) return false;
  if (name === 'read_file') return !isSensitivePath(String(args.path ?? ''));
  if (name === 'exec_readonly') return sensitivePathsIn(String(args.command ?? '')).length === 0;
  return true;
}

/**
 * Tools declared to the model, in the session lang; web_search is included
 * only when search is configured (AI_SEARCH_API_BASE + key) — otherwise the
 * model does not see the tool at all and cannot call it.
 */
export function getToolDefs(lang: PromptLang = 'ru', searchEnabled: boolean = isSearchConfigured()): ToolDef[] {
  const defs = buildToolDefs(lang);
  return searchEnabled
    ? defs
    : defs.filter((t) => t.function.name !== 'web_search');
}
