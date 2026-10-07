// User-visible agent strings: tool outputs and service notes that land in
// tool_result/note (visible in UI cards and sent to the model). The language
// is the agent session lang (this.lang, default ru).
// The ru values are verbatim the strings that used to be literals in the code
// (tests are tied to them — do not rephrase); en is the translation, with
// regular quotes instead of guillemets. The ru/en key sets must match —
// server/test/ai-strings.test.ts checks the parity.

import type { PromptLang } from './prompts.js';

/** Raw dictionaries — exported for the parity test (test/ai-strings.test.ts). */
export const AI_STRINGS = {
  ru: {
    // agent.ts — resolving/attaching dialogue servers
    serverNotAttached:
      'Сервер «{name}» не подключён к диалогу — вызови connect_server ' +
      'или попроси пользователя подключить его.',
    unknownServer:
      'Неизвестный сервер «{name}». Подключённые к диалогу серверы: {available}. ' +
      'Полный список профилей — инструмент list_servers.',
    profileNotFound: 'Профиль {id} не найден',
    homeServerDetach: 'Домашний сервер диалога отцепить нельзя',
    // agent.ts — loop lifecycle
    stoppedByUser: 'Агент остановлен пользователем.',
    rejectedByUser: 'Пользователь отклонил выполнение этого действия.',
    stepLimitReached: 'Достигнут лимит шагов ({n}).',
    outputTruncated: '… (вывод обрезан, показано {n} символов)',
    // redact.ts — the redacted-secret marker in tool output
    secretRedacted: '<секрет скрыт приложением, {n} симв.>',
    // agent.ts — tool outputs
    emptyOutput: '(пустой вывод)',
    commandFailed: 'Команда завершилась с ошибкой.',
    serverNameMissing: 'Не указано имя сервера (параметр server).',
    unknownServerProfile: 'Неизвестный сервер «{name}». Доступные профили: {available}.',
    noProfiles: '(профилей нет)',
    serverAlreadyConnected: 'Сервер «{name}» уже подключён к диалогу.',
    serverConnected: 'Сервер «{name}» ({target}) подключён к диалогу.',
    searchNotConfigured: 'Веб-поиск не настроен на сервере приложения (AI_SEARCH_API_BASE пуст).',
    searchCallsLimit: 'Достигнут лимит поисковых запросов ({n} за запуск).',
    rejectedPrefix: 'Отклонено',
    fileTooLarge: 'Файл больше 256 КБ — используйте exec_readonly (head/tail).',
    memoryAbsent: '(MEMORY.md пока нет — записей из прошлых сессий нет)',
    memoryEmptyContent: 'Пустое содержимое MEMORY.md — запись отменена.',
    memoryUpdated: 'MEMORY.md обновлён ({n} байт).',
    dirEmpty: '(директория пуста)',
    fileWritten: 'Файл {path} записан ({n} символов).',
    noContainers: '(контейнеров нет)',
    noLogs: '(логов нет)',
    unknownDockerAction: 'Неизвестное действие docker_action: {action}',
    done: 'Готово.',
    unknownTool: 'Неизвестный инструмент: {name}',
    errorPrefix: 'Ошибка',
    diskFilesUnavailable: 'крупнейшие файлы недоступны: {message}',
    // client.ts — AI API response timeout
    apiTimeout: 'AI API не ответил за 120 секунд (таймаут ожидания ответа)',
    apiNetworkError: 'Сбой сети при вызове AI API: {detail}',
    apiResponseError: 'Ошибка AI API: {message}',
    apiErrorUnknown: 'Провайдер сообщил об ошибке без описания.',
    apiEmptyResponse: 'AI API завершил ответ без текста и вызовов инструментов. Повторите запрос.',
    apiIncompleteResponse: 'AI API не завершил ответ. Повторите запрос.',
    apiInterruptedResponse: 'Поток AI API прервался до завершения ответа. Повторите запрос.',
    apiInvalidToolCall: 'AI API вернул некорректный вызов инструмента.',
    // web-search.ts — the search summary prompt and tool output
    searchSummaryPrompt:
      'Найди в интернете ответ на вопрос администратора Linux-сервера и изложи его кратко по-русски. ' +
      'В конце перечисли источники (заголовок и URL). Вопрос: {query}',
    searchQueriesLabel: 'Запросы поиска',
    searchSourcesLabel: 'Источники',
    searchNoResults: '(поиск не дал результатов)',
    searchEmptyQuery: 'Пустой поисковый запрос.',
    searchUnavailable:
      'Веб-поиск недоступен: из коробки работает только с провайдером DeepSeek (тот же ключ); ' +
      'для остальных задайте AI_SEARCH_API_BASE в env.',
    searchTimeout: 'Поиск не ответил за 90 секунд (таймаут)',
    searchApiError: 'Ошибка поиска (API): {message}',
    searchError: 'Ошибка поиска: {message}',
    // disk-usage.ts — the disk_usage tool text report
    duSize: 'Размер {path}: {bytes} Б ({human})',
    duLargestDirs: 'Крупнейшие подкаталоги:',
    duNoSubdirs: '(подкаталогов нет)',
    duBytes: '{bytes} Б',
    duLargestFiles: 'Крупнейшие файлы:',
    duNoFiles: '(файлов нет)',
    duUnreadable: '(недоступно: {n} каталогов — нужны права доступа)',
    duTruncatedTotal: '(вывод du обрезан — сумма неполная)',
    // memory.ts — notes in the read_memory/write_memory output
    memoryTruncated: '… (MEMORY.md больше {max} байт, показано начало)',
    memoryTooLarge: 'MEMORY.md слишком большой: {bytes} байт, лимит {max} байт. Сократи заметки.',
    // security-audit.ts — report subsection titles
    auditTitleSshd: 'Настройки sshd',
    auditTitleUid0: 'Пользователи с UID 0',
    auditTitleLoginShell: 'Пользователи с login-shell',
    auditTitleEmptyPasswords: 'Пустые пароли (/etc/shadow)',
    auditTitleNopasswd: 'NOPASSWD в sudoers',
    auditTitleRootKeys: 'Ключи root (/root/.ssh/authorized_keys)',
    auditTitleFirewallUtils: 'Утилиты фаервола',
    auditTitleOpenPorts: 'Открытые порты',
    auditTitleFirewallStatus: 'Статус фаервола (ufw/iptables)',
    auditTitlePkgManager: 'Пакетный менеджер',
    auditTitleUpdates: 'Доступные обновления',
    auditTitleAutoUpdates: 'Автообновления (unattended-upgrades)',
    auditTitleLastLogins: 'Последние входы (last)',
    auditTitleFailedLogins: 'Неудачные входы (lastb)',
    auditTitleFailedSsh: 'Неудачные SSH-логины из журнала',
    auditTitleTopCpu: 'Топ процессов по CPU',
    auditTitleSuid: 'SUID-бинарники',
    auditTitleKeyFilePerms: 'Права на ключевые файлы',
    auditTitleWorldWritable: 'World-writable файлы в системных путях',
    auditTitleCron: 'Cron (текущий пользователь и системный)',
    auditTitleCronRoot: 'Cron root',
    // security-audit.ts — echo placeholders inside the fixed command list
    auditEchoNoFirewallUtils: '(утилиты фаервола не найдены)',
    auditEchoNoSsNetstat: '(нет ни ss, ни netstat)',
    auditEchoUnknownPkgMgr: 'неизвестный пакетный менеджер — проверка обновлений пропущена',
    auditEchoNotApt: 'не apt-система — проверка пропущена',
    auditEchoNoLastb: '(lastb недоступен)',
    // security-audit.ts — container issues and docker section strings
    auditIssuePrivileged: 'privileged-режим',
    auditIssueHostNetwork: 'сеть host',
    auditIssueDockerSock: 'монтирует /var/run/docker.sock',
    auditIssueRootMount: 'монтирует корень ФС (/)',
    auditDockerUnavailable: 'docker недоступен: {message}',
    auditNoContainers: 'контейнеров нет',
    auditInspectFailed: 'не удалось выполнить inspect ({message})',
    // security-audit.ts — report service strings
    auditSudoFailed: '> Привилегированный режим запрошен, но sudo не сработал — root-проверки пропущены.',
    auditSudoNotSet: '> sudo-пароль не задан — root-проверки пропущены (мягкая деградация).',
    auditSkippedNoPerms: 'пропущено: нет прав (нужен sudo)',
    auditExecError: 'ошибка выполнения: {message}',
    auditTruncatedTotal:
      '… (вывод обрезан по объёму: секция «{section}» и далее пропущены — запросите их отдельно через параметр sections)',
    auditTruncatedLines: '… (обрезано: показано {shown} из {total} строк)',
    auditTruncatedChars: '… (обрезано по объёму)',
  },
  en: {
    serverNotAttached:
      'Server "{name}" is not attached to this dialogue — call connect_server ' +
      'or ask the user to attach it.',
    unknownServer:
      'Unknown server "{name}". Servers attached to this dialogue: {available}. ' +
      'Full profile list — the list_servers tool.',
    profileNotFound: 'Profile {id} not found',
    homeServerDetach: 'The home server of the dialogue cannot be detached',
    stoppedByUser: 'The agent was stopped by the user.',
    rejectedByUser: 'The user rejected this action.',
    stepLimitReached: 'Step limit reached ({n}).',
    outputTruncated: '… (output truncated, showing {n} characters)',
    secretRedacted: '<secret hidden by the app, {n} chars>',
    emptyOutput: '(empty output)',
    commandFailed: 'The command failed.',
    serverNameMissing: 'Server name is missing (the server parameter).',
    unknownServerProfile: 'Unknown server "{name}". Available profiles: {available}.',
    noProfiles: '(no profiles)',
    serverAlreadyConnected: 'Server "{name}" is already attached to the dialogue.',
    serverConnected: 'Server "{name}" ({target}) is now attached to the dialogue.',
    searchNotConfigured: 'Web search is not configured on the application server (AI_SEARCH_API_BASE is empty).',
    searchCallsLimit: 'Search request limit reached ({n} per run).',
    rejectedPrefix: 'Rejected',
    fileTooLarge: 'The file is larger than 256 KB — use exec_readonly (head/tail).',
    memoryAbsent: '(No MEMORY.md yet — no notes from past sessions)',
    memoryEmptyContent: 'Empty MEMORY.md content — write cancelled.',
    memoryUpdated: 'MEMORY.md updated ({n} bytes).',
    dirEmpty: '(directory is empty)',
    fileWritten: 'File {path} written ({n} characters).',
    noContainers: '(no containers)',
    noLogs: '(no logs)',
    unknownDockerAction: 'Unknown docker_action action: {action}',
    done: 'Done.',
    unknownTool: 'Unknown tool: {name}',
    errorPrefix: 'Error',
    diskFilesUnavailable: 'largest files unavailable: {message}',
    apiTimeout: 'The AI API did not respond within 120 seconds (response timeout)',
    apiNetworkError: 'Network failure while calling the AI API: {detail}',
    apiResponseError: 'AI API error: {message}',
    apiErrorUnknown: 'The provider reported an error without details.',
    apiEmptyResponse: 'The AI API completed the response without text or tool calls. Retry the request.',
    apiIncompleteResponse: 'The AI API did not complete the response. Retry the request.',
    apiInterruptedResponse: 'The AI API stream ended before the response completed. Retry the request.',
    apiInvalidToolCall: 'The AI API returned an invalid tool call.',
    searchSummaryPrompt:
      'Search the internet for an answer to a Linux server administrator question and summarize it briefly in English. ' +
      'At the end list the sources (title and URL). Question: {query}',
    searchQueriesLabel: 'Search queries',
    searchSourcesLabel: 'Sources',
    searchNoResults: '(no search results)',
    searchEmptyQuery: 'Empty search query.',
    searchUnavailable:
      'Web search is unavailable: out of the box it works only with the DeepSeek provider (same key); ' +
      'for other providers set AI_SEARCH_API_BASE in the env.',
    searchTimeout: 'Search did not respond within 90 seconds (timeout)',
    searchApiError: 'Search error (API): {message}',
    searchError: 'Search error: {message}',
    duSize: 'Size of {path}: {bytes} B ({human})',
    duLargestDirs: 'Largest subdirectories:',
    duNoSubdirs: '(no subdirectories)',
    duBytes: '{bytes} B',
    duLargestFiles: 'Largest files:',
    duNoFiles: '(no files)',
    duUnreadable: '(unreadable: {n} directories — access permissions needed)',
    duTruncatedTotal: '(du output truncated — the total is incomplete)',
    memoryTruncated: '… (MEMORY.md is larger than {max} bytes, showing the beginning)',
    memoryTooLarge: 'MEMORY.md is too large: {bytes} bytes, limit is {max} bytes. Shorten the notes.',
    auditTitleSshd: 'sshd settings',
    auditTitleUid0: 'Users with UID 0',
    auditTitleLoginShell: 'Users with a login shell',
    auditTitleEmptyPasswords: 'Empty passwords (/etc/shadow)',
    auditTitleNopasswd: 'NOPASSWD in sudoers',
    auditTitleRootKeys: 'root keys (/root/.ssh/authorized_keys)',
    auditTitleFirewallUtils: 'Firewall utilities',
    auditTitleOpenPorts: 'Open ports',
    auditTitleFirewallStatus: 'Firewall status (ufw/iptables)',
    auditTitlePkgManager: 'Package manager',
    auditTitleUpdates: 'Available updates',
    auditTitleAutoUpdates: 'Automatic updates (unattended-upgrades)',
    auditTitleLastLogins: 'Recent logins (last)',
    auditTitleFailedLogins: 'Failed logins (lastb)',
    auditTitleFailedSsh: 'Failed SSH logins from the journal',
    auditTitleTopCpu: 'Top processes by CPU',
    auditTitleSuid: 'SUID binaries',
    auditTitleKeyFilePerms: 'Permissions on key files',
    auditTitleWorldWritable: 'World-writable files in system paths',
    auditTitleCron: 'Cron (current user and system)',
    auditTitleCronRoot: 'root cron',
    auditEchoNoFirewallUtils: '(no firewall utilities found)',
    auditEchoNoSsNetstat: '(neither ss nor netstat available)',
    auditEchoUnknownPkgMgr: 'unknown package manager — update check skipped',
    auditEchoNotApt: 'not an apt-based system — check skipped',
    auditEchoNoLastb: '(lastb unavailable)',
    auditIssuePrivileged: 'privileged mode',
    auditIssueHostNetwork: 'host network',
    auditIssueDockerSock: 'mounts /var/run/docker.sock',
    auditIssueRootMount: 'mounts the filesystem root (/)',
    auditDockerUnavailable: 'docker unavailable: {message}',
    auditNoContainers: 'no containers',
    auditInspectFailed: 'inspect failed ({message})',
    auditSudoFailed: '> Privileged mode was requested, but sudo failed — root checks skipped.',
    auditSudoNotSet: '> sudo password not provided — root checks skipped (graceful degradation).',
    auditSkippedNoPerms: 'skipped: insufficient permissions (sudo required)',
    auditExecError: 'execution error: {message}',
    auditTruncatedTotal:
      '… (output truncated by size: section "{section}" and the rest were skipped — request them separately via the sections parameter)',
    auditTruncatedLines: '… (truncated: showing {shown} of {total} lines)',
    auditTruncatedChars: '… (truncated by size)',
  },
} as const;

export type AiStringKey = keyof typeof AI_STRINGS.ru;

/**
 * An agent string by key and session lang with {name}-placeholder
 * interpolation. An unknown lang/key must not break the agent loop —
 * fall back to ru.
 */
export function aiStr(
  lang: PromptLang,
  key: AiStringKey,
  params?: Record<string, string | number>,
): string {
  const dict = AI_STRINGS[lang] ?? AI_STRINGS.ru;
  let text: string = dict[key] ?? AI_STRINGS.ru[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
