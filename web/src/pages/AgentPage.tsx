import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatRelativeDate, formatUsd } from '../api';
import type {
  AgentAskMode,
  Dialogue,
  DialogueMessage,
  DialogueSummary,
  DialogueUsageTotals,
  Profile,
} from '../types';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';

interface Props {
  profile: Profile;
  showError: (msg: string) => void;
  /** Одноразовый запрос «Спросить агента» (терминал/вкладка БД; расходуется эффектом ниже). */
  agentRequest?: { id: number; text: string; mode?: AgentAskMode; source?: string } | null;
  onAgentRequestConsumed?: () => void;
  /** Индикатор активности в сайдбаре: 'pending' (ждёт approve) важнее 'running'. */
  onActivity?: (profileId: string, state: 'running' | 'pending' | null) => void;
  /**
   * «→ SQL» на sql-блоках ответов (когда активный запрос пришёл со вкладки
   * «Базы данных»): вставить SQL в редактор консоли и переключить вкладку.
   */
  onSqlInsert?: (profileId: string, sql: string) => void;
}

interface AttachedServer {
  id: string;
  name: string;
  host: string;
  username: string;
}

interface ToolCallView {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'pending' | 'ok' | 'error' | 'rejected';
  output?: string;
  truncated?: boolean;
  /** Имя сервера из событий tool_start/tool_pending/tool_result (бейдж). */
  server?: string;
}

interface ChatMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  toolCalls?: ToolCallView[];
}

let nextId = 1;

// Шаблон запроса по выводу терминала (режимы 'explain' и 'new-dialogue').
function terminalContextMessage(text: string, serverName: string): string {
  return `Объясни этот вывод терминала (сервер ${serverName}):\n\`\`\`\n${text}\n\`\`\``;
}

export function AgentPage({ profile, showError, agentRequest, onAgentRequestConsumed, onActivity, onSqlInsert }: Props) {
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
  // Сервер, на котором запускать аудит ('' — домашний профиль диалога).
  const [auditServerId, setAuditServerId] = useState('');
  // Dropdown с историей диалогов (кнопка «История» в тулбаре).
  const [historyOpen, setHistoryOpen] = useState(false);
  // Серверы, подключённые к диалогу (событие WS `servers`): домашний первым.
  const [serversInfo, setServersInfo] = useState<{ home: string; attached: AttachedServer[] } | null>(null);
  // Dropdown кнопки «+» — профили, которые можно подключить к диалогу.
  const [addOpen, setAddOpen] = useState(false);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  // Решение по мутирующему вызову отправлено (кнопки плашки заблокированы
  // до tool_result); смена диалога сбрасывает.
  const [decidedCalls, setDecidedCalls] = useState<Set<string>>(() => new Set());
  // Живые итоги расходов диалога (WS-событие usage): обновляются после каждой
  // записи в журнал — бейдж двигается во время длинных прогонов, а не только
  // по done (refreshDialogues). Сбрасываются при смене диалога.
  const [liveUsage, setLiveUsage] = useState<DialogueUsageTotals | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Отложенная отправка первого сообщения в только что созданный диалог
  // ('new-dialogue' из терминала): заполняется после успешного POST, а
  // отправляется в ws.onopen, когда WS нового диалога готов.
  const pendingSendRef = useRef<{ content: string; dialogueId: string } | null>(null);
  // Поле ввода — для фокуса/курсора после prefill из терминала.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // DOM-карточки вызовов в ленте — клик по плашке подтверждения скроллит к карточке.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
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
    server?: string,
  ) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const toolCall: ToolCallView = { callId, name, args, status, server };
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

  const registerCard = useCallback((callId: string, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(callId, el);
    else cardRefs.current.delete(callId);
  }, []);

  // Решение по мутирующему вызову: единственная точка — закреплённая плашка
  // у поля ввода. callId запоминается до tool_result, чтобы кнопки не мигали.
  const decide = useCallback(
    (callId: string, action: 'approve' | 'reject') => {
      setDecidedCalls((prev) => {
        const next = new Set(prev);
        next.add(callId);
        return next;
      });
      sendWs({ type: action, callId });
    },
    [sendWs],
  );

  const scrollToCard = useCallback((callId: string) => {
    cardRefs.current.get(callId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  // Возвращает id созданного диалога (null при ошибке) — «открыть в новом
  // чате» из терминала привязывает к нему отложенную отправку.
  const startNewDialogue = useCallback(async (): Promise<string | null> => {
    try {
      const { dialogue } = await api<{ dialogue: Dialogue }>('/api/ai/dialogues', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id }),
      });
      setDialogues((prev) => [toSummary(dialogue), ...prev]);
      setActiveDialogueId(dialogue.id);
      setSqlInsertEnabled(false);
      return dialogue.id;
    } catch (err) {
      showError((err as Error).message);
      return null;
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
    setDecidedCalls(new Set());
    setLiveUsage(null);

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
    ws.onopen = () => {
      setConnected(true);
      // Отложенное первое сообщение нового диалога ('new-dialogue' из
      // терминала): сверка dialogueId закрывает гонку «пользователь успел
      // переключить диалог, пока коннектился» — замыкание держит id именно
      // этого WS. planMode: false — это готовый вопрос, а не планирование.
      const pending = pendingSendRef.current;
      if (pending && pending.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
        setMessages((prev) => [...prev, { id: nextId++, role: 'user', content: pending.content }]);
        setPlanReady(false);
        ws.send(JSON.stringify({ type: 'message', content: pending.content, planMode: false }));
      }
    };
    // Обрыв WS между кликом и tool_result: результат уже не придёт, снимаем
    // блокировку, чтобы плашка не зависала навсегда в «выполняется…»
    // (перезагрузка диалога пересоздаст сессию и состояние в любом случае).
    ws.onclose = () => {
      setConnected(false);
      setDecidedCalls(new Set());
    };
    ws.onerror = () => {
      setConnected(false);
      setDecidedCalls(new Set());
    };
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
            typeof msg.server === 'string' && msg.server ? msg.server : undefined,
          );
          break;
        case 'tool_pending':
          addToolCard(
            String(msg.callId ?? ''),
            String(msg.name ?? ''),
            (msg.args ?? {}) as Record<string, unknown>,
            'pending',
            typeof msg.server === 'string' && msg.server ? msg.server : undefined,
          );
          break;
        case 'servers': {
          const attached = Array.isArray(msg.attached) ? (msg.attached as AttachedServer[]) : [];
          setServersInfo({ home: String(msg.home ?? profile.id), attached });
          break;
        }
        case 'usage': {
          // Кумулятивные итоги диалога после каждой записи в журнал расходов.
          const totals = msg.totals as DialogueUsageTotals | undefined;
          if (totals && typeof totals.calls === 'number') setLiveUsage(totals);
          break;
        }
        case 'tool_result': {
          const callId = String(msg.callId ?? '');
          const status = msg.status === 'rejected' ? 'rejected' : msg.status === 'error' ? 'error' : 'ok';
          updateTool(callId, {
            status,
            output: String(msg.output ?? ''),
            truncated: Boolean(msg.truncated),
          });
          setDecidedCalls((prev) => {
            if (!prev.has(callId)) return prev;
            const next = new Set(prev);
            next.delete(callId);
            return next;
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
      // Протухший pending: пользователь ушёл с диалога до onopen —
      // отложенное сообщение сбрасываем, чтобы не выстрелило при
      // следующем открытии этого диалога. Условно: безусловная очистка
      // роняла бы основной путь — ref заполняется до ре-рендера от
      // setActiveDialogueId, и cleanup предыдущего effect'а выполняется
      // уже после заполнения (там pending чужого dialogueId).
      if (pendingSendRef.current?.dialogueId === activeDialogueId) {
        pendingSendRef.current = null;
      }
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

  // Dropdown «+» (подключить сервер): закрывается по клику вне его и по Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [addOpen]);

  // Одновременно висит максимум одно подтверждение (сервер обрабатывает
  // вызовы последовательно) — плашка показывает ровно один pending-вызов.
  const pendingTool: ToolCallView | null =
    messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.status === 'pending') ?? null;

  // Индикатор активности для сайдбара (App): висящее подтверждение (pending)
  // важнее, чем просто «работает» — без него агент молча ждёт approve в фоне.
  const hasPending = pendingTool !== null;
  useEffect(() => {
    onActivity?.(profile.id, hasPending ? 'pending' : running ? 'running' : null);
  }, [hasPending, running, onActivity, profile.id]);
  useEffect(() => {
    const id = profile.id;
    return () => onActivity?.(id, null);
  }, [onActivity, profile.id]);

  // Запрос «Спросить агента» из терминала: если WS готов и агент свободен —
  // отправляем сообщение сразу; иначе (нет соединения или идёт выполнение)
  // подставляем текст в поле ввода, чтобы пользователь отправил сам и текущий
  // поток не сломался. Запрос одноразовый: id запоминаем, App сбрасывает стейт.
  // mode: 'explain' (кнопка «Спросить агента») — как выше; 'prefill' — всегда
  // только вставка в поле ввода; 'new-dialogue' — создать диалог и отправить
  // текст первым сообщением (отложенно, в ws.onopen нового диалога);
  // 'send' — текст уже собран отправителем (SQL-консоль вкладки «Базы данных»),
  // отправляется как есть.
  const lastHandledRequestRef = useRef(0);
  // «→ SQL» на sql-блоках: активен, пока последний разовый запрос пришёл со
  // вкладки «Базы данных» (source === 'db'). Пассивный сброс при назначении
  // диалога (оно бывает поздним — при монтировании панели) не делаем: гасим
  // флаг только в явных действиях пользователя (новый диалог, выбор из
  // истории) — контекст запроса к этим моментам точно устарел.
  const [sqlInsertEnabled, setSqlInsertEnabled] = useState(false);
  useEffect(() => {
    if (!agentRequest || agentRequest.id === lastHandledRequestRef.current) return;
    lastHandledRequestRef.current = agentRequest.id;
    setSqlInsertEnabled(agentRequest.source === 'db');
    const mode = agentRequest.mode ?? 'explain';
    if (mode === 'prefill') {
      // Цитата без инструкции «объясни» — пользователь допишет свой вопрос;
      // набранное не затираем. Фокус и курсор в конец — после применённого
      // стейта, поэтому requestAnimationFrame.
      const block = `Вывод терминала (сервер ${profile.name}):\n\`\`\`\n${agentRequest.text}\n\`\`\`\n\n`;
      setInput((prev) => (prev ? `${prev}\n\n${block}` : block));
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
      onAgentRequestConsumed?.();
      return;
    }
    if (mode === 'new-dialogue') {
      if (runningRef.current) {
        showError('Агент выполняет задачу — дождитесь завершения');
        onAgentRequestConsumed?.();
        return;
      }
      const content = terminalContextMessage(agentRequest.text, profile.name);
      void startNewDialogue().then((id) => {
        if (id) pendingSendRef.current = { content, dialogueId: id };
      });
      onAgentRequestConsumed?.();
      return;
    }
    // 'explain' и 'send' идут одним путём; 'send' текст не оборачивает.
    const content = mode === 'send'
      ? agentRequest.text
      : terminalContextMessage(agentRequest.text, profile.name);
    if (connectedRef.current && !runningRef.current && activeDialogueIdRef.current) {
      setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
      setPlanReady(false);
      sendWs({ type: 'message', content, planMode });
    } else {
      setInput(content);
    }
    onAgentRequestConsumed?.();
  }, [agentRequest, planMode, sendWs, onAgentRequestConsumed, profile.name, showError, startNewDialogue]);

  // «→ SQL» из sql-блока ответа: SQL уходит в редактор консоли нужного
  // профиля, App переключает на вкладку «Базы данных».
  const handleSqlInsert = useCallback(
    (sql: string) => onSqlInsert?.(profile.id, sql),
    [onSqlInsert, profile.id],
  );

  // Подключённые серверы для чипов и модалки аудита: до события `servers`
  // показываем только домашний профиль.
  const attachedServers: AttachedServer[] = serversInfo?.attached ?? [
    { id: profile.id, name: profile.name, host: profile.host, username: profile.username },
  ];
  const homeServerId = serversInfo?.home ?? profile.id;
  const availableProfiles = allProfiles.filter((p) => !attachedServers.some((s) => s.id === p.id));

  // Итоги расходов текущего диалога: живое WS-значение (во время прогона)
  // важнее summary-значения из списка (обновляется по done/error).
  const activeUsage: DialogueUsageTotals | null =
    liveUsage ?? dialogues.find((d) => d.id === activeDialogueId)?.usage ?? null;

  // Кнопка «+»: при открытии подгружаем полный список профилей.
  const toggleAdd = () => {
    const next = !addOpen;
    setAddOpen(next);
    if (next) {
      void api<Profile[]>('/api/profiles')
        .then(setAllProfiles)
        .catch(() => undefined);
    }
  };

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
    const targetId = auditServerId || profile.id;
    const targetName = attachedServers.find((s) => s.id === targetId)?.name ?? profile.name;
    if (password) {
      sendWs({ type: 'sudo_credentials', password, profileId: targetId });
    }
    const content =
      'Выполни проверку безопасности сервера с помощью инструмента security_audit' +
      (targetId !== profile.id ? ` на сервере «${targetName}» (укажи параметр server: "${targetName}")` : '') +
      (password ? ' с параметром privileged: true' : '') +
      '. Проанализируй результаты и дай отчёт: критичные проблемы, предупреждения, рекомендации.';
    setMessages((prev) => [...prev, { id: nextId++, role: 'user', content }]);
    setPlanReady(false);
    // planMode: false — аудит запускается сразу, минуя режим планирования.
    sendWs({ type: 'message', content, planMode: false });
    setAuditPassword('');
    setAuditServerId('');
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
                        setSqlInsertEnabled(false);
                        setHistoryOpen(false);
                      }}
                    >
                      <div className="dialogue-item-title" title={d.title}>
                        {d.title}
                      </div>
                      {d.extraProfileIds && d.extraProfileIds.length > 0 && (
                        <span
                          className="dialogue-badge"
                          title={`Мульти-серверный диалог: подключено ещё ${d.extraProfileIds.length} серверов`}
                        >
                          +{d.extraProfileIds.length}
                        </span>
                      )}
                      <div className="dialogue-item-meta">
                        {formatRelativeDate(d.updatedAt)}
                        {d.usage && d.usage.calls > 0 ? ` · ${formatUsd(d.usage.costUsd)}` : ''}
                      </div>
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
          <button
            className="btn btn-ghost"
            title="Начать новый диалог (текущий останется в истории)"
            onClick={() => void startNewDialogue()}
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
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
            Новый диалог
          </button>
          <span className="muted">
            AI-агент · {profile.name} ({profile.username}@{profile.host})
          </span>
          <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span className="status-text">
            {running ? 'выполняется…' : connected ? 'готов' : 'нет соединения'}
          </span>
          {activeUsage && activeUsage.calls > 0 && (
            <span
              className="cost-badge"
              title={usageTooltip(activeUsage)}
              data-unpriced={activeUsage.unpricedCalls > 0 ? 'true' : undefined}
            >
              {/* Ни один вызов не протарифицирован — $0.0000 врал бы «бесплатно» */}
              ≈ {activeUsage.costUsd === 0 && activeUsage.unpricedCalls > 0 ? '—' : formatUsd(activeUsage.costUsd)}
            </span>
          )}
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
            onClick={() => {
              setAuditServerId('');
              setAuditOpen(true);
            }}
          >
            Проверка безопасности
          </button>
          {running && (
            <button className="btn btn-danger" onClick={() => sendWs({ type: 'stop' })}>
              Стоп
            </button>
          )}
        </div>

        <div className="agent-servers">
          {attachedServers.map((s) => (
            <span
              key={s.id}
              className={`server-chip${s.id === homeServerId ? ' home' : ''}`}
              title={`${s.username}@${s.host}`}
            >
              {s.name}
              {s.id !== homeServerId && (
                <button
                  className="server-chip-remove"
                  title="Отключить сервер от диалога"
                  onClick={() => sendWs({ type: 'detach_server', profileId: s.id })}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <div className="server-add" ref={addRef}>
            <button
              className="btn btn-ghost btn-mini"
              title="Подключить сервер к диалогу"
              onClick={toggleAdd}
            >
              +
            </button>
            {addOpen && (
              <div className="server-add-dropdown">
                {availableProfiles.length === 0 && (
                  <div className="muted server-add-empty">Нет других серверов</div>
                )}
                {availableProfiles.map((p) => (
                  <button
                    key={p.id}
                    className="server-add-item"
                    onClick={() => {
                      sendWs({ type: 'attach_server', profileId: p.id });
                      setAddOpen(false);
                    }}
                  >
                    <strong>{p.name}</strong>
                    <span className="muted">
                      {p.username}@{p.host}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="agent-messages" ref={listRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <p>
                Опишите задачу: например, «покажи состояние сервера и запущенные контейнеры»,
                «найди, кто занимает порт 8080», «обнови конфиг nginx».
              </p>
              <p className="muted">
                Команды чтения выполняются автоматически. Действия записи требуют подтверждения — плашка
                с кнопками «Подтвердить» и «Отклонить» появится у поля ввода. Диалоги сохраняются
                автоматически.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-row ${m.role}`}>
              {m.content && (
                <div className="bubble">
                  <Markdown
                    content={m.content}
                    onInsertSql={sqlInsertEnabled && onSqlInsert ? handleSqlInsert : undefined}
                  />
                </div>
              )}
              {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((t) => (
                    <ToolCard
                      key={t.callId}
                      tool={t}
                      decided={decidedCalls.has(t.callId)}
                      registerCard={registerCard}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {planReady && !running && (
          <PlanCard onExecute={() => sendWs({ type: 'approve_plan' })} />
        )}

        {pendingTool && (
          <PendingBar
            tool={pendingTool}
            decided={decidedCalls.has(pendingTool.callId)}
            onApprove={() => decide(pendingTool.callId, 'approve')}
            onReject={() => decide(pendingTool.callId, 'reject')}
            onScrollToCard={() => scrollToCard(pendingTool.callId)}
          />
        )}

        <div className="agent-input">
          <textarea
            ref={inputRef}
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
              Сервер
              <select value={auditServerId || homeServerId} onChange={(e) => setAuditServerId(e.target.value)}>
                {attachedServers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username}@{s.host})
                  </option>
                ))}
              </select>
            </label>
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
    extraProfileIds: d.extraProfileIds,
    usage: d.usage,
  };
}

// Подсказка бейджа стоимости: вызовы и токены (вход/выход/кэш); при вызовах
// без цены модели — честная пометка «неполная сумма».
function usageTooltip(u: DialogueUsageTotals): string {
  const parts = [
    `Вызовов: ${u.calls}`,
    `Вход: ${u.promptTokens.toLocaleString('ru-RU')} токенов`,
    `Кэш входа: ${u.cachedTokens.toLocaleString('ru-RU')} токенов`,
    `Выход: ${u.completionTokens.toLocaleString('ru-RU')} токенов`,
  ];
  if (u.unpricedCalls > 0) {
    parts.push(`Неполная сумма: ${u.unpricedCalls} вызовов без цены модели`);
  }
  return parts.join('\n');
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

const TOOL_LABELS: Record<string, string> = {
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
  list_servers: 'Список серверов',
};

// Человекочитаемый лейбл вызова; connect_server — карточка-вопрос про целевой
// сервер (приходит в поле server события, он ещё не подключён; фолбэк — args.server).
function toolLabel(tool: ToolCallView): string {
  if (tool.name === 'connect_server') {
    const target = tool.server ?? String(tool.args?.server ?? '');
    return `Подключить «${target}» к диалогу${tool.status === 'pending' ? '?' : ''}`;
  }
  return TOOL_LABELS[tool.name] ?? tool.name;
}

// Главный аргумент вызова (запрос поиска, команда, путь) — видно,
// чем занят агент или что именно он предлагает выполнить.
function mainArgPreview(args?: Record<string, unknown>): string {
  for (const key of ['query', 'command', 'path', 'target', 'containerId']) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// Полный главный аргумент для раскрытия в плашке подтверждения:
// команда exec целиком (многострочная), путь + размер содержимого
// write_file, сводка write_memory, docker-действие с целью;
// без главного аргумента — pretty-JSON args (как «Детали» карточки).
function fullArgText(tool: ToolCallView): string {
  const args = tool.args ?? {};
  if (tool.name === 'write_file') {
    const lines = [`путь: ${typeof args.path === 'string' && args.path ? args.path : '—'}`];
    if (typeof args.content === 'string') {
      lines.push(`содержимое: ${args.content.length.toLocaleString('ru-RU')} симв.`);
    }
    return lines.join('\n');
  }
  if (tool.name === 'write_memory') {
    const lines: string[] = [];
    if (typeof args.reason === 'string' && args.reason.trim()) lines.push(`причина: ${args.reason.trim()}`);
    if (typeof args.content === 'string') {
      lines.push(`новый текст MEMORY.md: ${args.content.length.toLocaleString('ru-RU')} симв.`);
    }
    return lines.join('\n');
  }
  if (tool.name === 'docker_action') {
    const lines = [`действие: ${typeof args.action === 'string' && args.action ? args.action : '—'}`];
    const parts: Array<[string, string]> = [
      ['target', 'цель'],
      ['image', 'образ'],
      ['name', 'имя'],
      ['command', 'команда'],
    ];
    for (const [key, label] of parts) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) lines.push(`${label}: ${v}`);
    }
    return lines.join('\n');
  }
  const main = mainArgPreview(args);
  return main || JSON.stringify(args, null, 2);
}

function ToolCard({ tool, decided, registerCard }: {
  tool: ToolCallView;
  decided: boolean;
  registerCard: (callId: string, el: HTMLDivElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = toolLabel(tool);
  // Пока инструмент выполняется или ждёт подтверждения, вместо вывода
  // показываем его главный аргумент (запрос поиска, команду, путь).
  const argPreview = mainArgPreview(tool.args);
  const preview = (
    tool.status === 'running' || tool.status === 'pending' ? argPreview : (tool.output ?? '')
  )
    .replace(/\s+/g, ' ')
    .trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div
      className={`tool-card ${tool.status}${tool.name === 'web_search' ? ' web' : ''}`}
      ref={(el) => registerCard(tool.callId, el)}
    >
      <div className="tool-card-row">
        <span className={`tool-dot ${tool.status}`} />
        <span className="tool-name" title={name}>{name}</span>
        {tool.server && tool.name !== 'connect_server' && (
          <span className="tool-server" title={`Сервер: ${tool.server}`}>
            {tool.server}
          </span>
        )}
        {tool.status === 'pending' ? (
          <>
            <span className="tool-status">
              {decided ? 'выполняется…' : 'ждёт подтверждения · кнопки — внизу панели'}
            </span>
            <span className="tool-preview" title={preview}>{short || '—'}</span>
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
          </>
        )}
        <button className="btn btn-ghost btn-mini tool-toggle" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Скрыть' : 'Детали'}
        </button>
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

// Закреплённая плашка подтверждения мутирующего вызова — единая точка
// решения (кнопки из карточек в ленте убраны), всегда видна у поля ввода.
// Клик по строке скроллит ленту к карточке вызова; «Подробнее» раскрывает
// полный главный аргумент. После клика кнопки блокируются до tool_result.
function PendingBar({ tool, decided, onApprove, onReject, onScrollToCard }: {
  tool: ToolCallView;
  decided: boolean;
  onApprove: () => void;
  onReject: () => void;
  onScrollToCard: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Очередь подтверждений: смена вызова мгновенно заменяет содержимое
  // плашки — раскрытие не переносится на следующий вызов.
  useEffect(() => {
    setExpanded(false);
  }, [tool.callId]);
  const name = toolLabel(tool);
  const preview = mainArgPreview(tool.args).replace(/\s+/g, ' ').trim();
  const short = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;

  return (
    <div className="pending-bar">
      <div
        className="pending-bar-row"
        title="Показать карточку вызова в ленте"
        onClick={onScrollToCard}
      >
        <span className={`tool-dot ${decided ? 'running' : 'pending'}`} />
        <span className="pending-bar-name" title={name}>{name}</span>
        {tool.server && tool.name !== 'connect_server' && (
          <span className="tool-server" title={`Сервер: ${tool.server}`}>
            {tool.server}
          </span>
        )}
        <span className="pending-bar-preview" title={preview}>{short || '—'}</span>
        <button
          className="btn btn-ghost btn-mini"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
        >
          {expanded ? 'Скрыть' : 'Подробнее'}
        </button>
        {decided ? (
          <span className="tool-status running">выполняется…</span>
        ) : (
          <>
            <button
              className="btn btn-primary btn-mini"
              onClick={(e) => {
                e.stopPropagation();
                onApprove();
              }}
            >
              Подтвердить
            </button>
            <button
              className="btn btn-danger btn-mini"
              onClick={(e) => {
                e.stopPropagation();
                onReject();
              }}
            >
              Отклонить
            </button>
          </>
        )}
      </div>
      {expanded && (
        <pre className="args-view pending-bar-details">{fullArgText(tool)}</pre>
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
