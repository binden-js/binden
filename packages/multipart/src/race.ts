/**
 * Calls `fn` and settles like its result, unless `signal` is aborted first
 * (or already): it then rejects with the reason of the signal, and a later
 * rejection of the result is observed, never an `unhandledRejection`
 */
export async function race<T>(
  fn: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = (): void => {
    reject(signal.reason as Error);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = new Promise<T>((settle) => {
      settle(fn());
    });
    // Also observes a rejection of `result` that comes after the abort
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
