/**
 * Guard-таймаут вокруг промиса: медленный или зависший вызов отвергается
 * понятным текстом вместо вечного ожидания. Вынесен из `services/overview.ts`
 * (там оставался приватным) для переиспользования подсистемами, которым нужен
 * тот же guard на профиль — например, параллельный запуск сниппетов.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
