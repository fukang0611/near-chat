import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { recordAudit } from "../audit-service.js";
import { authenticate, requireAdmin } from "../auth.js";
import { publicAvatarUrl } from "../avatar-service.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { RealtimeHub } from "../realtime.js";

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "USER";
  enabled: boolean;
  avatar_color: string;
  avatar_object_key: string | null;
  avatar_version: number;
  created_at?: Date;
}

interface AuditLogRow {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
  actor_id: string | null;
  actor_display_name: string | null;
  actor_username: string | null;
}

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "用户名至少 3 个字符")
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名只能包含字母、数字、下划线和短横线"),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(6, "密码至少 6 个字符").max(200),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});

const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "没有可更新的字段");

const resetPasswordSchema = z.object({
  password: z.string().min(6, "密码至少 6 个字符").max(200),
});

const avatarPalette = ["#6757E8", "#E76F88", "#2FA98C", "#E08A45", "#4A86D8", "#9A63C7"];

function toAdminUser(row: AdminUserRow, realtime: RealtimeHub) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    enabled: row.enabled,
    online: row.enabled && realtime.isOnline(row.id),
    avatarColor: row.avatar_color,
    avatarUrl: publicAvatarUrl(row.id, row.avatar_object_key, row.avatar_version),
    createdAt: row.created_at?.toISOString(),
  };
}

/** 管理路由模块：账号生命周期以及令牌失效控制。 */
export function createAdminRouter(realtime: RealtimeHub) {
  const router = Router();

  router.get("/admin/users", authenticate, requireAdmin, async (_request, response) => {
    const result = await query<AdminUserRow>(
      `SELECT id, username, display_name, role, enabled, avatar_color,
              avatar_object_key, avatar_version, created_at
           FROM users
          ORDER BY created_at`,
    );
    response.json({
      users: result.rows.map((row) => toAdminUser(row, realtime)),
    });
  });

  router.get("/admin/audit-logs", authenticate, requireAdmin, async (request, response) => {
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(request.query.limit);
    const result = await query<AuditLogRow>(
      `SELECT log.id, log.action, log.target_type, log.target_id, log.details,
              log.created_at, log.actor_id, actor.display_name AS actor_display_name,
              actor.username AS actor_username
         FROM audit_logs log
         LEFT JOIN users actor ON actor.id = log.actor_id
        ORDER BY log.created_at DESC
        LIMIT $1`,
      [limit],
    );
    response.json({
      logs: result.rows.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        details: row.details,
        createdAt: row.created_at.toISOString(),
        actor: row.actor_id
          ? {
              id: row.actor_id,
              displayName: row.actor_display_name ?? "已删除用户",
              username: row.actor_username ?? "unknown",
            }
          : null,
      })),
    });
  });

  router.post("/admin/users", authenticate, requireAdmin, async (request, response) => {
    const admin = currentUser(request);
    const input = createUserSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 10);
    try {
      const result = await transaction(async (client) => {
        const created = await client.query<AdminUserRow>(
          `INSERT INTO users
               (id, username, display_name, password_hash, role, avatar_color)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, username, display_name, role, enabled, avatar_color,
                       avatar_object_key, avatar_version`,
          [
            randomUUID(),
            input.username.toLowerCase(),
            input.displayName,
            passwordHash,
            input.role,
            avatarPalette[Math.floor(Math.random() * avatarPalette.length)],
          ],
        );
        await recordAudit(
          {
            actorId: admin.id,
            action: "ADMIN_USER_CREATE",
            targetType: "USER",
            targetId: created.rows[0].id,
            details: { username: input.username.toLowerCase(), role: input.role },
          },
          client,
        );
        return created;
      });
      response.status(201).json({
        user: toAdminUser(result.rows[0], realtime),
      });
      realtime.sendToUsers(realtime.onlineUserIds(), {
        type: "users.changed",
        payload: { userId: result.rows[0].id },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ApiError(409, "用户名已存在");
      }
      throw error;
    }
  });

  router.patch("/admin/users/:userId", authenticate, requireAdmin, async (request, response) => {
    const admin = currentUser(request);
    const userId = z.string().uuid().parse(request.params.userId);
    const input = updateUserSchema.parse(request.body);
    if (admin.id === userId && input.enabled === false) {
      throw new ApiError(400, "不能禁用当前登录的管理员账号");
    }

    const result = await transaction(async (client) => {
      const updated = await client.query<AdminUserRow>(
        `UPDATE users
              SET display_name = COALESCE($2, display_name),
                  enabled = COALESCE($3, enabled),
                  token_version = token_version + CASE
                    WHEN $3::boolean = FALSE THEN 1 ELSE 0 END,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, username, display_name, role, enabled, avatar_color,
                      avatar_object_key, avatar_version`,
        [userId, input.displayName ?? null, input.enabled ?? null],
      );
      if (updated.rows[0] && input.enabled === false) {
        // 账号禁用是完整撤权：绑定不会在重新启用账号时自动复活，未开始的外部回复和
        // 主动投递在同一事务取消；已处于 PROCESSING/RUNNING 的极窄窗口可能完成。
        await client.query(
          `UPDATE connector_bindings SET enabled=FALSE,updated_at=NOW()
            WHERE owner_id=$1 AND enabled=TRUE`,
          [userId],
        );
        await client.query(
          `UPDATE connector_events event
              SET status='CANCELLED',lease_expires_at=NULL,
                  error_message=COALESCE(event.error_message,'所属账号已停用')
            WHERE event.status IN ('RECEIVED','FAILED')
              AND EXISTS (
                SELECT 1 FROM connector_bindings binding
                 WHERE binding.owner_id=$1
                   AND binding.connector_id=event.connector_id
                   AND binding.external_conversation_id=event.external_conversation_id
              )`,
          [userId],
        );
        await client.query(
          `UPDATE connector_delivery_jobs job
              SET status='CANCELLED',lease_expires_at=NULL,
                  error_message=COALESCE(job.error_message,'所属账号已停用'),updated_at=NOW()
            WHERE job.status IN ('QUEUED','FAILED')
              AND EXISTS (
                SELECT 1 FROM connector_bindings binding
                 WHERE binding.owner_id=$1 AND binding.id::text=job.payload->>'bindingId'
              )`,
          [userId],
        );
      }
      if (updated.rows[0]) {
        await recordAudit(
          {
            actorId: admin.id,
            action: "ADMIN_USER_UPDATE",
            targetType: "USER",
            targetId: userId,
            details: input,
          },
          client,
        );
      }
      return updated;
    });
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "用户不存在");

    // 禁用时令牌版本已经递增，再主动断开实时连接让失效立即生效。
    if (!row.enabled) realtime.disconnectUser(row.id);
    realtime.sendToUsers(realtime.onlineUserIds(), {
      type: "users.changed",
      payload: { userId: row.id },
    });
    response.json({ user: toAdminUser(row, realtime) });
  });

  router.post(
    "/admin/users/:userId/reset-password",
    authenticate,
    requireAdmin,
    async (request, response) => {
      const admin = currentUser(request);
      const userId = z.string().uuid().parse(request.params.userId);
      const input = resetPasswordSchema.parse(request.body);
      const passwordHash = await bcrypt.hash(input.password, 10);
      const result = await transaction(async (client) => {
        const updated = await client.query(
          `UPDATE users
              SET password_hash = $2, token_version = token_version + 1,
                  updated_at = NOW()
            WHERE id = $1`,
          [userId, passwordHash],
        );
        if (updated.rowCount) {
          await recordAudit(
            {
              actorId: admin.id,
              action: "ADMIN_PASSWORD_RESET",
              targetType: "USER",
              targetId: userId,
            },
            client,
          );
        }
        return updated;
      });
      if (result.rowCount === 0) throw new ApiError(404, "用户不存在");

      realtime.disconnectUser(userId);
      response.status(204).end();
    },
  );

  router.post(
    "/admin/users/:userId/force-logout",
    authenticate,
    requireAdmin,
    async (request, response) => {
      const admin = currentUser(request);
      const userId = z.string().uuid().parse(request.params.userId);
      if (admin.id === userId) throw new ApiError(400, "不能强制退出当前管理员账号");

      const result = await transaction(async (client) => {
        const updated = await client.query(
          `UPDATE users
              SET token_version = token_version + 1, updated_at = NOW()
            WHERE id = $1`,
          [userId],
        );
        if (updated.rowCount) {
          await recordAudit(
            {
              actorId: admin.id,
              action: "ADMIN_FORCE_LOGOUT",
              targetType: "USER",
              targetId: userId,
            },
            client,
          );
        }
        return updated;
      });
      if (result.rowCount === 0) throw new ApiError(404, "用户不存在");
      realtime.disconnectUser(userId);
      response.status(204).end();
    },
  );

  return router;
}
