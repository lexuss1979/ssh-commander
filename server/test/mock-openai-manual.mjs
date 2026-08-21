// Моковый OpenAI-совместимый endpoint для ручного теста мульти-серверного
// режима агента (multi-server.manual.mjs) и цикла агента (agent.manual.mjs).
// Отвечает обычным JSON (не SSE) — клиент server/src/ai/client.ts умеет
// fallback на не-streaming ответ. Каждый ответ несёт верхнеуровневый `usage`
// (токены вызова) — проверка учёта расходов в agent.manual.mjs.
//
// Скриптовая последовательность ответов по номеру запроса:
//   1) tool_call list_servers (без аргументов)
//   2) tool_call connect_server {server: "test-sshd-b"}
//   3) tool_call exec_readonly {command: "hostname", server: "test-sshd-b"}
//   4) финальный assistant content без tool_calls
import http from 'node:http';

const PORT = 8199;

function toolCall(id, name, args) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

// Токены вызова (usage не-stream ответа): cached ⊂ prompt — инвариант захвата.
function withUsage(response) {
  return {
    ...response,
    usage: {
      prompt_tokens: 864,
      prompt_tokens_details: { cached_tokens: 120 },
      completion_tokens: 210,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

const script = [
  () => toolCall('call_1', 'list_servers', {}),
  () => toolCall('call_2', 'connect_server', { server: 'test-sshd-b' }),
  () => toolCall('call_3', 'exec_readonly', { command: 'hostname', server: 'test-sshd-b' }),
  () => ({
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Готово: srv-b подключён, hostname проверен.',
        },
      },
    ],
  }),
];

let requestNo = 0;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    requestNo += 1;
    const step = script[Math.min(requestNo, script.length) - 1];
    const response = step();
    const calls = response.choices[0].message.tool_calls ?? [];
    console.log(
      `[mock-openai] request #${requestNo}: ${calls.length ? `tool_calls=${calls.map((c) => c.function.name).join(',')}` : 'final content'}`,
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(withUsage(response)));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}/v1`);
});
