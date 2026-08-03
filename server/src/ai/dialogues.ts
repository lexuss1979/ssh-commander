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
  title: z.string(),
  messages: z.array(messageSchema).default([]),
  messageCount: z.number().int().min(0),
  preview: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storeSchema = z.object({ dialogues: z.array(dialogueSchema).default([]) });

let cache: Dialogue[] | null = null;

function storePath(): string {
  return path.join(config.dataDir, 'ai-dialogues.json');
}

function load(): Dialogue[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).dialogues;
    } catch {
      cache = [];
    }
  }
  return cache;
}

function persist(list: Dialogue[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dialogues: list }, null, 2));
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
