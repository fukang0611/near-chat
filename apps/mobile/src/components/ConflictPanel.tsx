import { useState } from "react";
import type { StoredSyncConflict } from "../models";
import { canRetryLocalConflict, conflictLabel, isConflictServerDeleted } from "../sync-logic";
import {
  acceptServerConflict,
  completeLocalMemoryConflictRetry,
  retryLocalConflict,
} from "../sync";

interface Props {
  conflicts: StoredSyncConflict[];
  onResolved(): Promise<void>;
  onRetrySync(): Promise<boolean>;
  isActive(): boolean;
}

export function ConflictPanel({ conflicts, onResolved, onRetrySync, isActive }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const resolve = async (conflict: StoredSyncConflict, mode: "SERVER" | "LOCAL") => {
    setBusyId(conflict.operationId);
    setError("");
    try {
      if (mode === "SERVER") {
        await acceptServerConflict(conflict, isActive);
        await onResolved();
      } else {
        const retryOperationId = await retryLocalConflict(conflict, isActive);
        if (conflict.reason !== "MEMORY_MERGE_REQUIRED") await onResolved();
        if (!(await onRetrySync())) throw new Error("同步未完成，已保留本地变更供稍后重试");
        if (conflict.reason === "MEMORY_MERGE_REQUIRED") {
          await completeLocalMemoryConflictRetry(conflict, retryOperationId);
        }
        await onResolved();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "冲突处理失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <aside className="conflict-panel" aria-live="polite">
      <strong>同步冲突</strong>
      {conflicts.map((conflict) => (
        <div key={conflict.operationId} className="conflict-item">
          <div>
            <span>{conflict.entityType}</span>
            <p>{conflictLabel(conflict.reason)}</p>
          </div>
          <div className="button-row">
            <button
              className="secondary"
              disabled={busyId === conflict.operationId}
              onClick={() => void resolve(conflict, "SERVER")}
            >
              采用服务器
            </button>
            {canRetryLocalConflict(
              conflict.entityType,
              conflict.reason,
              isConflictServerDeleted(conflict),
            ) && (
              <button
                disabled={busyId === conflict.operationId}
                onClick={() => void resolve(conflict, "LOCAL")}
              >
                保留本机并重试
              </button>
            )}
          </div>
        </div>
      ))}
      {error && <small className="error-text">{error}</small>}
    </aside>
  );
}
