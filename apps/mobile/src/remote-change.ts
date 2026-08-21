import type { SyncEntityType, SyncOperationKind } from "@near-chat/domain";
import type { PersonalReminder } from "./models";

export interface RemoteDeleteChange {
  operation: SyncOperationKind;
  entityType: SyncEntityType;
  entityId: string;
}

export interface RemoteDeleteEffects {
  cancelReminder(entityId: string): Promise<void>;
  removeEntity(entityType: SyncEntityType, entityId: string): Promise<void>;
  /** 提醒删除可注入“取消通知 + 删除 Room”的同一串行临界区。 */
  removeReminder?(entityId: string): Promise<void>;
}

export interface RemoteUpsertEffects<T> {
  saveEntity(entity: T): Promise<void>;
  scheduleReminder(reminder: PersonalReminder): Promise<unknown>;
  cancelReminder?(entityId: string): Promise<void>;
  shouldContinue?(): boolean;
}

/**
 * 远端提醒 tombstone 必须先撤销系统调度，再删除 Room 实体；否则剩余列表已无法找到并清理通知。
 * 副作用通过参数注入，保持同步编排可测试且不让通知模块反向依赖 sync.ts。
 */
export async function applyRemoteDelete(
  change: RemoteDeleteChange,
  effects: RemoteDeleteEffects,
): Promise<boolean> {
  if (change.operation !== "DELETE") return false;
  if (change.entityType === "PERSONAL_REMINDER") {
    if (effects.removeReminder) {
      await effects.removeReminder(change.entityId);
      return true;
    }
    await effects.cancelReminder(change.entityId);
  }
  await effects.removeEntity(change.entityType, change.entityId);
  return true;
}

/** 远端提醒写入 Room 后立即重建或撤销系统调度，不依赖用户是否打开“任务”页。 */
export async function applyRemoteUpsert<T>(
  entityType: SyncEntityType,
  entity: T,
  effects: RemoteUpsertEffects<T>,
): Promise<void> {
  await effects.saveEntity(entity);
  if (entityType === "PERSONAL_REMINDER") {
    if (effects.shouldContinue && !effects.shouldContinue()) return;
    await effects.scheduleReminder(entity as PersonalReminder);
    if (effects.shouldContinue && !effects.shouldContinue()) {
      await effects.cancelReminder?.((entity as PersonalReminder).id);
    }
  }
}
