import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { streamChatCompletion, type ChatMessage, type ToolCall } from './client.js';
import { sanitizeMessages } from './messages.js';
import { toolDefs, READ_ONLY_TOOLS } from './tools.js';
import { checkReadOnlyCommand } from './guard.js';
import { readMemory, writeMemory, memoryPromptBlock } from './memory.js';
import { exec, withSftp } from '../ssh/manager.js';
import {
  readFile as sftpReadFile,
  readdir as sftpReaddir,
  writeFile as sftpWriteFile,
  stat as sftpStat,
} from '../ssh/sftp.js';
import type { Profile } from '../types.js';
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

  constructor(
    private profile: Profile,
    private ws: WebSocket,
    dialogue?: Dialogue,
  ) {
    this.dialogueId = dialogue?.id ?? createDialogue(profile.id).id;
    let systemPrompt =
      'Ты — AI-ассистент для администрирования удалённого Linux-сервера ' +
      `${profile.username}@${profile.host}. ` +
      'Ты работаешь только через предоставленные инструменты, не выдумывай результаты. ' +
      'Инструменты чтения (exec_readonly, read_file, list_dir, docker_ps, docker_logs, docker_inspect, read_memory) выполняются автоматически. ' +
      'Инструменты записи (exec, write_file, docker_action, write_memory) требуют подтверждения пользователя — не пытайся обойти это ограничение, ' +
      'запрашивай подтверждение обычным вызовом инструмента. ' +
      'Отвечай кратко и по делу на русском. Сначала собери факты (проверь состояние), затем предлагай действия. ' +
      'Перед разрушительными действиями предупреждай о последствиях. ' +
      'У профиля есть MEMORY.md — файл заметок для будущих сессий (хранится в каталоге данных приложения, не на сервере). ' +
      'Его содержимое автоматически загружается в контекст в начале каждой сессии — см. блок «Память профиля» ниже. ' +
      'Прежде чем заново исследовать сервер, сверься с памятью: если ответ там уже есть, не ищи его заново; ' +
      'в длинной сессии используй read_memory, чтобы вернуть полный текст памяти в контекст. ' +
      'Записывай в память только важное и долговечное: неочевидные команды и конфиги, пути, порты, архитектуру сервисов, ' +
      'решённые проблемы и их причины, грабли и ограничения. Не сохраняй секреты (пароли, ключи, токены), временные данные и шум логов. ' +
      'Предлагай запись через write_memory после того, как нашёл такое знание; пиши кратко и структурированно (markdown: заголовки, короткие пункты). ' +
      'write_memory принимает полный новый текст файла: обязательно сохраняй все прежние записи и только добавляй/правь нужное, без дублей. ' +
      'Не записывай память через exec/write_file — только через write_memory.';
    const memoryBlock = memoryPromptBlock(profile.id);
    if (memoryBlock) {
      systemPrompt += `\n\n${memoryBlock}`;
    }
    this.messages.push({
      role: 'system',
      content: systemPrompt,
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

  notifyDialogue(): void {
    this.send({ type: 'dialogue', id: this.dialogueId });
  }

  handleClientMessage(data: WsMessage): void {
    switch (data.type) {
      case 'message': {
        const content = String(data.content ?? '').trim();
        if (content && !this.running) {
          void this.runLoop(content);
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
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(пустой вывод)';
          return {
            status: 'ok',
            ...this.truncate(output),
          };
        }
        case 'exec': {
          const command = String(args.command ?? '');
          const result = await exec(this.profile, command, { timeoutMs: 120000 });
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(пустой вывод)';
          return {
            status: 'ok',
            ...this.truncate(output),
          };
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
        case 'read_memory': {
          const content = readMemory(this.profile.id);
          return {
            status: 'ok',
            ...this.truncate(content ?? '(MEMORY.md пока нет — записей из прошлых сессий нет)'),
          };
        }
        case 'write_memory': {
          const content = String(args.content ?? '');
          if (!content.trim()) {
            return { status: 'error', output: 'Пустое содержимое MEMORY.md — запись отменена.', truncated: false };
          }
          const { bytes } = writeMemory(this.profile.id, content);
          return { status: 'ok', output: `MEMORY.md обновлён (${bytes} байт).`, truncated: false };
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
