import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Profile } from '../src/types.js';
import type { Dialogue } from '../src/ai/dialogues.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-multi-server-'));
process.env.DATA_DIR = dataDir;

// security_audit дёргает SSH — подменяем, чтобы проверить маршрутизацию
// профиля и per-server sudo-паролей без реальных подключений.
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

// Диалог в старом формате — без поля extraProfileIds (обратная совместимость).
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

// Хранилища сидируются до первого обращения: load() читает файлы лениво.
writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: [home, second] }, null, 2));
writeFileSync(path.join(dataDir, 'ai-dialogues.json'), JSON.stringify({ dialogues: [legacyDialogue] }, null, 2));

const agentModule = await import('../src/ai/agent.js');
const dialogues = await import('../src/ai/dialogues.js');
const memory = await import('../src/ai/memory.js');

type ToolResult = { status: 'ok' | 'error'; output: string; truncated: boolean };
// runTool — приватный; в unit-тестах вызываем напрямую (approve проверяется
// в цикле runLoop, а не внутри runTool).
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
  it('без имени резолвится в домашний профиль', () => {
    const { session } = makeSession();
    expect(session.resolveServer()).toEqual({ profile: expect.objectContaining({ id: home.id }) });
    expect(session.resolveServer('   ')).toEqual({ profile: expect.objectContaining({ id: home.id }) });
  });

  it('матчит имя подключённого сервера точно и без учёта регистра', () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    expect(session.resolveServer('Second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
    expect(session.resolveServer('second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
  });

  it('неизвестное имя — ошибка с перечнем подключённых серверов', () => {
    const { session } = makeSession();
    const result = session.resolveServer('nope');
    expect('error' in result && result.error).toContain('Неизвестный сервер «nope»');
    expect('error' in result && result.error).toContain(home.name);
  });

  it('известный, но не подключённый — ошибка с подсказкой про connect_server', () => {
    const { session } = makeSession();
    const result = session.resolveServer('Second');
    expect('error' in result && result.error).toContain('не подключён к диалогу');
    expect('error' in result && result.error).toContain('connect_server');
  });
});

describe('attach/detach сервера через сессию', () => {
  it('attach: профиль попадает в диалог и в событие servers', () => {
    const { session, sent } = makeSession();
    expect(session.attachServerById(second.id)).toEqual({ ok: true });
    // Повторный attach — идемпотентно.
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

  it('attach несуществующего профиля — ошибка', () => {
    const { session } = makeSession();
    const result = session.attachServerById('ghost');
    expect(result.ok).toBe(false);
  });

  it('домашний сервер отцепить нельзя', () => {
    const { session, sent } = makeSession();
    const result = session.detachServerById(home.id);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Домашний') });
    // Через WS-сообщение клиент получает error-фрейм.
    session.handleClientMessage({ type: 'detach_server', profileId: home.id });
    expect(sent.some((m) => m.type === 'error' && String(m.message).includes('Домашний'))).toBe(true);
  });

  it('detach убирает профиль из диалога и шлёт servers', () => {
    const { session, sent } = makeSession();
    session.attachServerById(second.id);
    expect(session.detachServerById(second.id)).toEqual({ ok: true });
    expect(dialogues.getDialogue(session.dialogueId)?.extraProfileIds).toEqual([]);
    expect(session.resolveServer('Second')).toHaveProperty('error');
    expect(sent.filter((m) => m.type === 'servers')).toHaveLength(2);
  });
});

describe('connect_server', () => {
  it('подключает сервер, возвращает его память и шлёт servers', async () => {
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

  it('неизвестное имя — ошибка с перечнем всех профилей', async () => {
    const { session } = makeSession();
    const result = await runTool(session, 'connect_server', { server: 'nope' });
    expect(result.status).toBe('error');
    expect(result.output).toContain(home.name);
    expect(result.output).toContain(second.name);
  });

  it('повторное подключение (и домашнего) — «уже подключён»', async () => {
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
  it('возвращает все профили без секретов и с флагом connected', async () => {
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

describe('маршрутизация памяти по server', () => {
  it('read_memory читает память указанного сервера', async () => {
    memory.writeMemory(second.id, '# Память второго');
    const { session } = makeSession();
    session.attachServerById(second.id);
    const onSecond = await runTool(session, 'read_memory', { server: 'Second' });
    expect(onSecond.output).toContain('Память второго');
    const onHome = await runTool(session, 'read_memory');
    expect(onHome.output).toContain('MEMORY.md пока нет');
  });

  it('write_memory пишет в память указанного сервера', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    const result = await runTool(session, 'write_memory', { server: 'second', content: 'новая запись' });
    expect(result.status).toBe('ok');
    expect(memory.readMemory(second.id)).toBe('новая запись');
  });

  it('ошибка резолва сервера — обычный tool_result, не исключение', async () => {
    const { session } = makeSession();
    const unknown = await runTool(session, 'read_memory', { server: 'nope' });
    expect(unknown.status).toBe('error');
    expect(unknown.output).toContain('Неизвестный сервер');
    const notAttached = await runTool(session, 'read_memory', { server: 'Second' });
    expect(notAttached.status).toBe('error');
    expect(notAttached.output).toContain('не подключён к диалогу');
  });
});

describe('sudo-пароли по серверам', () => {
  it('пароль одного сервера не течёт на другой', async () => {
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

  it('stop() очищает все пароли', async () => {
    const { session } = makeSession();
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-home' });
    session.stop();
    const result = await runTool(session, 'security_audit');
    expect(result.output).toContain('privileged=false');
    expect(result.output).toContain('sudo=none');
  });

  it('detach сервера удаляет его sudo-пароль', async () => {
    const { session } = makeSession();
    session.attachServerById(second.id);
    session.handleClientMessage({ type: 'sudo_credentials', password: 'pw-second', profileId: second.id });
    session.detachServerById(second.id);
    session.attachServerById(second.id);
    const result = await runTool(session, 'security_audit', { server: 'Second' });
    expect(result.output).toContain('sudo=none');
  });
});

describe('обратная совместимость диалогов', () => {
  it('старый JSON без extraProfileIds читается, поле появляется при attach', () => {
    const legacy = dialogues.getDialogue(legacyDialogue.id);
    expect(legacy).toBeDefined();
    expect(legacy?.extraProfileIds).toBeUndefined();
    dialogues.attachProfileToDialogue(legacyDialogue.id, second.id);
    expect(dialogues.getDialogue(legacyDialogue.id)?.extraProfileIds).toEqual([second.id]);
    dialogues.detachProfileFromDialogue(legacyDialogue.id, second.id);
  });

  it('сессия подгружает extraProfileIds диалога, несуществующие пропускает', () => {
    dialogues.attachProfileToDialogue(legacyDialogue.id, second.id);
    dialogues.attachProfileToDialogue(legacyDialogue.id, 'ghost-id');
    const dialogue = dialogues.getDialogue(legacyDialogue.id);
    const { session } = makeSession(dialogue);
    expect(session.dialogueId).toBe(legacyDialogue.id);
    // Сервер из extraProfileIds доступен сразу, без connect_server.
    expect(session.resolveServer('Second')).toEqual({ profile: expect.objectContaining({ id: second.id }) });
    dialogues.detachProfileFromDialogue(legacyDialogue.id, second.id);
    dialogues.detachProfileFromDialogue(legacyDialogue.id, 'ghost-id');
  });
});
