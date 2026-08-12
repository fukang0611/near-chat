import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "./database.js";

export interface AuditInput {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * 写入不含敏感字段的操作审计。传入事务客户端时，业务变更与日志会一起提交；
 * 普通登录等单步动作则直接使用连接池。
 */
export async function recordAudit(input: AuditInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO audit_logs
                 (id, actor_id, action, target_type, target_id, details)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`;
  const values = [
    randomUUID(),
    input.actorId,
    input.action,
    input.targetType,
    input.targetId ?? null,
    JSON.stringify(input.details ?? {}),
  ];
  if (client) {
    await client.query(sql, values);
    return;
  }
  await query(sql, values);
}
