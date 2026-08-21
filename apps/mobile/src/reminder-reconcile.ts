import { listEntities } from "./native";
import { cancelReminder, scheduleReminder } from "./notifications";
import { runAccountMutation } from "./account-mutations";
import { ReminderCoordinator } from "./reminder-coordinator";

const coordinator = new ReminderCoordinator();

/**
 * 所有来源在真正写 OS alarm 前都重新读取 Room 最新版本，并按 reminderId 串行。
 * 旧页面的 r1 reconcile 即使最后入队，也只会重放当前 r2，不能把通知回退。
 */
export async function reconcileCurrentReminder(
  accountKey: string,
  reminderId: string,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  return runAccountMutation(accountKey, (effectiveAccountKey) =>
    coordinator.reconcile(
      reminderId,
      async () =>
        (await listEntities(effectiveAccountKey, "PERSONAL_REMINDER")).find(
          (candidate) => candidate.id === reminderId,
        ) ?? null,
      scheduleReminder,
      cancelReminder,
      shouldContinue,
    ),
  );
}

/** 取消与删除/替换处于同一物理 notificationId 队列，保证最终状态不会被旧 schedule 覆盖。 */
export async function cancelThenMutateReminder<T>(
  accountKey: string,
  reminderId: string,
  operation: (effectiveAccountKey: string) => Promise<T>,
): Promise<T> {
  return runAccountMutation(accountKey, (effectiveAccountKey) =>
    coordinator.cancelThen(reminderId, cancelReminder, () => operation(effectiveAccountKey)),
  );
}

export async function reconcileCurrentReminderAccount(
  accountKey: string,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const reminders = await runAccountMutation(accountKey, (effectiveAccountKey) =>
    listEntities(effectiveAccountKey, "PERSONAL_REMINDER"),
  );
  if (!shouldContinue()) return;
  for (const reminder of reminders) {
    await reconcileCurrentReminder(accountKey, reminder.id, shouldContinue);
    if (!shouldContinue()) return;
  }
}

/** 强制取消也走同一队列，保证它发生在更早的在途 schedule 之后。 */
export async function cancelCurrentReminderAccount(accountKey: string): Promise<void> {
  const reminders = await listEntities(accountKey, "PERSONAL_REMINDER");
  for (const reminder of reminders) {
    await coordinator.cancelThen(reminder.id, cancelReminder, async () => undefined);
  }
}
