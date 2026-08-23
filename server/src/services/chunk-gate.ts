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

/**
 * Возвращает функцию записи чанка в response с дропом при переполнении
 * сокета и маркером «пропущено N байт» при возврате в норму.
 */
export function createChunkGate(res: ServerResponse): (chunk: string) => void {
  let dropped = 0;
  return (chunk: string) => {
    if (res.destroyed) return;
    if (res.writableLength > GATE_LIMIT_BYTES) {
      dropped += chunk.length;
      return;
    }
    if (dropped > 0) {
      const marker = `\n… (пропущено ${dropped} байт: сервер занят)\n`;
      dropped = 0;
      res.write(marker);
    }
    res.write(chunk);
  };
}
