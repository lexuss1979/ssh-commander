/**
 * The mode of an "ask the agent from terminal/DB tab" request.
 * 'send' — send the text as is (the DB tab's "Ask agent" button assembles
 * the full prompt with engine and schema itself).
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
  /** Secrets are never returned (server: toSafeProfile) — only the "is set" fact.
   * An empty form field when editing = "keep". */
  hasPassword?: boolean;
  hasKeyPassphrase?: boolean;
  dockerCommand?: string;
  note?: string;
  /** Pinned log paths for quick access in FilesPage (epic 14). */
  logPaths?: string[];
}

/**
 * An internal terminal tab (epic 15). id is stable for the tab's whole life
 * (a monotonic counter in localStorage) and doubles as the session key on
 * the server; container — a shell inside a docker container instead of the
 * system one.
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

// Threshold alerts (epic 20) — mirrors of the server field names.
export type AlertKind = 'server-down' | 'disk' | 'memory' | 'load';

export type AlertSeverity = 'crit' | 'warn';

/**
 * The state of one rule on a polling tick: inactive ones too — client-side
 * hysteresis must see the value below the threshold, not only the fact of
 * firing.
 */
export interface AlertRuleState {
  profileId: string;
  kind: AlertKind;
  /** Mount point (kind='disk'). */
  subject?: string;
  severity: AlertSeverity;
  active: boolean;
  /** server-down: 0/1; disk/memory: %; load: load1/cores (2 decimals). */
  value: number;
  /** server-down: 1; disk/mem: %; load: per core. */
  threshold: number;
  /** Text of the current value — always filled (a fresh figure for an alert in the hysteresis zone). */
  message: string;
}

export interface AlertsResponse {
  timestamp: number;
  /** Effective thresholds (echo). */
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

/** Cumulative AI cost totals for a dialogue (enrichment / the usage WS event).
 * costUsd is incomplete when unpricedCalls > 0 (some calls have no model price). */
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
  /** Extra servers attached to the dialogue (multi-server mode). */
  extraProfileIds?: string[];
  /** Dialogue costs; null — no usage records. */
  usage?: DialogueUsageTotals | null;
}

export interface Dialogue extends DialogueSummary {
  profileId: string;
  messages: DialogueMessage[];
}
