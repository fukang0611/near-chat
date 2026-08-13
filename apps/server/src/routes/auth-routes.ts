import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { recordAudit } from "../audit-service.js";
import { authenticate, signToken, toAuthUser, type AuthUserRow } from "../auth.js";
import { query, transaction } from "../database.js";
import { ApiError, currentUser, publicUser } from "../http.js";
import { RealtimeHub } from "../realtime.js";

interface LoginUserRow extends AuthUserRow {
  password_hash: string;
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(200),
});

const avatarPalette = ["#6757E8", "#E76F88", "#2FA98C", "#E08A45", "#4A86D8", "#9A63C7"] as const;

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1, "显示名称不能为空").max(80).optional(),
    avatarColor: z.enum(avatarPalette).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "没有可更新的资料");

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(6, "新密码至少 6 个字符").max(200),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "新密码不能与当前密码相同",
    path: ["newPassword"],
  });

/** 登录态路由模块：签发令牌，恢复当前用户，并提供客户端退出语义。 */
export function createAuthRouter(realtime: RealtimeHub) {
  const router = Router();

  router.post("/auth/login", async (request, response) => {
    const input = loginSchema.parse(request.body);
    const result = await query<LoginUserRow>(
      `SELECT id, username, display_name, password_hash, role, enabled,
              avatar_color, avatar_object_key, avatar_version, token_version
         FROM users
        WHERE username = $1`,
      [input.username.toLowerCase()],
    );
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(input.password, row.password_hash))) {
      throw new ApiError(401, "用户名或密码错误");
    }
    if (!row.enabled) throw new ApiError(403, "账号已被禁用");

    const user = toAuthUser(row);
    response.json({ token: signToken(user), user: publicUser(user) });
  });

  router.get("/auth/me", authenticate, (request, response) => {
    response.json({ user: publicUser(currentUser(request)) });
  });

  router.patch("/auth/profile", authenticate, async (request, response) => {
    const user = currentUser(request);
    const input = profileSchema.parse(request.body);
    const updated = await transaction(async (client) => {
      const result = await client.query<LoginUserRow>(
        `UPDATE users
            SET display_name = COALESCE($2, display_name),
                avatar_color = COALESCE($3, avatar_color),
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, username, display_name, password_hash, role, enabled,
                    avatar_color, avatar_object_key, avatar_version, token_version`,
        [user.id, input.displayName ?? null, input.avatarColor ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError(404, "用户不存在");
      await recordAudit(
        {
          actorId: user.id,
          action: "PROFILE_UPDATE",
          targetType: "USER",
          targetId: user.id,
          details: {
            displayNameChanged: input.displayName !== undefined,
            avatarColorChanged: input.avatarColor !== undefined,
          },
        },
        client,
      );
      return toAuthUser(row);
    });

    realtime.sendToUsers(realtime.onlineUserIds(), {
      type: "users.changed",
      payload: { userId: user.id },
    });
    response.json({ user: publicUser(updated) });
  });

  router.post("/auth/change-password", authenticate, async (request, response) => {
    const user = currentUser(request);
    const input = changePasswordSchema.parse(request.body);
    const nextPasswordHash = await bcrypt.hash(input.newPassword, 10);
    await transaction(async (client) => {
      // 锁定账号后再校验旧密码，避免两个并发改密请求都基于同一份旧摘要成功。
      const password = await client.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
        [user.id],
      );
      const passwordHash = password.rows[0]?.password_hash;
      if (!passwordHash || !(await bcrypt.compare(input.currentPassword, passwordHash))) {
        throw new ApiError(400, "当前密码不正确");
      }
      await client.query(
        `UPDATE users
            SET password_hash = $2, token_version = token_version + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [user.id, nextPasswordHash],
      );
      await recordAudit(
        {
          actorId: user.id,
          action: "PASSWORD_CHANGE",
          targetType: "USER",
          targetId: user.id,
        },
        client,
      );
    });

    // 先完成 HTTP 响应，再关闭该账号的全部实时连接；客户端随后回到登录页。
    response.status(204).end();
    setImmediate(() => realtime.disconnectUser(user.id));
  });

  // JWT 本身无服务端会话；客户端清理令牌即完成普通退出。
  router.post("/auth/logout", authenticate, (_request, response) => {
    response.status(204).end();
  });

  return router;
}
