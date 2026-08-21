import type { SyncChange } from "@near-chat/domain";

export interface PullPage {
  changes: SyncChange[];
  cursor: string;
  hasMore: boolean;
}

export interface PullPageEffects {
  fetchPage(): Promise<PullPage>;
  applyChange(change: SyncChange): Promise<"APPLIED" | "DEFERRED" | "BLOCKED">;
  commitCursor(cursor: string): Promise<void>;
  shouldContinue(): boolean;
}

export function shouldRepeatBlockedPull(
  hasPendingOutbox: boolean,
  blockedChanges: readonly Pick<SyncChange, "entityType" | "entityId">[],
  persistedConflicts: readonly { entityType: string; entityId: string }[],
): boolean {
  if (hasPendingOutbox) return true;
  return blockedChanges.some(
    (change) =>
      !persistedConflicts.some(
        (conflict) =>
          conflict.entityType === change.entityType && conflict.entityId === change.entityId,
      ),
  );
}

function assertActive(shouldContinue: () => boolean): void {
  if (!shouldContinue()) throw new Error("同步已取消");
}

/** HTTP 可在途很久；响应回来后逐条执行原子 pending-outbox 检查，整页无 BLOCKED 才提交 cursor。 */
export async function consumePullPage(
  effects: PullPageEffects,
): Promise<{ page: PullPage; blocked: boolean; blockedChanges: SyncChange[] }> {
  assertActive(effects.shouldContinue);
  const page = await effects.fetchPage();
  assertActive(effects.shouldContinue);
  const blockedChanges: SyncChange[] = [];
  for (const change of page.changes) {
    assertActive(effects.shouldContinue);
    if ((await effects.applyChange(change)) === "BLOCKED") blockedChanges.push(change);
  }
  const blocked = blockedChanges.length > 0;
  if (!blocked) {
    assertActive(effects.shouldContinue);
    await effects.commitCursor(page.cursor);
  }
  return { page, blocked, blockedChanges };
}
