import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Per-profile agent memory: a MEMORY.md file stored in DATA_DIR/memory.
 * The agent uses it to keep important findings between sessions, so it
 * does not have to rediscover the same facts on every new dialogue.
 */

export const MEMORY_FILE_NAME = 'MEMORY.md';

/** Prompt/tool output cap — enough for useful notes, small enough for context. */
export const MAX_MEMORY_BYTES = 64 * 1024;

/**
 * File name for a profile is built from the profile id with a conservative
 * whitelist, so the resulting path can never escape DATA_DIR/memory.
 */
export function memoryPath(profileId: string): string {
  const slug = profileId.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return path.join(config.dataDir, 'memory', slug || 'default', MEMORY_FILE_NAME);
}

/**
 * Returns the memory file contents, or null when there is no memory yet.
 * Oversized files are truncated with a note, so a rogue huge file cannot
 * blow up the model context.
 */
export function readMemory(profileId: string): string | null {
  const file = memoryPath(profileId);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (Buffer.byteLength(content, 'utf8') <= MAX_MEMORY_BYTES) {
    return content;
  }
  const head = Buffer.from(content, 'utf8').subarray(0, MAX_MEMORY_BYTES).toString('utf8');
  return `${head}\n\n… (MEMORY.md больше ${MAX_MEMORY_BYTES} байт, показано начало)`;
}

/**
 * Replaces the whole MEMORY.md file (atomic tmp+rename, same pattern as the
 * profiles/dialogues stores). Callers must pass the full new content, keeping
 * existing notes — that contract is enforced at the prompt/tool level.
 */
export function writeMemory(profileId: string, content: string): { path: string; bytes: number } {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_MEMORY_BYTES) {
    throw new Error(
      `MEMORY.md слишком большой: ${bytes} байт, лимит ${MAX_MEMORY_BYTES} байт. Сократи заметки.`,
    );
  }
  const file = memoryPath(profileId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { path: file, bytes };
}

/**
 * Formatted block for the system prompt. Returns null when there is nothing
 * to inject, so the prompt stays identical for fresh profiles.
 */
export function memoryPromptBlock(profileId: string): string | null {
  const content = readMemory(profileId);
  if (content === null) {
    return null;
  }
  return `Память профиля (MEMORY.md — заметки из прошлых сессий):\n${content}`;
}
