import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import type { ChatMessage } from './client.js';
import { sanitizeMessages } from './messages.js';

export interface Dialogue {
  id: string;
  profileId: string;
  // Дополнительные профили, подключённые к мульти-серверному диалогу
  // (profileId — домашний, он подключён всегда и сюда не входит).
  extraProfileIds?: string[];
  title: string;
  messages: ChatMessage[];
  messageCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export interface DialogueSummary {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  extraProfileIds?: string[];
}

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const dialogueSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  // Опционально: старые ai-dialogues.json без поля остаются валидными.
  extraProfileIds: z.array(z.string()).optional(),
  title: z.string(),
  messages: z.array(messageSchema).default([]),
  messageCount: z.number().int().min(0),
  preview: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storeSchema = z.object({ dialogues: z.array(dialogueSchema).default([]) });

let cache: Dialogue[] | null = null;
// Set when the store file failed to parse: the broken file is moved aside
// (kept for recovery) and persist() refuses to run until a restart with a
// fixed file, so a corrupt store is never silently overwritten.
let corrupt = false;

function storePath(): string {
  return path.join(config.dataDir, 'ai-dialogues.json');
}

function load(): Dialogue[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).dialogues;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        cache = [];
      } else {
        const backup = `${storePath()}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(storePath(), backup);
        } catch {
          /* keep the original in place */
        }
        console.warn(`dialogues store is unreadable, moved to ${backup}; refusing to overwrite it until restart:`, err);
        corrupt = true;
        cache = [];
      }
    }
  }
  return cache;
}

function persist(list: Dialogue[]): void {
  if (corrupt) {
    throw new Error('dialogues store was corrupt at startup; refusing to overwrite it — fix or remove the *.corrupt-* file and restart');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  // 0600: в диалогах оседает всё, что агент прочитал на серверах.
  fs.writeFileSync(tmp, JSON.stringify({ dialogues: list }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
  cache = list.map((d) => ({ ...d, messages: [...d.messages] }));
}

function copy(d: Dialogue): Dialogue {
  return { ...d, messages: [...d.messages] };
}

export function listDialogues(profileId: string): DialogueSummary[] {
  return load()
    .filter((d) => d.profileId === profileId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((d) => ({
      id: d.id,
      title: d.title,
      preview: d.preview,
      messageCount: d.messageCount,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      extraProfileIds: d.extraProfileIds,
    }));
}

export function getDialogue(id: string): Dialogue | undefined {
  const found = load().find((d) => d.id === id);
  return found ? copy(found) : undefined;
}

export function createDialogue(profileId: string): Dialogue {
  const now = Date.now();
  const dialogue: Dialogue = {
    id: crypto.randomUUID().slice(0, 8),
    profileId,
    title: 'Новый диалог',
    messages: [],
    messageCount: 0,
    preview: '',
    createdAt: now,
    updatedAt: now,
  };
  const list = load();
  list.push(dialogue);
  persist(list);
  return copy(dialogue);
}

export function deleteDialogue(id: string): void {
  const list = load();
  const next = list.filter((d) => d.id !== id);
  if (next.length === list.length) {
    throw new Error(`Dialogue ${id} not found`);
  }
  persist(next);
}

/**
 * Attaches an extra profile to a multi-server dialogue. Idempotent: the home
 * profile and already attached ids are left as-is. The caller checks that the
 * profile exists — the store itself does not import the profiles module.
 */
export function attachProfileToDialogue(dialogueId: string, profileId: string): Dialogue {
  const list = load();
  const idx = list.findIndex((d) => d.id === dialogueId);
  if (idx < 0) {
    throw new Error(`Dialogue ${dialogueId} not found`);
  }
  const current = list[idx];
  if (profileId === current.profileId || current.extraProfileIds?.includes(profileId)) {
    return copy(current);
  }
  list[idx] = {
    ...current,
    extraProfileIds: [...(current.extraProfileIds ?? []), profileId],
    updatedAt: Date.now(),
  };
  persist(list);
  return copy(list[idx]);
}

/**
 * Detaches an extra profile from a dialogue. The home profile can never be
 * detached — the dialogue belongs to it. Detaching a missing id is a no-op.
 */
export function detachProfileFromDialogue(dialogueId: string, profileId: string): Dialogue {
  const list = load();
  const idx = list.findIndex((d) => d.id === dialogueId);
  if (idx < 0) {
    throw new Error(`Dialogue ${dialogueId} not found`);
  }
  const current = list[idx];
  if (profileId === current.profileId) {
    throw new Error('Домашний профиль диалога отцепить нельзя');
  }
  const extra = current.extraProfileIds ?? [];
  if (!extra.includes(profileId)) {
    return copy(current);
  }
  list[idx] = {
    ...current,
    extraProfileIds: extra.filter((id) => id !== profileId),
    updatedAt: Date.now(),
  };
  persist(list);
  return copy(list[idx]);
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Persists the given OpenAI messages (system role is stripped before saving)
 * and derives the title/preview. The title is fixed from the first user
 * message unless the dialogue is still untitled.
 */
export function saveDialogueMessages(id: string, messages: ChatMessage[]): Dialogue {
  const list = load();
  const idx = list.findIndex((d) => d.id === id);
  if (idx < 0) {
    throw new Error(`Dialogue ${id} not found`);
  }
  const stored = sanitizeMessages(messages.filter((m) => m.role !== 'system'));
  const firstUser = stored.find((m) => m.role === 'user');
  const lastVisible = [...stored].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  const current = list[idx];
  const title =
    current.title !== 'Новый диалог' || !firstUser?.content
      ? current.title
      : oneLine(firstUser.content, 60) || 'Новый диалог';
  const preview = lastVisible?.content ? oneLine(lastVisible.content, 120) : current.preview;
  list[idx] = {
    ...current,
    title,
    messages: stored,
    messageCount: stored.length,
    preview,
    updatedAt: Date.now(),
  };
  persist(list);
  return copy(list[idx]);
}
