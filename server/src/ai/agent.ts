import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { streamChatCompletion, type ChatMessage, type ToolCall } from './client.js';
import { sanitizeMessages } from './messages.js';
import { buildPlanRequestMessages, toolsForRequest } from './plan.js';
import { toolDefs, READ_ONLY_TOOLS } from './tools.js';
import { checkReadOnlyCommand } from './guard.js';
import { exec, withSftp } from '../ssh/manager.js';
import {
  readFile as sftpReadFile,
  readdir as sftpReaddir,
  writeFile as sftpWriteFile,
  stat as sftpStat,
} from '../ssh/sftp.js';
import type { ExecResult, Profile } from '../types.js';
import {
  inspect,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  containerAction,
  pullImage,
  removeImage,
  runContainer,
  dockerExec,
} from '../services/docker.js';
import {
  createDialogue,
  getDialogue,
  saveDialogueMessages,
  type Dialogue,
} from './dialogues.js';

const MAX_TOOL_OUTPUT = 12000;

type WsMessage = Record<string, unknown>;

interface PendingCall {
  callId: string;
  resolve: (decision: 'approved' | 'rejected' | 'aborted') => void;
}

export class AgentSession {
  private messages: ChatMessage[] = [];
  private pending = new Map<string, PendingCall>();
  private steps = 0;
  private stopRequested = false;
  private running = false;
  private wsClosed = false;
  private loopAbort: AbortController | null = null;
  // План составлен и ждёт approve_plan (или правок обычным message с planMode=true).
  private planPending = false;

  constructor(
    private profile: Profile,
    private ws: WebSocket,
    dialogue?: Dialogue,
  ) {
    this.dialogueId = dialogue?.id ?? createDialogue(profile.id).id;
    this.messages.push({
      role: 'system',
      content:
        'Ты — AI-ассистент для администрирования удалённого Linux-сервера ' +
        `${profile.username}@${profile.host}. ` +
        'Ты работаешь только через предоставленные инструменты, не выдумывай результаты. ' +
        'Инструменты чтения (exec_readonly, read_file, list_dir, docker_ps, docker_logs, docker_inspect) выполняются автоматически. ' +
        'Инструменты записи (exec, write_file, docker_action) требуют подтверждения пользователя — не пытайся обойти это ограничение, ' +
        'запрашивай подтверждение обычным вызовом инструмента. ' +
        'Отвечай кратко и по делу на русском. Сначала собери факты (проверь состояние), затем предлагай действия. ' +
        'Перед разрушительными действиями предупреждай о последствиях.',
    });
    for (const message of dialogue?.messages ?? []) {
      if (message.role !== 'system') {
        this.messages.push(message);
      }
    }
  }

  readonly dialogueId: string;

  get isRunning(): boolean {
    return this.running;
  }

  get isPlanPending(): boolean {
    return this.planPending;
  }

  notifyDialogue(): void {
    this.send({ type: 'dialogue', id: this.dialogueId });
  }

  handleClientMessage(data: WsMessage): void {
    switch (data.type) {
      case 'message': {
        const content = String(data.content ?? '').trim();
        if (content && !this.running) {
          if (data.planMode === true) {
            // Режим планирования (или правки к ожидающему плану): составляем план заново.
            void this.runPlan(content);
          } else {
            // planMode=false/отсутствует — выход из режима планирования.
            this.planPending = false;
            void this.runLoop(content);
          }
        }
        break;
      }
      case 'approve_plan': {
        // План подтверждён: продолжаем тот же диалог обычным циклом с инструментами
        // (per-tool approve для мутирующих инструментов сохраняется).
        if (this.planPending && !this.running) {
          this.planPending = false;
          void this.runLoop('План подтверждён пользователем. Приступай к его выполнению по шагам.');
        }
        break;
      }
      case 'approve': {
        const callId = String(data.callId ?? '');
        const pending = this.pending.get(callId);
        if (pending) {
          this.pending.delete(callId);
          pending.resolve('approved');
        }
        break;
      }
      case 'reject': {
        const callId = String(data.callId ?? '');
        const pending = this.pending.get(callId);
        if (pending) {
          this.pending.delete(callId);
          pending.resolve('rejected');
        }
        break;
      }
      case 'stop': {
        this.stop();
        break;
      }
    }
  }

  stop(): void {
    this.stopRequested = true;
    this.planPending = false;
    this.loopAbort?.abort();
    for (const pending of this.pending.values()) {
      pending.resolve('aborted');
    }
    this.pending.clear();
  }

  onWsClose(): void {
    this.wsClosed = true;
    this.stop();
  }

  private send(data: WsMessage): void {
    if (!this.wsClosed && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private save(): void {
    try {
      saveDialogueMessages(this.dialogueId, this.messages);
    } catch (err) {
      console.warn(`Failed to save dialogue ${this.dialogueId}:`, err);
    }
  }

  private waitDecision(callId: string): Promise<'approved' | 'rejected' | 'aborted'> {
    return new Promise((resolve) => {
      this.pending.set(callId, { callId, resolve });
    });
  }

  /**
   * Шаг планирования: один запрос к API БЕЗ инструментов (ключ `tools`
   * отсутствует в теле запроса) с дополненным системным промптом. Ответ
   * модели — план — стримится как обычное assistant-сообщение (token/message),
   * затем отправляется `plan_ready`, и сессия ждёт `approve_plan` или правок.
   * Шаг планирования НЕ расходует лимит AI_MAX_STEPS: счётчик шагов ведётся
   * только в runLoop (исполнение с инструментами).
   */
  private async runPlan(userContent: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.planPending = false;
    this.messages = sanitizeMessages(this.messages);
    this.messages.push({ role: 'user', content: userContent });
    this.save();
    this.send({ type: 'running', steps: config.ai.maxSteps });

    try {
      this.loopAbort = new AbortController();
      let assistant: ChatMessage;
      try {
        assistant = await streamChatCompletion({
          messages: buildPlanRequestMessages(sanitizeMessages(this.messages)),
          tools: toolsForRequest(true),
          signal: this.loopAbort.signal,
          onToken: (token) => this.send({ type: 'token', content: token }),
        });
      } catch (err) {
        if (this.stopRequested) {
          this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
        } else {
          this.send({ type: 'error', message: String((err as Error).message ?? err) });
        }
        return;
      }

      // Инструменты в запросе не передавались; если модель всё же вернула
      // tool_calls — игнорируем их и сохраняем только текст плана.
      this.send({ type: 'message', role: 'assistant', content: assistant.content ?? '' });
      this.messages.push({ role: 'assistant', content: assistant.content });
      this.save();
      this.planPending = true;
      this.send({ type: 'plan_ready' });
      this.send({ type: 'done' });
    } catch (err) {
      this.send({ type: 'error', message: String((err as Error).message ?? err) });
    } finally {
      this.save();
      this.running = false;
      this.loopAbort = null;
    }
  }

  private async runLoop(userContent: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.steps = 0;
    // Не отправляем в API и не сохраняем оборванный обмен tool_calls (например,
    // после остановки агента или перезагрузки вкладки в середине вызова).
    this.messages = sanitizeMessages(this.messages);
    this.messages.push({ role: 'user', content: userContent });
    this.save();
    this.send({ type: 'running', steps: config.ai.maxSteps });

    try {
      while (this.steps < config.ai.maxSteps && !this.stopRequested) {
        this.steps += 1;
        this.loopAbort = new AbortController();

        let assistant: ChatMessage;
        try {
          assistant = await streamChatCompletion({
            messages: sanitizeMessages(this.messages),
            tools: toolDefs,
            signal: this.loopAbort.signal,
            onToken: (token) => this.send({ type: 'token', content: token }),
          });
        } catch (err) {
          if (this.stopRequested) {
            this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
          } else {
            this.send({ type: 'error', message: String((err as Error).message ?? err) });
          }
          return;
        }

        this.send({ type: 'message', role: 'assistant', content: assistant.content ?? '' });
        this.messages.push(assistant);
        this.save();

        const calls = assistant.tool_calls ?? [];
        if (!calls.length) {
          this.send({ type: 'done' });
          return;
        }

        const toolMessages: ChatMessage[] = [];
        for (const call of calls) {
          if (this.stopRequested) break;
          const { name, args } = this.parseCall(call);
          const readOnly = READ_ONLY_TOOLS.has(name);

          if (readOnly) {
            const result = await this.runTool(name, args);
            this.send({
              type: 'tool_result',
              callId: call.id,
              name,
              status: result.status,
              output: result.output,
              truncated: result.truncated,
            });
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              name,
              content: result.output,
            });
          } else {
            this.send({ type: 'tool_pending', callId: call.id, name, args });
            const decision = await this.waitDecision(call.id);
            if (decision === 'rejected' || decision === 'aborted') {
              const output = decision === 'aborted'
                ? 'Агент остановлен пользователем.'
                : 'Пользователь отклонил выполнение этого действия.';
              this.send({
                type: 'tool_result',
                callId: call.id,
                name,
                status: 'rejected',
                output,
              });
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                name,
                content: output,
              });
            } else {
              const result = await this.runTool(name, args);
              this.send({
                type: 'tool_result',
                callId: call.id,
                name,
                status: result.status,
                output: result.output,
                truncated: result.truncated,
              });
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                name,
                content: result.output,
              });
            }
          }
        }
        this.messages.push(...toolMessages);
        this.save();
      }

      if (this.stopRequested) {
        this.send({ type: 'done', stopped: true, note: 'Агент остановлен пользователем.' });
      } else {
        this.send({ type: 'done', note: `Достигнут лимит шагов (${config.ai.maxSteps}).` });
      }
    } catch (err) {
      this.send({ type: 'error', message: String((err as Error).message ?? err) });
    } finally {
      this.save();
      this.running = false;
      this.pending.clear();
      this.loopAbort = null;
    }
  }

  private parseCall(call: ToolCall): { name: string; args: Record<string, unknown> } {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      args = { raw: call.function?.arguments ?? '' };
    }
    return { name, args };
  }

  private truncate(text: string): { output: string; truncated: boolean } {
    if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
    return {
      output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n… (вывод обрезан, показано ${MAX_TOOL_OUTPUT} символов)`,
      truncated: true,
    };
  }

  /**
   * Format a shell exec result for the model: the exit code is always
   * included, and a non-zero code is reported as an error so the model
   * sees the failure instead of a silent "ok".
   */
  private execToolResult(result: ExecResult): { status: 'ok' | 'error'; output: string; truncated: boolean } {
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(пустой вывод)';
    const output = `${body}\n(exit code: ${result.code ?? 'unknown'})`;
    if (result.code !== 0) {
      return { status: 'error', ...this.truncate(`Команда завершилась с ошибкой.\n${output}`) };
    }
    return { status: 'ok', ...this.truncate(output) };
  }

  private async runTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ status: 'ok' | 'error'; output: string; truncated: boolean }> {
    try {
      switch (name) {
        case 'exec_readonly': {
          const command = String(args.command ?? '');
          const guard = checkReadOnlyCommand(command);
          if (!guard.ok) {
            return { status: 'error', output: `Отклонено: ${guard.reason}`, truncated: false };
          }
          const result = await exec(this.profile, command, { timeoutMs: 60000 });
          return this.execToolResult(result);
        }
        case 'exec': {
          const command = String(args.command ?? '');
          const result = await exec(this.profile, command, { timeoutMs: 120000 });
          return this.execToolResult(result);
        }
        case 'read_file': {
          const path = String(args.path ?? '');
          const stat = await withSftp(this.profile, (sftp) => sftpStat(sftp, path));
          if ((stat.size ?? 0) > 256 * 1024) {
            return { status: 'error', output: 'Файл больше 256 КБ — используйте exec_readonly (head/tail).', truncated: false };
          }
          const content = await withSftp(this.profile, (sftp) => sftpReadFile(sftp, path, 'utf8'));
          return { status: 'ok', ...this.truncate(content) };
        }
        case 'list_dir': {
          const path = String(args.path ?? '/');
          const entries = await withSftp(this.profile, (sftp) => sftpReaddir(sftp, path));
          const lines = entries.map((e) => {
            const a = e.attrs;
            const isDir = (a.mode & 0o170000) === 0o040000;
            return `${isDir ? 'd' : '-'} ${a.size ?? 0}\t${e.filename}`;
          });
          const output = lines.length ? lines.join('\n') : '(директория пуста)';
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'write_file': {
          const path = String(args.path ?? '');
          const content = String(args.content ?? '');
          await withSftp(this.profile, (sftp) => sftpWriteFile(sftp, path, content));
          return { status: 'ok', output: `Файл ${path} записан (${content.length} символов).`, truncated: false };
        }
        case 'docker_ps': {
          const containers = await listContainers(this.profile);
          const lines = containers.map((c) =>
            `${String(c.ID ?? c.ContainerID ?? '').slice(0, 12)} ${String(c.Image ?? '')} ${String(c.Status ?? '')} ${String(c.Names ?? '')}`,
          );
          return { status: 'ok', ...this.truncate(lines.join('\n') || '(контейнеров нет)') };
        }
        case 'docker_logs': {
          const id = String(args.containerId ?? '');
          const tail = String(args.tail ?? '100');
          const result = await dockerExec(this.profile, ['logs', '--tail', tail, id], { timeoutMs: 60000 });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(логов нет)';
          return { status: 'ok', ...this.truncate(output) };
        }
        case 'docker_inspect': {
          const target = String(args.target ?? '');
          const data = await inspect(this.profile, target);
          return { status: 'ok', ...this.truncate(JSON.stringify(data, null, 2)) };
        }
        case 'docker_action': {
          const action = String(args.action ?? '');
          const target = String(args.target ?? '');
          let output = '';
          switch (action) {
            case 'start':
            case 'stop':
            case 'restart':
              output = await containerAction(this.profile, action, target);
              break;
            case 'rm':
              output = await containerAction(this.profile, 'rm', target);
              break;
            case 'pull':
              output = await pullImage(this.profile, String(args.image ?? ''));
              break;
            case 'rmi':
              output = await removeImage(this.profile, target);
              break;
            case 'run':
              output = await runContainer(this.profile, {
                image: String(args.image ?? ''),
                name: args.name ? String(args.name) : undefined,
                ports: Array.isArray(args.ports) ? args.ports.map(String) : [],
                env: Array.isArray(args.env) ? args.env.map(String) : [],
                command: args.command ? String(args.command) : undefined,
              });
              break;
            default:
              return { status: 'error', output: `Неизвестное действие docker_action: ${action}`, truncated: false };
          }
          return { status: 'ok', output: output || 'Готово.', truncated: false };
        }
        default:
          return { status: 'error', output: `Неизвестный инструмент: ${name}`, truncated: false };
      }
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      return { status: 'error', output: `Ошибка: ${msg}`, truncated: false };
    }
  }
}

const sessions = new Map<string, AgentSession>();

export function attachAgent(ws: WebSocket, profile: Profile, dialogueId?: string): AgentSession {
  const existing = sessions.get(profile.id);
  if (existing) {
    existing.stop();
    try {
      existing.onWsClose();
    } catch {
      /* noop */
    }
  }
  let dialogue: Dialogue | undefined;
  if (dialogueId) {
    const found = getDialogue(dialogueId);
    if (found?.profileId === profile.id) {
      dialogue = found;
    }
  }
  const session = new AgentSession(profile, ws, dialogue);
  sessions.set(profile.id, session);
  session.notifyDialogue();
  ws.on('close', () => {
    session.onWsClose();
    if (sessions.get(profile.id) === session) {
      sessions.delete(profile.id);
    }
  });
  return session;
}
