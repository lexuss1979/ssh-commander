import type { ToolDef } from './client.js';
import { isSensitivePath, sensitivePathsIn } from './redact.js';
import { isSearchConfigured } from './web-search.js';

const str = (description: string) => ({ type: 'string', description });
const required = (name: string, description: string) => ({
  type: 'object',
  properties: { [name]: str(description) },
  required: [name],
});

// Адресация сервера в мульти-серверном диалоге: необязательное имя профиля
// из list_servers; без параметра инструмент выполняется на домашнем сервере.
const serverParam = () =>
  str('Имя профиля сервера из list_servers; без параметра — домашний сервер диалога');

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'exec_readonly',
      description:
        'Выполнить безопасную команду чтения на сервере. Выполняется автоматически без подтверждения. ' +
        'Разрешён фиксированный список утилит чтения: ls, cat, head, tail, stat, file, find, du, df, wc, grep, sort, uniq, cut, ' +
        'strings, od, xxd, diff, sha256sum, uname, hostname, uptime, date, whoami, id, w, who, last, lscpu, lsblk, lsof, free, ' +
        'vmstat, dmesg, journalctl, printenv, ps, pgrep, pstree, top, ss, netstat (полный список — allow-лист сервера). ' +
        'Конвейеры, перенаправление и подстановка команд запрещены; интерпретаторы (sh, python, awk, sed), сетевые клиенты ' +
        '(curl, nc, socat, ssh) и любые изменяющие команды — только через exec, с подтверждением пользователя.',
      parameters: {
        type: 'object',
        properties: {
          command: str('Команда для выполнения'),
          server: serverParam(),
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description:
        'Выполнить произвольную shell-команду на сервере (включая команды записи/удаления/управления). Требует подтверждения пользователя.',
      parameters: {
        type: 'object',
        properties: {
          command: str('Команда для выполнения'),
          server: serverParam(),
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл на сервере (до 256 КБ).',
      parameters: {
        type: 'object',
        properties: {
          path: str('Абсолютный путь к файлу'),
          server: serverParam(),
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        'Прочитать MEMORY.md профиля — заметки, накопленные в прошлых сессиях. Это память приложения, а не файл на удалённом сервере. ' +
        'В начале сессии её содержимое уже загружено в контекст; вызывай, когда нужно освежить полный текст (например, в длинной сессии). ' +
        'Память ведётся отдельно для каждого сервера — параметр server выбирает, чью память читать.',
      parameters: {
        type: 'object',
        properties: { server: serverParam() },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description:
        'Обновить MEMORY.md профиля — записать важные находки для будущих сессий. Требует подтверждения пользователя. ' +
        'content — это полный новый текст файла: обязательно сохраняй все существующие записи и только добавляй/правь нужное, без дублей. ' +
        'Память ведётся отдельно для каждого сервера — параметр server выбирает, чью память обновить.',
      parameters: {
        type: 'object',
        properties: {
          content: str('Полный новый текст MEMORY.md (существующие записи + изменения)'),
          reason: str('Короткое пояснение для пользователя, что и зачем записывается'),
          server: serverParam(),
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Показать содержимое директории на сервере.',
      parameters: {
        type: 'object',
        properties: {
          path: str('Абсолютный путь к директории'),
          server: serverParam(),
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Записать текстовый файл на сервере (создать или перезаписать). Требует подтверждения пользователя.',
      parameters: {
        type: 'object',
        properties: {
          path: str('Абсолютный путь к файлу'),
          content: str('Содержимое файла'),
          server: serverParam(),
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_ps',
      description: 'Список контейнеров Docker (все, включая остановленные).',
      parameters: {
        type: 'object',
        properties: { server: serverParam() },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_logs',
      description: 'Последние строки логов контейнера Docker.',
      parameters: {
        type: 'object',
        properties: {
          containerId: str('ID или имя контейнера'),
          tail: str('Количество строк (по умолчанию 100)'),
          server: serverParam(),
        },
        required: ['containerId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_inspect',
      description: 'Подробная информация о контейнере, образе, volume или сети Docker.',
      parameters: {
        type: 'object',
        properties: {
          target: str('ID или имя объекта Docker'),
          server: serverParam(),
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'security_audit',
      description:
        'Проверка безопасности сервера: фиксированный набор read-only команд по секциям ' +
        '(auth, network, updates, activity, docker, filesystem). Произвольные команды не принимает. ' +
        'Возвращает сырые данные — проанализируй их и оформи отчёт с severity (критично/предупреждение/ок) и рекомендациями.',
      parameters: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            items: { type: 'string' },
            description: 'Секции аудита: auth, network, updates, activity, docker, filesystem (по умолчанию все)',
          },
          privileged: {
            type: 'boolean',
            description:
              'Выполнить root-проверки через sudo (работает, только если пользователь ввёл sudo-пароль в интерфейсе; пароль модели недоступен)',
          },
          server: serverParam(),
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'disk_usage',
      description:
        'Что занимает место на диске: размер каталога, крупнейшие подкаталоги и файлы ' +
        '(du/find, read-only, выполняется автоматически). path — абсолютный путь, по умолчанию /; ' +
        'limit — число записей, по умолчанию 10. ' +
        'Типовой сценарий «почему кончился диск»: начни с /, затем спускайся по крупнейшим подкаталогам.',
      parameters: {
        type: 'object',
        properties: {
          path: str('Абсолютный путь к каталогу (по умолчанию /)'),
          limit: str('Число записей в списках (по умолчанию 10)'),
          server: serverParam(),
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_action',
      description:
        'Управляющее действие с Docker: start/stop/restart/rm для контейнера, pull/rmi для образа, run для запуска контейнера. Требует подтверждения пользователя.',
      parameters: {
        type: 'object',
        properties: {
          action: str('Одно из: start, stop, restart, rm, pull, rmi, run'),
          target: str('ID или имя контейнера/образа (для start/stop/restart/rm/rmi)'),
          image: str('Образ для pull/run'),
          name: str('Имя контейнера (для run)'),
          ports: {
            type: 'array',
            items: { type: 'string' },
            description: 'Проброс портов вида "8080:80" (для run)',
          },
          env: {
            type: 'array',
            items: { type: 'string' },
            description: 'Переменные окружения вида "KEY=VALUE" (для run)',
          },
          command: str('Команда внутри контейнера (для run)'),
          server: serverParam(),
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_servers',
      description:
        'Список всех серверов (профилей подключения) приложения: имя, host, порт, пользователь, заметка и признак подключения к текущему диалогу. ' +
        'Секреты не возвращаются. Выполняется автоматически без подтверждения. ' +
        'Инструменты можно выполнять только на подключённых к диалогу серверах (connected=true) — остальные подключай через connect_server.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connect_server',
      description:
        'Подключить сервер к текущему диалогу по имени из list_servers, чтобы выполнять на нём инструменты. Требует подтверждения пользователя.',
      parameters: required('server', 'Имя профиля из list_servers'),
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Поиск в интернете: документация, man, changelog, актуальные версии пакетов, сообщения об ошибках. ' +
        'Выполняется автоматически без подтверждения. Используй, когда факт может быть устаревшим или неизвестен ' +
        '(версии, релизы, свежие настройки сервисов), — не отвечай по памяти.',
      parameters: required('query', 'Поисковый запрос (краткий, на языке искомых документов)'),
    },
  },
];

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
 * Выполняется ли вызов автоматически, без подтверждения пользователя.
 *
 * Read-only мало: чтение файла секретов (`.env`, `id_rsa`, `.pgpass`) — тоже
 * «только чтение», но прочитанное сразу уходит внешнему провайдеру, и вернуть
 * его оттуда уже нельзя. Редакция (`ai/redact.ts`) регулярная и полной
 * гарантии не даёт, поэтому такие чтения проходят через обычный approve —
 * решение остаётся за пользователем.
 */
export function isAutoRunnable(name: string, args: Record<string, unknown>): boolean {
  if (!READ_ONLY_TOOLS.has(name)) return false;
  if (name === 'read_file') return !isSensitivePath(String(args.path ?? ''));
  if (name === 'exec_readonly') return sensitivePathsIn(String(args.command ?? '')).length === 0;
  return true;
}

/**
 * Инструменты, объявляемые модели: web_search включается, только когда поиск
 * настроен (AI_SEARCH_API_BASE + ключ) — иначе модель вообще не видит
 * инструмент и не может его вызвать.
 */
export function getToolDefs(searchEnabled: boolean = isSearchConfigured()): ToolDef[] {
  return searchEnabled
    ? toolDefs
    : toolDefs.filter((t) => t.function.name !== 'web_search');
}
