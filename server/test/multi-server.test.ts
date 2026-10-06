import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Profile } from '../src/types.js';
import type { Dialogue } from '../src/ai/dialogues.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-multi-server-'));
process.env.DATA_DIR = dataDir;

// security_audit touches SSH — stub it to check profile routing and per-server
// sudo passwords without real connections.
vi.mock('../src/services/security-audit.js', () => ({
  runSecurityAudit: vi.fn(
    async (profile: { id: string }, opts: { privileged?: boolean; sudoPassword?: string }) =>
      `audit profile=${profile.id} privileged=${String(opts.privileged === true)} sudo=${opts.sudoPassword ?? 'none'}`,
  ),
}));

const home: Profile = {
  id: 'home-srv',
  name: 'Домашний',
  host: 'home.local',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'home-secret',
  dockerCommand: 'docker',
};

const second: Profile = {
  id: 'second-srv',
  name: 'Second',
  host: 'second.local',
  port: 2222,
  username: 'ops',
  authType: 'password',
  password: 'second-secret',
  dockerCommand: 'docker',
};

// A dialogue in the old format — without the extraProfileIds field (backward compatibility).
const legacyDialogue = {
  id: 'legacy1',
  profileId: home.id,
  title: 'Старый диалог',
  messages: [],
  messageCount: 0,
  preview: '',
  createdAt: 1,
  updatedAt: 1,
};

// The stores are seeded before the first access: load() reads the files lazily.
writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: [home, second] }, null, 2));
writeFileSync(path.join(dataDir, 'ai-dialogues.json'), JSON.stringify({ dialogues: [legacyDialogue] }, null, 2));

const agentModule = await import('../src/ai/agent.js');
const dialogues = await import('../src/ai/dialogues.js');
const memory = await import('../src/ai/memory.js');

type ToolResult = { status: 'ok' | 'error'; output: string; truncated: boolean };
// runTool is private; unit tests call it directly (approve is checked in the
// runLoop, not inside runTool).
type SessionInternals = {
  runTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
};

function makeSession(dialogue?: Dialogue) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
  } as unknown as WebSocket;
  const session = new agentModule.AgentSession({ ...home }, ws, dialogue);
  return { session, sent };
}

function runTool(session: agentModule.AgentSession, name: string, args: Record<string, unknown> = {}) {
  return (session as unknown as SessionInternals).runTool(name, args);
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('resolveServer', () => {
  it('without a name resolves to the home profile', () => {
    const { session } = makeSession();
    expect(session.resolveServer()).toEqual({ profile: expect.objectContaining({ id: home.id }) });
    expect(session.resolveServer('   ')).toEqual({ profile: expect.objectContaining({ id: home.id }) });
  });

  it('matches a connected server name exactly and case-insensitively', () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    expect(session.resolveServer('Second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
    expect(session.resolveServer('second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
  });

  it('an unknown name — an error listing the connected servers', () => {
    const { session } = makeSession();
    const result = session.resolveServer('nope');
    expect('error' in result && result.error).toContain('Неизвестный сервер «nope»');
    expect('error' in result && result.error).toContain(home.name);
  });

  it('a known but unattached server — an error with a connect_server hint', () => {
    const { session } = makeSession();
    const result = session.resolveServer('Second');
    expect('error' in result && result.error).toContain('не подключён к диалогу');
    expect('error' in result && result.error).toContain('connect_server');
  });
});

describe('attach/detach via the session', () => {
  it('attach: the profile lands in the dialogue and in the servers event', () => {
    const { session, sent } = makeSession();
    expect(session.attachServerById(second.id)).toEqual({ ok: true });
    // A repeated attach is idempotent.
    expect(session.attachServerById(second.id)).toEqual({ ok: true });
    expect(dialogues.getDialogue(session.dialogueId)?.extraProfileIds).toEqual([second.id]);
    const events = sent.filter((m) => m.type === 'servers');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'servers',
      home: home.id,
      attached: [
        { id: home.id, name: home.name, host: home.host, username: home.username },
        { id: second.id, name: second.name, host: second.host, username: second.username },
      ],
    });
  });

  it('attaching a nonexistent profile — an error', () => {
    const { session } = makeSession();
    const result = session.attachServerById('ghost');
    expect(result.ok).toBe(false);
  });

  it('the home server cannot be detached', () => {
    const { session, sent } = makeSession();
    const result = session.detachServerById(home.id);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Домашний') });
    // Via a WS message the client receives an error frame.
    session.handleClientMessage({ type: 'detach_server', profileId: home.id });
    expect(sent.some((m) => m.type === 'error' && String(m.message).includes('Домашний'))).toBe(true);
  });

  it('detach removes the profile from the dialogue and sends servers', () => {
    const { session, sent } = makeSession();
    session.attachServerById(second.id);
    expect(session.detachServerById(second.id)).toEqual({ ok: true });
    expect(dialogues.getDialogue(session.dialogueId)?.extraProfileIds).toEqual([]);
    expect(session.resolveServer('Second')).toHaveProperty('error');
    expect(sent.filter((m) => m.type === 'servers')).toHaveLength(2);
  });
});

describe('connect_server', () => {
  it('connects the server, returns its memory and sends servers', async () => {
    memory.writeMemory(second.id, '# Заметки второго сервера');
    const { session, sent } = makeSession();
    const result = await runTool(session, 'connect_server', { server: 'Second' });
    expect(result.status).toBe('ok');
    expect(result.output).toContain(`Сервер «${second.name}»`);
    expect(result.output).toContain('подключён к диалогу');
    expect(result.output).toContain('Заметки второго сервера');
    expect(session.resolveServer('Second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
    expect(dialogues.getDialogue(session.dialogueId)?.extraProfileIds).toEqual([second.id]);
    expect(sent.some((m) => m.type === 'servers')).toBe(true);
  });

  it('an unknown name — an error listing all profiles', async () => {
    const { session } = makeSession();
    const result = await runTool(session, 'connect_server', { server: 'nope' });
    expect(result.status).toBe('error');
    expect(result.output).toContain(home.name);
    expect(result.output).toContain(second.name);
  });

  it('re-connecting (including the home one) — "already attached"', async () => {
    const { session } = makeSession();
    const first = await runTool(session, 'connect_server', { server: 'second' });
    expect(first.status).toBe('ok');
    const again = await runTool(session, 'connect_server', { server: 'Second' });
    expect(again.status).toBe('ok');
    expect(again.output).toContain('уже подключён');
    const homeResult = await runTool(session, 'connect_server', { server: home.name });
    expect(homeResult.output).toContain('уже подключён');
  });
});

describe('list_servers', () => {
  it('returns all profiles without secrets and with the connected flag', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    const result = await runTool(session, 'list_servers');
    expect(result.status).toBe('ok');
    expect(result.output).not.toContain('home-secret');
    expect(result.output).not.toContain('second-secret');
    const rows = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === home.name)).toMatchObject({
      host: home.host,
      port: home.port,
      username: home.username,
      connected: true,
    });
    expect(rows.find((r) => r.name === second.name)).toMatchObject({ connected: true });
    expect(rows.every((r) => !('password' in r) && !('keyPath' in r))).toBe(true);
  });
});

describe('memory routing by server', () => {
  it('read_memory reads the memory of the given server', async () => {
    memory.writeMemory(second.id, '# Память второго');
    const { session } = makeSession();
    session.attachServerById(second.id);
    const onSecond = await runTool(session, 'read_memory', { server: 'Second' });
    expect(onSecond.output).toContain('Память второго');
    const onHome = await runTool(session, 'read_memory');
    expect(onHome.output).toContain('MEMORY.md пока нет');
  });

  it('write_memory writes to the memory of the given server', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    const result = await runTool(session, 'write_memory', { server: 'second', content: 'новая запись' });
    expect(result.status).toBe('ok');
    expect(memory.readMemory(second.id)).toBe('новая запись');
  });

  it('a server resolve error — a regular tool_result, not an exception', async () => {
    const { session } = makeSession();
    const unknown = await runTool(session, 'read_memory', { server: 'nope' });
    expect(unknown.status).toBe('error');
    expect(unknown.output).toContain('Неизвестный сервер');
    const notAttached = await runTool(session, 'read_memory', { server: 'Second' });
    expect(notAttached.status).toBe('error');
    expect(notAttached.output).toContain('не подключён к диалогу');
  });
});

describe('sudo passwords per server', () => {
  it('one server password does not leak to another', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-home' });
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-second', profileId: second.id });

    const onHome = await runTool(session, 'security_audit');
    expect(onHome.output).toContain(`profile=${home.id}`);
    expect(onHome.output).toContain('privileged=true');
    expect(onHome.output).toContain('sudo=pw-home');

    const onSecond = await runTool(session, 'security_audit', { server: 'Second' });
    expect(onSecond.output).toContain(`profile=${second.id}`);
    expect(onSecond.output).toContain('sudo=pw-second');
  });

  it('stop() clears all passwords', async () => {
    const { session } = makeSession();
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-home' });
    session.stop();
    const result = await runTool(session, 'security_audit');
    expect(result.output).toContain('privileged=false');
    expect(result.output).toContain('sudo=none');
  });

  it('detaching a server removes its sudo password', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-second', profileId: second.id });
    session.detachServerById(second.id);
    session.attachServerById(second.id);
    const result = await runTool(session, 'security_audit', { server: 'Second' });
    expect(result.output).toContain('sudo=none');
  });
});

describe('dialogue backward compatibility', () => {
  it('old JSON without extraProfileIds reads, the field appears on attach', () => {
    const legacy = dialogues.getDialogue(legacyDialogue.id);
    expect(legacy).toBeDefined();
    expect(legacy?.extraProfileIds).toBeUndefined();
    dialogues.attachProfileToDialogue(legacyDialogue.id, second.id);
    expect(dialogues.getDialogue(legacyDialogue.id)?.extraProfileIds).toEqual([second.id]);
    dialogues.detachProfileFromDialogue(legacyDialogue.id, second.id);
  });

  it('the session picks up the dialogue extraProfileIds, skipping nonexistent ones', () => {
    dialogues.attachProfileToDialogue(legacyDialogue.id, second.id);
    dialogues.attachProfileToDialogue(legacyDialogue.id, 'ghost-id');
    const dialogue = dialogues.getDialogue(legacyDialogue.id);
    const { session } = makeSession(dialogue);
    expect(session.dialogueId).toBe(legacyDialogue.id);
    // A server from extraProfileIds is available immediately, without connect_server.
    expect(session.resolveServer('Second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
    dialogues.detachProfileFromDialogue(legacyDialogue.id, second.id);
    dialogues.detachProfileFromDialogue(legacyDialogue.id, 'ghost-id');
  });
});
