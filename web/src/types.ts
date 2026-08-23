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
  keyPassphrase?: string;
  password?: string;
  dockerCommand?: string;
  note?: string;
  /** Закреплённые пути логов для быстрого доступа в FilesPage (эпик 14). */
  logPaths?: string[];
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
  /** Только при active=true. */
  message: string | null;
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

export interface DialogueSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** Дополнительные серверы, подключённые к диалогу (мульти-серверный режим). */
  extraProfileIds?: string[];
}

export interface Dialogue extends DialogueSummary {
  profileId: string;
  messages: DialogueMessage[];
}
