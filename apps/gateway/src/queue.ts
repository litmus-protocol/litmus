/** Runs tasks strictly one after another, in submission order (build plan §10.1: one operator nonce). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive whether the task succeeds or fails.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
