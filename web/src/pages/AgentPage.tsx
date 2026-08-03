import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile } from '../types';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
}

interface ToolCallView {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'ok' | 'error' | 'rejected';
  output?: string;
  truncated?: boolean;
}

interface ChatMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  toolCalls?: ToolCallView[];
}

let nextId = 1;

export function AgentPage({ profile, showError }: Props) {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pushAssistantToken = useCallback((token: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + token }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content: token, streaming: true }];
    });
  }, []);

  const finalizeAssistant = useCallback((content: string, toolCalls?: ToolCallView[]) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content, streaming: false, toolCalls: [...(last.toolCalls ?? []), ...(toolCalls ?? [])] }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content, toolCalls }];
    });
  }, []);

  const addToolPending = useCallback((callId: string, name: string, args: Record<string, unknown>) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const toolCall: ToolCallView = { callId, name, args, status: 'pending' };
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] }];
      }
      return [...prev, { id: nextId++, role: 'assistant', content: '', toolCalls: [toolCall] }];
    });
  }, []);

  const updateTool = useCallback((callId: string, patch: Partial<ToolCallView>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.toolCalls?.some((t) => t.callId === callId)
          ? { ...m, toolCalls: m.toolCalls.map((t) => (t.callId === callId ? { ...t, ...patch } : t)) }
          : m,
      ),
    );
  }, []);

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    setMessages([]);
    setRunning(false);
    const ws = new WebSocket(`/ws/agent?profileId=${encodeURIComponent(profile.id)}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'token':
          pushAssistantToken(String(msg.content ?? ''));
          break;
        case 'message':
          finalizeAssistant(String(msg.content ?? ''));
          break;
        case 'tool_pending':
          addToolPending(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
          );
          break;
        case 'tool_result': {
          const status = msg.status === 'rejected' ? 'rejected' : msg.status === 'error' ? 'error' : 'ok';
          updateTool(String(msg.callId ?? ''), {
            status,
            output: String(msg.output ?? ''),
            truncated: Boolean(msg.truncated),
          });
          break;
        }
        case 'running':
          setRunning(true);
          break;
        case 'done': {
          setRunning(false);
          if (msg.note) {
            setMessages((prev) => [...prev, { id: nextId++, role: 'assistant', content: `⚠️ ${String(msg.note)}` }]);
          }
          break;
        }
        case 'error':
          setRunning(false);
          showError(String(msg.message ?? 'Ошибка агента'));
          break;
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [profile.id, pushAssistantToken, finalizeAssistant, addToolPending, updateTool, showError]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    const content = input.trim();
    if (!content || !connected || running) return;
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setInput('');
    sendWs({ type: 'message', content });
  };

  return (
    <div className="page agent-page">
      <div className="toolbar">
        <span className="muted">
          AI-агент · {profile.name} ({profile.username}@{profile.host})
        </span>
        <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
        <span className="status-text">
          {running ? 'выполняется…' : connected ? 'готов' : 'нет соединения'}
        </span>
        {running && (
          <button className="btn btn-danger" onClick={() => sendWs({ type: 'stop' })}>
            Стоп
          </button>
        )}
      </div>

      <div className="agent-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <p>
              Опишите задачу: например, «покажи состояние сервера и запущенные контейнеры»,
              «найди, кто занимает порт 8080», «обнови конфиг nginx».
            </p>
            <p className="muted">
              Команды чтения выполняются автоматически. Действия записи требуют подтверждения — вы увидите
              их карточкой с кнопками «Подтвердить» и «Отклонить».
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-row ${m.role}`}>
            {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
              <div className="tool-calls">
                {m.toolCalls.map((t) => (
                  <ToolCard key={t.callId} tool={t} onApprove={() => sendWs({ type: 'approve', callId: t.callId })} onReject={() => sendWs({ type: 'reject', callId: t.callId })} />
                ))}
              </div>
            )}
            {m.content && (
              <div className="bubble">
                <pre className="chat-pre">{m.content}</pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="agent-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Задача для агента… (Enter — отправить)"
          rows={2}
        />
        <button className="btn btn-primary" onClick={send} disabled={!connected || running || !input.trim()}>
          Отправить
        </button>
      </div>
    </div>
  );
}

function ToolCard({ tool, onApprove, onReject }: {
  tool: ToolCallView;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const labels: Record<string, string> = {
    exec: 'Выполнить команду',
    exec_readonly: 'Команда чтения',
    read_file: 'Прочитать файл',
    list_dir: 'Список файлов',
    write_file: 'Записать файл',
    docker_ps: 'Список контейнеров',
    docker_logs: 'Логи контейнера',
    docker_inspect: 'Inspect Docker',
    docker_action: 'Действие Docker',
  };

  return (
    <div className={`tool-card ${tool.status}`}>
      <div className="tool-card-head">
        <strong>{labels[tool.name] ?? tool.name}</strong>
        <span className={`status-chip ${tool.status === 'ok' ? 'ok' : tool.status === 'error' || tool.status === 'rejected' ? 'bad' : 'pending'}`}>
          {tool.status === 'pending' ? 'ожидает подтверждения' : tool.status === 'ok' ? 'выполнено' : tool.status === 'rejected' ? 'отклонено' : 'ошибка'}
        </span>
      </div>
      <button className="btn btn-ghost btn-mini" onClick={() => setExpanded((x) => !x)}>
        {expanded ? 'Скрыть' : 'Показать'} аргументы
      </button>
      {expanded && <pre className="args-view">{JSON.stringify(tool.args, null, 2)}</pre>}
      {tool.output !== undefined && tool.status !== 'pending' && (
        <details open={tool.status !== 'ok'}>
          <summary>Вывод{tool.truncated ? ' (обрезан)' : ''}</summary>
          <pre className="output-view">{tool.output}</pre>
        </details>
      )}
      {tool.status === 'pending' && (
        <div className="tool-actions">
          <button className="btn btn-primary" onClick={onApprove}>Подтвердить</button>
          <button className="btn btn-danger" onClick={onReject}>Отклонить</button>
        </div>
      )}
    </div>
  );
}

