// A mock OpenAI-compatible endpoint for the manual tests of the agent
// multi-server mode (multi-server.manual.mjs) and of the agent loop
// (agent.manual.mjs).
// It answers plain JSON (not SSE) — the server/src/ai/client.ts client can
// fall back to a non-streaming response. Every response carries a top-level
// `usage` (the call tokens) — the cost accounting check in agent.manual.mjs.
//
// The scripted response sequence by the request number:
//   1) tool_call list_servers (no arguments)
//   2) tool_call connect_server {server: "test-sshd-b"}
//   3) tool_call exec_readonly {command: "hostname", server: "test-sshd-b"}
//   4) the final assistant content with a trailing suggestion marker
//      [[SUGGEST]] — the server cuts it out and sends the WS suggestion event
//      (checked in agent.manual.mjs).
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

// The call tokens (usage of a non-stream response): cached ⊂ prompt — the capture invariant.
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
          content: 'Готово: srv-b подключён, hostname проверен.\n[[SUGGEST]] Да, перезапусти nginx',
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
