/**
 * 系统通知 ID 只由 reminderId 决定，因此串行键也必须只用 reminderId；若把 accountKey
 * 放进键里，LOCAL -> 团队迁移前后的两个队列会并发操作同一个 Android alarm。
 */
export class ReminderCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();

  private serialize<T>(reminderId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(reminderId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.queues.set(reminderId, current);
    const cleanup = () => {
      if (this.queues.get(reminderId) === current) this.queues.delete(reminderId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  reconcile<T extends { id: string }>(
    reminderId: string,
    load: () => Promise<T | null>,
    schedule: (reminder: T) => Promise<boolean>,
    cancel: (reminderId: string) => Promise<void>,
    shouldContinue: () => boolean = () => true,
  ): Promise<boolean> {
    return this.serialize(reminderId, async () => {
      if (!shouldContinue()) return false;
      const reminder = await load();
      if (!shouldContinue()) return false;
      if (!reminder) {
        await cancel(reminderId);
        return false;
      }
      const scheduled = await schedule(reminder);
      if (!shouldContinue()) {
        await cancel(reminderId);
        return false;
      }
      return scheduled;
    });
  }

  cancelThen<T>(
    reminderId: string,
    cancel: (reminderId: string) => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.serialize(reminderId, async () => {
      await cancel(reminderId);
      return operation();
    });
  }
}
