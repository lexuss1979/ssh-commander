import type { ToolDef } from './client.js';
import { isSearchConfigured } from './web-search.js';

const str = (description: string) => ({ type: 'string', description });
const required = (name: string, description: string) => ({
  type: 'object',
  properties: { [name]: str(description) },
  required: [name],
});

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'exec_readonly',
      description:
        'Выполнить безопасную команду чтения на сервере (ls, cat, head, tail, grep, find, df, free, ps, ss и т.п.). Выполняется автоматически без подтверждения. Команды записи, удаления и управления системой в этом инструменте запрещены — используйте exec.',
      parameters: {
        type: 'object',
        properties: {
          command: str('Команда для выполнения'),
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
      parameters: required('path', 'Абсолютный путь к файлу'),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        'Прочитать MEMORY.md профиля — заметки, накопленные в прошлых сессиях. Это память приложения, а не файл на удалённом сервере. ' +
        'В начале сессии её содержимое уже загружено в контекст; вызывай, когда нужно освежить полный текст (например, в длинной сессии).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description:
        'Обновить MEMORY.md профиля — записать важные находки для будущих сессий. Требует подтверждения пользователя. ' +
        'content — это полный новый текст файла: обязательно сохраняй все существующие записи и только добавляй/правь нужное, без дублей.',
      parameters: {
        type: 'object',
        properties: {
          content: str('Полный новый текст MEMORY.md (существующие записи + изменения)'),
          reason: str('Короткое пояснение для пользователя, что и зачем записывается'),
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
      parameters: required('path', 'Абсолютный путь к директории'),
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
      parameters: { type: 'object', properties: {}, additionalProperties: false },
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
      parameters: required('target', 'ID или имя объекта Docker'),
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
        },
        required: ['action'],
      },
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
  'web_search',
]);

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
