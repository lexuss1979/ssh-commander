import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate } from '../api';
import type { Dialogue, DialogueMessage, DialogueSummary, Profile } from '../types';
import { Markdown } from '../components/Markdown';

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
  const [dialogues, setDialogues] = useState<DialogueSummary[]>([]);
  const [activeDialogueId, setActiveDialogueId] = useState('');
  const [loading, setLoading] = useState(true);
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

  const refreshDialogues = useCallback(async () => {
    try {
      const list = await api<{ dialogues: DialogueSummary[] }>(
        `/api/ai/dialogues?profileId=${encodeURIComponent(profile.id)}`,
      );
      setDialogues(list.dialogues);
    } catch {
      /* список обновится при следующем открытии */
    }
  }, [profile.id]);

  const startNewDialogue = useCallback(async () => {
    try {
      const { dialogue } = await api<{ dialogue: Dialogue }>('/api/ai/dialogues', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id }),
      });
      setDialogues((prev) => [toSummary(dialogue), ...prev]);
      setActiveDialogueId(dialogue.id);
    } catch (err) {
      showError((err as Error).message);
    }
  }, [profile.id, showError]);

  const removeDialogue = useCallback(
    async (id: string) => {
      if (id === activeDialogueId && running) {
        showError('Дождитесь завершения текущего диалога');
        return;
      }
      if (!window.confirm('Удалить диалог? Это действие необратимо.')) return;
      try {
        await api(`/api/ai/dialogues/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const remaining = dialogues.filter((d) => d.id !== id);
        setDialogues(remaining);
        if (id === activeDialogueId) {
          if (remaining.length > 0) {
            setActiveDialogueId(remaining[0].id);
          } else {
            await startNewDialogue();
          }
        }
      } catch (err) {
        showError((err as Error).message);
      }
    },
    [activeDialogueId, running, dialogues, startNewDialogue, showError],
  );

  // Загрузка списка диалогов профиля; при отсутствии — создаём первый.
  useEffect(() => {
    let cancelled = false;
    setDialogues([]);
    setActiveDialogueId('');
    setMessages([]);
    setRunning(false);
    setLoading(true);
    void (async () => {
      try {
        const list = await api<{ dialogues: DialogueSummary[] }>(
          `/api/ai/dialogues?profileId=${encodeURIComponent(profile.id)}`,
        );
        if (cancelled) return;
        setDialogues(list.dialogues);
        if (list.dialogues.length > 0) {
          setActiveDialogueId(list.dialogues[0].id);
        } else {
          const { dialogue } = await api<{ dialogue: Dialogue }>('/api/ai/dialogues', {
            method: 'POST',
            body: JSON.stringify({ profileId: profile.id }),
          });
          if (cancelled) return;
          setDialogues([toSummary(dialogue)]);
          setActiveDialogueId(dialogue.id);
        }
      } catch (err) {
        showError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile.id, showError]);

  // Подключение WS и загрузка истории выбранного диалога.
  useEffect(() => {
    if (!activeDialogueId) return;
    let cancelled = false;
    setMessages([]);
    setRunning(false);

    void api<{ dialogue: Dialogue }>(`/api/ai/dialogues/${encodeURIComponent(activeDialogueId)}`)
      .then(({ dialogue }) => {
        if (!cancelled) {
          setMessages((prev) => (prev.length === 0 ? messagesToViews(dialogue.messages) : prev));
        }
      })
      .catch(() => undefined);

    const ws = new WebSocket(
      `/ws/agent?profileId=${encodeURIComponent(profile.id)}&dialogueId=${encodeURIComponent(activeDialogueId)}`,
    );
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
        case 'dialogue': {
          const id = String(msg.id ?? '');
          if (id && id !== activeDialogueId) setActiveDialogueId(id);
          break;
        }
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
          void refreshDialogues();
          break;
        }
        case 'error':
          setRunning(false);
          showError(String(msg.message ?? 'Ошибка агента'));
          void refreshDialogues();
          break;
      }
    };
    return () => {
      cancelled = true;
      ws.close();
      wsRef.current = null;
    };
  }, [
    activeDialogueId,
    profile.id,
    pushAssistantToken,
    finalizeAssistant,
    addToolPending,
    updateTool,
    showError,
    refreshDialogues,
  ]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = () => {
    const content = input.trim();
    if (!content || !connected || running || !activeDialogueId) return;
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setInput('');
    sendWs({ type: 'message', content });
  };

  return (
    <div className="page agent-page">
      <aside className="agent-sidebar">
        <div className="agent-sidebar-head">
          <span className="sidebar-label">Диалоги</span>
          <button className="btn btn-primary btn-mini" onClick={() => void startNewDialogue()}>
            Новый
          </button>
        </div>
        <div className="agent-dialogues">
          {dialogues.length === 0 && !loading && <div className="muted dialogue-empty">Пока нет диалогов</div>}
          {dialogues.map((d) => (
            <div
              key={d.id}
              className={`dialogue-item ${d.id === activeDialogueId ? 'active' : ''}`}
              onClick={() => setActiveDialogueId(d.id)}
            >
              <div className="dialogue-item-title" title={d.title}>
                {d.title}
              </div>
              <div className="dialogue-item-meta">
                {d.messageCount} сообщ. · {formatDate(d.updatedAt)}
              </div>
              {d.preview && <div className="dialogue-item-preview">{d.preview}</div>}
              <button
                className="dialogue-delete"
                title="Удалить диалог"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeDialogue(d.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="agent-chat">
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
                их карточкой с кнопками «Подтвердить» и «Отклонить». Диалоги сохраняются автоматически.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-row ${m.role}`}>
              {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((t) => (
                    <ToolCard
                      key={t.callId}
                      tool={t}
                      onApprove={() => sendWs({ type: 'approve', callId: t.callId })}
                      onReject={() => sendWs({ type: 'reject', callId: t.callId })}
                    />
                  ))}
                </div>
              )}
              {m.content && (
                <div className="bubble">
                  <Markdown content={m.content} />
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
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={!connected || running || !input.trim() || !activeDialogueId}
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}

function toSummary(d: Dialogue): DialogueSummary {
  return {
    id: d.id,
    title: d.title,
    preview: d.preview,
    messageCount: d.messageCount,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function toolStatusFromContent(content: string): ToolCallView['status'] {
  const text = content.trim();
  if (text.startsWith('Ошибка:') || text.startsWith('Отклонено:')) return 'error';
  if (text.includes('Пользователь отклонил') || text.includes('Агент остановлен')) return 'rejected';
  return 'ok';
}

function messagesToViews(messages: DialogueMessage[]): ChatMessageView[] {
  const views: ChatMessageView[] = [];
  let lastAssistant: ChatMessageView | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      views.push({ id: nextId++, role: 'user', content: m.content ?? '' });
      lastAssistant = null;
    } else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((tc) => ({
        callId: tc.id,
        name: tc.function?.name ?? '',
        args: parseToolArgs(tc.function?.arguments),
        status: 'ok' as const,
      }));
      const view: ChatMessageView = {
        id: nextId++,
        role: 'assistant',
        content: m.content ?? '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
      };
      views.push(view);
      lastAssistant = toolCalls.length ? view : null;
    } else if (m.role === 'tool' && lastAssistant) {
      const tool = lastAssistant.toolCalls?.find((t) => t.callId === m.tool_call_id);
      if (tool) {
        tool.output = m.content ?? '';
        tool.status = toolStatusFromContent(m.content ?? '');
      }
    }
  }
  return views;
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
    read_memory: 'Прочитать память',
    list_dir: 'Список файлов',
    write_file: 'Записать файл',
    write_memory: 'Обновить память',
    docker_ps: 'Список контейнеров',
    docker_logs: 'Логи контейнера',
    docker_inspect: 'Inspect Docker',
    docker_action: 'Действие Docker',
  };
  const name = labels[tool.name] ?? tool.name;
  const preview = (tool.output ?? '').replace(/\s+/g, ' ').trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div className={`tool-card ${tool.status}`}>
      <div className="tool-card-row">
        <span className={`tool-dot ${tool.status}`} />
        <span className="tool-name" title={name}>{name}</span>
        {tool.status === 'pending' ? (
          <>
            <span className="tool-status">ждёт подтверждения</span>
            <span className="tool-actions-mini">
              <button className="btn btn-mini btn-primary" onClick={onApprove}>Подтвердить</button>
              <button className="btn btn-mini btn-danger" onClick={onReject}>Отклонить</button>
            </span>
          </>
        ) : (
          <>
            <span className={`tool-status ${tool.status}`}>
              {tool.status === 'ok' ? 'выполнено' : tool.status === 'rejected' ? 'отклонено' : 'ошибка'}
            </span>
            <span className="tool-preview" title={preview}>{short || '—'}</span>
            <button className="btn btn-ghost btn-mini tool-toggle" onClick={() => setExpanded((x) => !x)}>
              {expanded ? 'Скрыть' : 'Детали'}
            </button>
          </>
        )}
      </div>
      {expanded && (
        <div className="tool-details">
          {Object.keys(tool.args).length > 0 && (
            <>
              <div className="tool-details-label">Аргументы</div>
              <pre className="args-view">{JSON.stringify(tool.args, null, 2)}</pre>
            </>
          )}
          {tool.output !== undefined && (
            <>
              <div className="tool-details-label">Вывод{tool.truncated ? ' (обрезан)' : ''}</div>
              <pre className="output-view">{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
