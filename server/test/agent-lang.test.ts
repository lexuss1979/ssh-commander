import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// ws/agent.ts тянет за собой ai/agent.ts (SSH/docker-слой) — импорт
// динамический, после выставления DATA_DIR на tmpdir (паттерн agent-usage).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-lang-'));
process.env.DATA_DIR = dataDir;

const { parseAgentLang } = await import('../src/ws/agent.js');
const { buildToolDefs } = await import('../src/ai/tools.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parseAgentLang (query WS-подключения агента)', () => {
  it('en → en', () => {
    expect(parseAgentLang('en')).toBe('en');
  });

  it('ru, мусор и отсутствие параметра → дефолт ru (не валимся)', () => {
    expect(parseAgentLang('ru')).toBe('ru');
    expect(parseAgentLang('EN')).toBe('ru');
    expect(parseAgentLang('fr')).toBe('ru');
    expect(parseAgentLang('')).toBe('ru');
    expect(parseAgentLang(null)).toBe('ru');
  });
});

describe('buildToolDefs — язык описаний инструментов', () => {
  it('en: ни одного кириллического символа во всех схемах', () => {
    const defs = buildToolDefs('en');
    expect(defs.length).toBeGreaterThan(0);
    expect(JSON.stringify(defs)).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it('ru: описания дословно прежние русские', () => {
    const defs = buildToolDefs('ru');
    const byName = (n: string) => defs.find((d) => d.function.name === n);
    expect(byName('read_file')?.function.description).toBe('Прочитать текстовый файл на сервере (до 256 КБ).');
    expect(byName('exec')?.function.description).toBe(
      'Выполнить произвольную shell-команду на сервере (включая команды записи/удаления/управления). Требует подтверждения пользователя.',
    );
    expect(JSON.stringify(defs)).toContain('Имя профиля сервера из list_servers');
  });

  it('имена инструментов и параметров одинаковы в обоих языках', () => {
    const shape = (lang: 'ru' | 'en') =>
      buildToolDefs(lang).map((d) => ({
        name: d.function.name,
        params: Object.keys((d.function.parameters as { properties?: object }).properties ?? {}),
      }));
    expect(shape('en')).toEqual(shape('ru'));
  });
});
