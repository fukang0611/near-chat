import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin } from "../auth.js";
import { query } from "../database.js";
import { ApiError, currentUser } from "../http.js";
import { RealtimeHub } from "../realtime.js";

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "USER";
  enabled: boolean;
  avatar_color: string;
  created_at?: Date;
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
    createdAt: row.created_at?.toISOString(),
  };
}

/** 管理路由模块：账号生命周期以及令牌失效控制。 */
export function createAdminRouter(realtime: RealtimeHub) {
  const router = Router();

  router.get("/admin/users", authenticate, requireAdmin, async (_request, response) => {
    const result = await query<AdminUserRow>(
      `SELECT id, username, display_name, role, enabled, avatar_color, created_at
           FROM users
          ORDER BY created_at`,
    );
    response.json({
      users: result.rows.map((row) => toAdminUser(row, realtime)),
    });
  });

  router.post("/admin/users", authenticate, requireAdmin, async (request, response) => {
    const input = createUserSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(input.password, 10);
    try {
      const result = await query<AdminUserRow>(
        `INSERT INTO users
             (id, username, display_name, password_hash, role, avatar_color)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, username, display_name, role, enabled, avatar_color`,
        [
          randomUUID(),
          input.username.toLowerCase(),
          input.displayName,
          passwordHash,
          input.role,
          avatarPalette[Math.floor(Math.random() * avatarPalette.length)],
        ],
      );
      response.status(201).json({
        user: toAdminUser(result.rows[0], realtime),
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

    const result = await query<AdminUserRow>(
      `UPDATE users
            SET display_name = COALESCE($2, display_name),
                enabled = COALESCE($3, enabled),
                token_version = token_version + CASE
                  WHEN $3::boolean = FALSE THEN 1 ELSE 0 END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, username, display_name, role, enabled, avatar_color`,
      [userId, input.displayName ?? null, input.enabled ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, "用户不存在");

    // 禁用时令牌版本已经递增，再主动断开实时连接让失效立即生效。
    if (!row.enabled) realtime.disconnectUser(row.id);
    response.json({ user: toAdminUser(row, realtime) });
  });

  router.post(
    "/admin/users/:userId/reset-password",
    authenticate,
    requireAdmin,
    async (request, response) => {
      const userId = z.string().uuid().parse(request.params.userId);
      const input = resetPasswordSchema.parse(request.body);
      const passwordHash = await bcrypt.hash(input.password, 10);
      const result = await query(
        `UPDATE users
            SET password_hash = $2, token_version = token_version + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [userId, passwordHash],
      );
      if (result.rowCount === 0) throw new ApiError(404, "用户不存在");

      realtime.disconnectUser(userId);
      response.status(204).end();
    },
  );

  return router;
}
