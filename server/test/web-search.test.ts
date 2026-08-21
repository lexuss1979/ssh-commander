import { describe, expect, it } from 'vitest';
import {
  MAX_USES_PER_CALL,
  buildSearchBody,
  formatSearchOutput,
  parseSearchResponse,
  sanitizeQuery,
} from '../src/ai/web-search.js';
import { getToolDefs, toolDefs } from '../src/ai/tools.js';

// Фикстура по мотивам реального ответа api.deepseek.com/anthropic
// (модель deepseek-v4-flash, серверный инструмент web_search_20260209).
const realResponse = {
  id: '8880fe3c-4664',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4-flash',
  content: [
    { type: 'thinking', thinking: 'Нужно поискать в интернете.', signature: 'sig' },
    {
      type: 'server_tool_use',
      id: 'call_00_3vyC',
      name: 'web_search',
      input: { query: 'latest stable Node.js LTS version 2025' },
      caller: { type: 'direct' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'call_00_3vyC',
      content: [
        {
          type: 'web_search_result',
          title: 'Releases · nodejs/node',
          url: 'https://github.com/nodejs/node/releases',
          encrypted_content: 'n0VrdstntCdrJUXwBR4m5sjypV4yv5XLhhSSPQ3PiInXlLzsb',
          page_age: null,
        },
        {
          type: 'web_search_result',
          title: 'Node.js default version is now 24.x',
          url: 'https://devcenter2.assets.heroku.com/changelog-items/3502',
          encrypted_content: 'yVItxkHOuKE1SU+8AVLcDeYliR8uro1h1qKnoWS32g9tQR',
          page_age: null,
        },
      ],
    },
    {
      type: 'server_tool_use',
      id: 'call_01_9ab',
      name: 'web_search',
      input: { query: 'nodejs.org/en/about/previous-releases' },
      caller: { type: 'direct' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'call_01_9ab',
      content: [
        {
          type: 'web_search_result',
          title: 'Previous Releases | Node.js',
          url: 'https://nodejs.org/en/about/previous-releases',
          encrypted_content: 'abc',
          page_age: '2025-01-01',
        },
      ],
    },
    { type: 'text', text: 'Последняя LTS-версия Node.js — 24.x («Krypton»).' },
  ],
  usage: { input_tokens: 8641, output_tokens: 462, server_tool_use: { web_search_requests: 2 } },
};

describe('buildSearchBody', () => {
  it('собирает Anthropic-запрос с серверным web_search инструментом', () => {
    const body = buildSearchBody('версия nginx', { model: 'deepseek-v4-flash', maxUses: 3 });
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBeGreaterThan(0);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('версия nginx');
    const tools = body.tools as Array<{ type: string; name: string; max_uses: number }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('web_search_20260209');
    expect(tools[0].max_uses).toBe(3);
  });
});

describe('sanitizeQuery', () => {
  it('схлопывает пробелы и обрезает по длине', () => {
    expect(sanitizeQuery('  как   настроить\nfail2ban  ')).toBe('как настроить fail2ban');
    expect(sanitizeQuery(null)).toBe('');
    expect(sanitizeQuery(undefined)).toBe('');
    expect(sanitizeQuery('x'.repeat(1000))).toHaveLength(400);
  });
});

describe('parseSearchResponse', () => {
  it('извлекает текст, поисковые запросы и источники, игнорируя encrypted_content и thinking', () => {
    const parsed = parseSearchResponse(realResponse);
    expect(parsed.text).toBe('Последняя LTS-версия Node.js — 24.x («Krypton»).');
    expect(parsed.queries).toEqual([
      'latest stable Node.js LTS version 2025',
      'nodejs.org/en/about/previous-releases',
    ]);
    expect(parsed.sources).toHaveLength(3);
    expect(parsed.sources[0]).toEqual({
      title: 'Releases · nodejs/node',
      url: 'https://github.com/nodejs/node/releases',
    });
    expect(JSON.stringify(parsed)).not.toContain('encrypted_content');
    expect(JSON.stringify(parsed)).not.toContain('Нужно поискать');
  });

  it('ответ без поиска — пустые queries/sources', () => {
    const parsed = parseSearchResponse({ content: [{ type: 'text', text: 'ответ' }] });
    expect(parsed).toEqual({ text: 'ответ', queries: [], sources: [] });
  });

  it('полностью пустой ответ не падает', () => {
    expect(parseSearchResponse({})).toEqual({ text: '', queries: [], sources: [] });
    expect(parseSearchResponse({ content: null })).toEqual({ text: '', queries: [], sources: [] });
  });

  it('источник без title всё равно попадает в список (по URL)', () => {
    const parsed = parseSearchResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://example.com' }],
        },
      ],
    });
    expect(parsed.sources).toEqual([{ title: '', url: 'https://example.com' }]);
  });

  it('usage пробрасывается: input/output токены + число поисковых запросов', () => {
    const parsed = parseSearchResponse(realResponse);
    expect(parsed.usage).toEqual({
      promptTokens: 8641,
      completionTokens: 462,
      searchRequests: 2,
    });
  });

  it('без usage в ответе — usage undefined', () => {
    expect(parseSearchResponse({ content: [{ type: 'text', text: 'ответ' }] }).usage).toBeUndefined();
    expect(parseSearchResponse({}).usage).toBeUndefined();
    expect(
      parseSearchResponse({ usage: { input_tokens: 'x', output_tokens: -1 } }).usage,
    ).toBeUndefined();
  });
});

describe('formatSearchOutput', () => {
  it('склеивает текст, запросы и нумерованные источники', () => {
    const out = formatSearchOutput(parseSearchResponse(realResponse));
    expect(out).toContain('Последняя LTS-версия Node.js');
    expect(out).toContain('Запросы поиска: latest stable Node.js LTS version 2025;');
    expect(out).toContain('Источники:');
    expect(out).toContain('1. Releases · nodejs/node — https://github.com/nodejs/node/releases');
    expect(out).toContain('2. Node.js default version is now 24.x — https://devcenter2.assets.heroku.com/changelog-items/3502');
    expect(out).toContain('3. Previous Releases | Node.js — https://nodejs.org/en/about/previous-releases');
  });

  it('пустой результат — понятная заглушка', () => {
    expect(formatSearchOutput({ text: '', queries: [], sources: [] })).toBe(
      '(поиск не дал результатов)',
    );
  });
});

describe('getToolDefs — гейтинг web_search', () => {
  it('включён: web_search объявляется модели', () => {
    const defs = getToolDefs(true);
    expect(defs.map((d) => d.function.name)).toContain('web_search');
    expect(defs).toHaveLength(toolDefs.length);
  });

  it('выключен: web_search не объявляется, остальные инструменты на месте', () => {
    const defs = getToolDefs(false);
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain('web_search');
    expect(names).toContain('exec');
    expect(names).toContain('security_audit');
    expect(defs).toHaveLength(toolDefs.length - 1);
  });
});

describe('лимиты', () => {
  it('MAX_USES_PER_CALL ограничивает реальные поиски за один вызов', () => {
    expect(MAX_USES_PER_CALL).toBeLessThanOrEqual(3);
  });
});
