import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-dialogues-'));
process.env.DATA_DIR = dataDir;

const store = await import('../src/ai/dialogues.js');

function uniqueProfile(): string {
  return `prof-${Math.random().toString(36).slice(2, 10)}`;
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('dialogues store', () => {
  it('creates and lists dialogues per profile', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    expect(d.id).toBeTruthy();
    expect(d.title).toBe('Новый диалог');
    expect(d.messages).toEqual([]);
    expect(store.listDialogues(profileId)).toHaveLength(1);
    expect(store.listDialogues('other-profile')).toHaveLength(0);
    store.deleteDialogue(d.id);
  });

  it('saves messages and derives title/preview', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    store.saveDialogueMessages(d.id, [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '  Проверь   nginx   ' },
    ]);
    const got = store.getDialogue(d.id);
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0].role).toBe('user');
    expect(got?.title).toBe('Проверь nginx');
    expect(got?.messageCount).toBe(1);
    expect(got?.preview).toContain('Проверь nginx');
    expect(store.listDialogues(profileId)[0].title).toBe('Проверь nginx');
    store.deleteDialogue(d.id);
  });

  it('keeps the title from the first user message', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    store.saveDialogueMessages(d.id, [{ role: 'user', content: 'первый вопрос' }]);
    store.saveDialogueMessages(d.id, [{ role: 'user', content: 'второй вопрос' }]);
    expect(store.getDialogue(d.id)?.title).toBe('первый вопрос');
    store.deleteDialogue(d.id);
  });

  it('persists assistant tool calls and tool results', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    store.saveDialogueMessages(d.id, [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_readonly', arguments: '{"command":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'exec_readonly', content: 'file.txt' },
    ]);
    const got = store.getDialogue(d.id);
    expect(got?.messages).toHaveLength(2);
    expect(got?.messages[0].tool_calls?.[0].function.arguments).toBe('{"command":"ls"}');
    expect(got?.messages[1].role).toBe('tool');
    expect(got?.messageCount).toBe(2);
    store.deleteDialogue(d.id);
  });

  it('deletes dialogues and errors on missing id', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    store.deleteDialogue(d.id);
    expect(store.getDialogue(d.id)).toBeUndefined();
    expect(store.listDialogues(profileId)).toHaveLength(0);
    expect(() => store.deleteDialogue(d.id)).toThrow();
  });

  it('writes the store file atomically under DATA_DIR', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    const raw = JSON.parse(readFileSync(path.join(dataDir, 'ai-dialogues.json'), 'utf8'));
    expect(Array.isArray(raw.dialogues)).toBe(true);
    expect(raw.dialogues.some((x: { id: string }) => x.id === d.id)).toBe(true);
    store.deleteDialogue(d.id);
  });

  it('attaches and detaches extra profiles (round-trip)', () => {
    const profileId = uniqueProfile();
    const extraA = uniqueProfile();
    const extraB = uniqueProfile();
    const d = store.createDialogue(profileId);
    expect(d.extraProfileIds).toBeUndefined();

    store.attachProfileToDialogue(d.id, extraA);
    store.attachProfileToDialogue(d.id, extraB);
    // Повторное подключение идемпотентно, домашний не дублируется в extra.
    store.attachProfileToDialogue(d.id, extraA);
    store.attachProfileToDialogue(d.id, profileId);
    let got = store.getDialogue(d.id);
    expect(got?.extraProfileIds).toEqual([extraA, extraB]);
    // Сводка списка тоже отдаёт extraProfileIds (бейдж «+N серверов»).
    expect(store.listDialogues(profileId)[0].extraProfileIds).toEqual([extraA, extraB]);
    // Сохранение сообщений поле не затирает.
    store.saveDialogueMessages(d.id, [{ role: 'user', content: 'вопрос' }]);
    expect(store.getDialogue(d.id)?.extraProfileIds).toEqual([extraA, extraB]);

    store.detachProfileFromDialogue(d.id, extraA);
    got = store.getDialogue(d.id);
    expect(got?.extraProfileIds).toEqual([extraB]);
    // Отцепление отсутствующего — no-op, ошибки нет.
    store.detachProfileFromDialogue(d.id, extraA);
    expect(store.getDialogue(d.id)?.extraProfileIds).toEqual([extraB]);
    store.deleteDialogue(d.id);
  });

  it('refuses to detach the home profile', () => {
    const profileId = uniqueProfile();
    const d = store.createDialogue(profileId);
    expect(() => store.detachProfileFromDialogue(d.id, profileId)).toThrow(/домашний/i);
    expect(() => store.attachProfileToDialogue('missing-dialogue', uniqueProfile())).toThrow();
    expect(() => store.detachProfileFromDialogue('missing-dialogue', uniqueProfile())).toThrow();
    store.deleteDialogue(d.id);
  });
});
