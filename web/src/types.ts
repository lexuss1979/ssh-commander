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
