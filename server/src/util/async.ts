/**
 * Guard timeout around a promise: a slow or hung call gets rejected with a
 * readable message instead of waiting forever. Extracted from
 * `services/overview.ts` (where it lived as a private helper) for reuse by
 * subsystems that need the same per-profile guard — e.g. parallel snippet
 * runs.
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
