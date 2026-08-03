import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import type { Profile } from './types.js';

const profileInputSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, 'Username is required'),
  authType: z.enum(['key', 'password']).default('password'),
  keyPath: z.string().optional(),
  password: z.string().optional(),
  dockerCommand: z.string().min(1).default('docker'),
  note: z.string().optional(),
});

const profileSchema = profileInputSchema.extend({ id: z.string().min(1) });
const storeSchema = z.object({ profiles: z.array(profileSchema).default([]) });

let cache: Profile[] | null = null;

function storePath(): string {
  return path.join(config.dataDir, 'profiles.json');
}

export function listProfiles(): Profile[] {
  if (!cache) {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      cache = storeSchema.parse(JSON.parse(raw)).profiles;
    } catch {
      cache = [];
    }
  }
  return cache.map((p) => ({ ...p }));
}

function persist(list: Profile[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ profiles: list }, null, 2));
  fs.renameSync(tmp, storePath());
  cache = list.map((p) => ({ ...p }));
}

function validate(input: unknown): Profile {
  const data = profileInputSchema.parse(input);
  if (data.authType === 'key' && !data.keyPath) {
    throw new Error('keyPath is required for key auth');
  }
  if (data.authType === 'password' && !data.password) {
    throw new Error('password is required for password auth');
  }
  return { ...data, id: crypto.randomUUID().slice(0, 8) };
}

export function getProfile(id: string): Profile | undefined {
  return listProfiles().find((p) => p.id === id);
}

export function requireProfile(id: string): Profile {
  const profile = getProfile(id);
  if (!profile) {
    throw new Error(`Profile ${id} not found`);
  }
  return profile;
}

export function createProfile(input: unknown): Profile {
  const profile = validate(input);
  const list = listProfiles();
  list.push(profile);
  persist(list);
  return { ...profile };
}

export function updateProfile(id: string, input: unknown): Profile {
  const list = listProfiles();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error(`Profile ${id} not found`);
  }
  const data = profileInputSchema.parse(input);
  if (data.authType === 'key' && !data.keyPath) {
    throw new Error('keyPath is required for key auth');
  }
  if (data.authType === 'password' && !data.password) {
    throw new Error('password is required for password auth');
  }
  const updated: Profile = { ...data, id };
  list[idx] = updated;
  persist(list);
  return { ...updated };
}

export function deleteProfile(id: string): void {
  const list = listProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) {
    throw new Error(`Profile ${id} not found`);
  }
  persist(next);
}

