import type { SyncChange } from "@near-chat/domain";
import type { MobileEntity, StoredOutboxOperation } from "./models";

export interface BrowserRemoteSettlementEffects {
  readOutbox(): StoredOutboxOperation[];
  writeOutbox(operations: StoredOutboxOperation[]): void;
  saveEntity(entity: MobileEntity): void;
  removeEntity(): void;
}

/**
 * 浏览器 fallback 没有数据库事务；这里故意保持同步、无 await，使 outbox 检查、精确 ACK
 * 与实体 RMW 位于同一个 JS task。写实体后若 ACK 写盘失败，旧操作仍会幂等重放。
 */
export function settleBrowserRemoteChange(
  accountKey: string,
  change: SyncChange,
  acknowledgedOperationIds: readonly string[],
  effects: BrowserRemoteSettlementEffects,
): boolean {
  const acknowledged = new Set(acknowledgedOperationIds);
  const remaining = effects
    .readOutbox()
    .filter((operation) => !acknowledged.has(operation.operationId));
  const pendingIndex = remaining.findIndex(
    (operation) =>
      operation.accountKey === accountKey &&
      operation.entityType === change.entityType &&
      operation.entityId === change.entityId,
  );

  if (pendingIndex >= 0) {
    if (acknowledged.size) {
      const pending = remaining[pendingIndex]!;
      remaining[pendingIndex] = {
        ...pending,
        baseRevision:
          pending.baseRevision === null
            ? change.revision
            : Math.max(pending.baseRevision, change.revision),
      };
      effects.writeOutbox(remaining);
    }
    return false;
  }

  if (change.operation === "DELETE") {
    effects.removeEntity();
  } else {
    effects.saveEntity({
      ...(change.payload as Record<string, unknown>),
      id: change.entityId,
      revision: change.revision,
    } as MobileEntity);
  }
  if (acknowledged.size) effects.writeOutbox(remaining);
  return true;
}
