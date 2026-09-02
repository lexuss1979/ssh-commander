import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// ws/agent.ts тянет за собой ai/agent.ts (SSH/docker-слой) — импорт
// динамический, после выставления DATA_DIR на tmpdir (паттерн agent-usage).
const dataDir = mkdtempSync(path.join(tmpdir(), 'sc-agent-lang-'));
process.env.DATA_DIR = dataDir;

const { parseAgentLang } = await import('../src/ws/agent.js');

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
