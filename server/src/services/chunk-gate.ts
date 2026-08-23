import type { ServerResponse } from 'node:http';

/**
 * Гейт backpressure для follow-стримов (эпик 13, по плану эпика 14).
 *
 * План эпика 14 рассмотрел паузу SSH-канала по `res.write() === false` с
 * возобновлением по `drain` и **отклонил**: это требует вывода канала наружу
 * через API `execStream`. Принятый механизм — гейт на стороне роута: при
 * `res.writableLength > 1 МБ` чанки дропаются с подсчётом, при возврате в
 * норму в тело пишется маркер «пропущено N байт». Для просмотрщика с
 * кольцевым буфером потеря середины — честная цена (без гейта болтливый
 * unit/контейнер раздувает память Node безгранично).
 */
const GATE_LIMIT_BYTES = 1024 * 1024;

export interface ChunkWriter {
  (chunk: string): void;
  /**
   * Маркер для байтов, дропнутых до самого конца стрима (новые чанки их уже
   * не вернут). Роут зовёт на settle `handle.code`, иначе пользователь не
   * узнает о потере.
   */
  finish(): void;
}

/**
 * Возвращает функцию записи чанка в response с дропом при переполнении
 * сокета и маркером «пропущено N байт» при возврате в норму. Метод
 * `finish()` закрывает маркером стрим, завершившийся в состоянии дропа.
 */
export function createChunkGate(res: ServerResponse): ChunkWriter {
  let dropped = 0;
  const writeMarker = (): void => {
    if (dropped > 0 && !res.destroyed) {
      res.write(`\n… (пропущено ${dropped} байт: сервер занят)\n`);
      dropped = 0;
    }
  };
  const write = (chunk: string): void => {
    if (res.destroyed) return;
    if (res.writableLength > GATE_LIMIT_BYTES) {
      dropped += chunk.length;
      return;
    }
    writeMarker();
    res.write(chunk);
  };
  (write as ChunkWriter).finish = writeMarker;
  return write as ChunkWriter;
}
