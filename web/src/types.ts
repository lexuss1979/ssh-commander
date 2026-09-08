/**
 * Режим запроса «из терминала/вкладки БД в чат агента».
 * 'send' — отправить текст как есть (кнопка «Спросить агента» вкладки БД
 * собирает полный промпт с движком и схемой сама).
 */
export type AgentAskMode = 'explain' | 'new-dialogue' | 'prefill' | 'send';

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'key' | 'password';
  keyPath?: string;
  /** Секреты наружу не отдаются (server: toSafeProfile) — только факт «задан».
   * Пустое поле формы при правке = «не менять». */
  hasPassword?: boolean;
  hasKeyPassphrase?: boolean;
  dockerCommand?: string;
  note?: string;
  /** Закреплённые пути логов для быстрого доступа в FilesPage (эпик 14). */
  logPaths?: string[];
}

/**
 * Внутренняя вкладка терминала (эпик 15). id — стабильный на всю жизнь
 * вкладки (монотонный счётчик в localStorage), им же ключ сессии на сервере;
 * container — shell внутри docker-контейнера вместо системного.
 */
export interface TerminalTab {
  id: number;
  container?: { id: string; name: string };
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
  mode: string;
}

export interface FileListResponse {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

export interface FileSearchResult {
  path: string;
  line?: number;
  preview?: string;
}

export interface DockerEntity {
  [key: string]: string | number | boolean | null | undefined;
}

// Алерты по порогам (эпик 20) — зеркала серверных имён полей.
export type AlertKind = 'server-down' | 'disk' | 'memory' | 'load';

export type AlertSeverity = 'crit' | 'warn';

/**
 * Состояние одного правила на тик опроса: и неактивные тоже — гистерезис
 * на клиенте должен видеть значение ниже порога, а не только факт срабатывания.
 */
export interface AlertRuleState {
  profileId: string;
  kind: AlertKind;
  /** Точка монтирования (kind='disk'). */
  subject?: string;
  severity: AlertSeverity;
  active: boolean;
  /** server-down: 0/1; disk/memory: %; load: load1/cores (2 знака). */
  value: number;
  /** server-down: 1; disk/mem: %; load: на ядро. */
  threshold: number;
  /** Текст о текущем значении — заполняется всегда (свежая цифра у алерта в зоне гистерезиса). */
  message: string;
}

export interface AlertsResponse {
  timestamp: number;
  /** Эффективные пороги (echo). */
  thresholds: { diskPercent: number; memPercent: number; loadPerCore: number };
  rules: AlertRuleState[];
}

export interface DialogueMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type?: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** Кумулятивные итоги расходов AI по диалогу (enrichment / WS-событие usage).
 * costUsd неполна при unpricedCalls > 0 (часть вызовов без цены модели). */
export interface DialogueUsageTotals {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  unpricedCalls: number;
}

export interface DialogueSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** Дополнительные серверы, подключённые к диалогу (мульти-серверный режим). */
  extraProfileIds?: string[];
  /** Расходы диалога; null — записей usage нет. */
  usage?: DialogueUsageTotals | null;
}

export interface Dialogue extends DialogueSummary {
  profileId: string;
  messages: DialogueMessage[];
}
