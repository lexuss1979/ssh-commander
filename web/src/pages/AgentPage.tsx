import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatRelativeDate } from '../api';
import type { Dialogue, DialogueMessage, DialogueSummary, Profile } from '../types';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  /** Одноразовый запрос «Спросить агента» из терминала (расходуется эффектом ниже). */
  agentRequest?: { id: number; text: string } | null;
  onAgentRequestConsumed?: () => void;
}

interface ToolCallView {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'pending' | 'ok' | 'error' | 'rejected';
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

export function AgentPage({ profile, showError, agentRequest, onAgentRequestConsumed }: Props) {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [dialogues, setDialogues] = useState<DialogueSummary[]>([]);
  const [activeDialogueId, setActiveDialogueId] = useState('');
  const [loading, setLoading] = useState(true);
  // Режим планирования: сообщения уходят с planMode=true, агент сначала
  // составляет план без инструментов и ждёт approve_plan.
  const [planMode, setPlanMode] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  // Модалка «Проверка безопасности»: необязательный sudo-пароль для root-секций аудита.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditPassword, setAuditPassword] = useState('');
  // Dropdown с историей диалогов (кнопка «История» в тулбаре).
  const [historyOpen, setHistoryOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  // Актуальные значения для эффекта «Спросить агента» — без добавления в deps,
  // чтобы смена состояния не расходовала запрос повторно.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const runningRef = useRef(running);
  runningRef.current = running;
  const activeDialogueIdRef = useRef(activeDialogueId);
  activeDialogueIdRef.current = activeDialogueId;

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

  // Карточка инструмента: 'running' — read-only вызов исполняется (tool_start),
  // 'pending' — мутрующий ждёт подтверждения (tool_pending).
  const addToolCard = useCallback((
    callId: string,
    name: string,
    args: Record<string, unknown>,
    status: 'running' | 'pending',
  ) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const toolCall: ToolCallView = { callId, name, args, status };
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
    setPlanReady(false);
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
    setPlanReady(false);

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
        case 'tool_start':
          addToolCard(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
            'running',
          );
          break;
        case 'tool_pending':
          addToolCard(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
            'pending',
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
          setPlanReady(false);
          break;
        case 'plan_ready':
          setPlanReady(true);
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
    addToolCard,
    updateTool,
    showError,
    refreshDialogues,
  ]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Dropdown истории: закрывается по клику вне его и по Escape.
  useEffect(() => {
    if (!historyOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [historyOpen]);

  // Запрос «Спросить агента» из терминала: если WS готов и агент свободен —
  // отправляем сообщение сразу; иначе (нет соединения или идёт выполнение)
  // подставляем текст в поле ввода, чтобы пользователь отправил сам и текущий
  // поток не сломался. Запрос одноразовый: id запоминаем, App сбрасывает стейт.
  const lastHandledRequestRef = useRef(0);
  useEffect(() => {
    if (!agentRequest || agentRequest.id === lastHandledRequestRef.current) return;
    lastHandledRequestRef.current = agentRequest.id;
    const content = `Объясни этот вывод терминала:\n\`\`\`\n${agentRequest.text}\n\`\`\``;
    if (connectedRef.current && !runningRef.current && activeDialogueIdRef.current) {
      setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
      setPlanReady(false);
      sendWs({ type: 'message', content, planMode });
    } else {
      setInput(content);
    }
    onAgentRequestConsumed?.();
  }, [agentRequest, planMode, sendWs, onAgentRequestConsumed]);

  const send = () => {
    const content = input.trim();
    if (!content || !connected || running || !activeDialogueId) return;
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setInput('');
    setPlanReady(false);
    // Правки к ожидающему плану — это тоже message с planMode=true:
    // сервер пересоставит план. Выход из режима — снять переключатель «План».
    sendWs({ type: 'message', content, planMode });
  };

  // Запуск «Проверки безопасности»: пароль (если введён) уходит отдельным
  // WS-сообщением sudo_credentials и хранится только в памяти сессии агента —
  // в текст запроса и историю диалога он не попадает. Если агент занят или
  // соединения нет — не запускаем (модалка остаётся открытой).
  const startAudit = () => {
    if (!connected || !activeDialogueId) {
      showError('Нет соединения с агентом');
      return;
    }
    if (running) {
      showError('Агент сейчас выполняет задачу — дождитесь завершения');
      return;
    }
    const password = auditPassword;
    if (password) {
      sendWs({ type: 'sudo_credentials', password });
    }
    const content =
      'Выполни проверку безопасности сервера с помощью инструмента security_audit' +
      (password ? ' с параметром privileged: true' : '') +
      '. Проанализируй результаты и дай отчёт: критичные проблемы, предупреждения, рекомендации.';
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setPlanReady(false);
    // planMode: false — аудит запускается сразу, минуя режим планирования.
    sendWs({ type: 'message', content, planMode: false });
    setAuditPassword('');
    setAuditOpen(false);
  };

  return (
    <div className="page agent-page">
      <div className="agent-chat">
        <div className="toolbar">
          <div className="agent-history" ref={historyRef}>
            <button
              className={`btn btn-ghost agent-history-btn ${historyOpen ? 'open' : ''}`}
              title="История диалогов"
              onClick={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (next) void refreshDialogues();
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
              </svg>
              История
            </button>
            {historyOpen && (
              <div className="agent-history-dropdown">
                <div className="agent-history-head">
                  <span className="sidebar-label">Диалоги</span>
                  <button
                    className="btn btn-primary btn-mini"
                    onClick={() => {
                      setHistoryOpen(false);
                      void startNewDialogue();
                    }}
                  >
                    Новый
                  </button>
                </div>
                <div className="agent-history-list">
                  {dialogues.length === 0 && !loading && (
                    <div className="muted dialogue-empty">Пока нет диалогов</div>
                  )}
                  {dialogues.map((d) => (
                    <div
                      key={d.id}
                      className={`dialogue-item ${d.id === activeDialogueId ? 'active' : ''}`}
                      onClick={() => {
                        setActiveDialogueId(d.id);
                        setHistoryOpen(false);
                      }}
                    >
                      <div className="dialogue-item-title" title={d.title}>
                        {d.title}
                      </div>
                      <div className="dialogue-item-meta">{formatRelativeDate(d.updatedAt)}</div>
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
              </div>
            )}
          </div>
          <span className="muted">
            AI-агент · {profile.name} ({profile.username}@{profile.host})
          </span>
          <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span className="status-text">
            {running ? 'выполняется…' : connected ? 'готов' : 'нет соединения'}
          </span>
          <label
            className="plan-toggle"
            title="Сначала составить пошаговый план и показать его на подтверждение — ничего не выполняя"
          >
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => setPlanMode(e.target.checked)}
            />
            План
          </label>
          <button
            className="btn btn-ghost"
            title="Детерминированная проверка безопасности сервера (инструмент security_audit)"
            onClick={() => setAuditOpen(true)}
          >
            Проверка безопасности
          </button>
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

        {planReady && !running && (
          <PlanCard onExecute={() => sendWs({ type: 'approve_plan' })} />
        )}

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

      {auditOpen && (
        <Modal title="Проверка безопасности" onClose={() => setAuditOpen(false)}>
          <p className="muted">
            Агент выполнит детерминированный аудит сервера (ssh, сеть, обновления, активность,
            docker, файловая система) и составит отчёт. Для root-проверок (/etc/shadow, sudoers,
            неудачные логины и т.п.) можно указать sudo-пароль.
          </p>
          <div className="form-grid">
            <label>
              sudo-пароль (необязательно)
              <input
                type="password"
                autoComplete="new-password"
                value={auditPassword}
                onChange={(e) => setAuditPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    startAudit();
                  }
                }}
                placeholder="Без пароля root-проверки будут пропущены"
              />
            </label>
          </div>
          <p className="muted">
            Пароль не сохраняется, не передаётся модели и не попадает в историю диалога — он живёт
            только в памяти текущей сессии агента.
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setAuditOpen(false)}>
              Отмена
            </button>
            <button className="btn btn-primary" onClick={startAudit}>
              Запустить проверку
            </button>
          </div>
        </Modal>
      )}
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
  // Решение отправлено на сервер — блокируем кнопки до смены статуса карточки.
  const [decided, setDecided] = useState(false);
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
    security_audit: 'Аудит безопасности',
    web_search: '🌐 Поиск в интернете',
  };
  const name = labels[tool.name] ?? tool.name;
  // Пока инструмент выполняется, вместо вывода показываем его главный аргумент
  // (запрос поиска, команду, путь) — видно, чем занят агент прямо сейчас.
  const argPreview = (() => {
    for (const key of ['query', 'command', 'path', 'target', 'containerId']) {
      const v = tool.args?.[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  })();
  const preview = (tool.status === 'running' ? argPreview : (tool.output ?? '')).replace(/\s+/g, ' ').trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div className={`tool-card ${tool.status}${tool.name === 'web_search' ? ' web' : ''}`}>
      <div className="tool-card-row">
        <span className={`tool-dot ${tool.status}`} />
        <span className="tool-name" title={name}>{name}</span>
        {tool.status === 'pending' ? (
          <>
            <span className="tool-status">{decided ? 'отправлено…' : 'ждёт подтверждения'}</span>
            <span className="tool-actions-mini">
              <button
                className="btn btn-mini btn-primary"
                disabled={decided}
                onClick={() => {
                  setDecided(true);
                  onApprove();
                }}
              >
                Подтвердить
              </button>
              <button
                className="btn btn-mini btn-danger"
                disabled={decided}
                onClick={() => {
                  setDecided(true);
                  onReject();
                }}
              >
                Отклонить
              </button>
            </span>
          </>
        ) : (
          <>
            <span className={`tool-status ${tool.status}`}>
              {tool.status === 'running'
                ? 'выполняется…'
                : tool.status === 'ok'
                  ? 'выполнено'
                  : tool.status === 'rejected'
                    ? 'отклонено'
                    : 'ошибка'}
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

// Карточка «План готов»: запускает исполнение плана (approve_plan).
// Отказ от плана — просто написать правки в чат: план будет пересоставлен.
function PlanCard({ onExecute }: { onExecute: () => void }) {
  // Решение отправлено на сервер — блокируем кнопку (паттерн как в ToolCard).
  const [sent, setSent] = useState(false);
  return (
    <div className="plan-card">
      <div className="plan-card-info">
        <span className="plan-card-title">План готов</span>
        <span className="plan-card-hint muted">
          Нажмите «Выполнить», чтобы агент приступил к плану (действия записи по-прежнему потребуют
          подтверждения), или напишите правки — план будет пересоставлен.
        </span>
      </div>
      <button
        className="btn btn-primary"
        disabled={sent}
        onClick={() => {
          setSent(true);
          onExecute();
        }}
      >
        {sent ? 'Запущено…' : 'Выполнить'}
      </button>
    </div>
  );
}
