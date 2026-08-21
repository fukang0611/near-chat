import type { SyncChange } from "@near-chat/domain";

export type RemoteSyncApplyResult = "APPLIED" | "BLOCKED";

export interface RemoteSyncApplyEffects {
  settle(change: SyncChange): Promise<boolean>;
  reconcileReminder(entityId: string): Promise<void>;
}

/**
 * 只有原子存储层确认没有更新的本地 outbox 时才触发提醒副作用。提醒统一重读当前
 * Room 实体，避免 HTTP 响应里的旧 scheduledAt 覆盖请求期间的新编辑。
 */
export async function applyRemoteSyncChange(
  change: SyncChange,
  effects: RemoteSyncApplyEffects,
): Promise<RemoteSyncApplyResult> {
  const applied = await effects.settle(change);
  if (change.entityType === "PERSONAL_REMINDER") {
    // BLOCKED 时也必须重读当前 Room：DELETE 已先取消旧 alarm，需要恢复请求期间的新本地编辑。
    await effects.reconcileReminder(change.entityId);
  }
  return applied ? "APPLIED" : "BLOCKED";
}
