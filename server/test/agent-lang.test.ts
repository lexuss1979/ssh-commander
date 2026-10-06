import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// ws/agent.ts pulls in ai/agent.ts (the SSH/docker layer) — the import is
// dynamic, after setting DATA_DIR to a tmpdir (the agent-usage pattern).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-lang-'));
process.env.DATA_DIR = dataDir;

const { parseAgentLang } = await import('../src/ws/agent.js');
const { buildToolDefs } = await import('../src/ai/tools.js');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('parseAgentLang (the agent WS connection query)', () => {
  it('en → en', () => {
    expect(parseAgentLang('en')).toBe('en');
  });

  it('ru, garbage and a missing parameter → the ru default (no crash)', () => {
    expect(parseAgentLang('ru')).toBe('ru');
    expect(parseAgentLang('EN')).toBe('ru');
    expect(parseAgentLang('fr')).toBe('ru');
    expect(parseAgentLang('')).toBe('ru');
    expect(parseAgentLang(null)).toBe('ru');
  });
});

describe('buildToolDefs — the tool description language', () => {
  it('en: not a single Cyrillic character in any schema', () => {
    const defs = buildToolDefs('en');
    expect(defs.length).toBeGreaterThan(0);
    expect(JSON.stringify(defs)).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it('ru: the descriptions are verbatim the former Russian ones', () => {
    const defs = buildToolDefs('ru');
    const byName = (n: string) => defs.find((d) => d.function.name === n);
    expect(byName('read_file')?.function.description).toBe('Прочитать текстовый файл на сервере (до 256 КБ).');
    expect(byName('exec')?.function.description).toBe(
      'Выполнить произвольную shell-команду на сервере (включая команды записи/удаления/управления). Требует подтверждения пользователя.',
    );
    expect(JSON.stringify(defs)).toContain('Имя профиля сервера из list_servers');
  });

  it('the tool and parameter names are identical in both languages', () => {
    const shape = (lang: 'ru' | 'en') =>
      buildToolDefs(lang).map((d) => ({
        name: d.function.name,
        params: Object.keys((d.function.parameters as { properties?: object }).properties ?? {}),
      }));
    expect(shape('en')).toEqual(shape('ru'));
  });
});
