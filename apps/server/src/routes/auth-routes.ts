import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { authenticate, signToken, type AuthUser } from "../auth.js";
import { query } from "../database.js";
import { ApiError, currentUser, publicUser } from "../http.js";

interface LoginUserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "ADMIN" | "USER";
  enabled: boolean;
  avatar_color: string;
  token_version: number;
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(200),
});

function toAuthUser(row: LoginUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarColor: row.avatar_color,
    tokenVersion: row.token_version,
  };
}

/** 登录态路由模块：签发令牌，恢复当前用户，并提供客户端退出语义。 */
export function createAuthRouter() {
  const router = Router();

  router.post("/auth/login", async (request, response) => {
    const input = loginSchema.parse(request.body);
    const result = await query<LoginUserRow>(
      `SELECT id, username, display_name, password_hash, role, enabled,
              avatar_color, token_version
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

  // JWT 本身无服务端会话；客户端清理令牌即完成普通退出。
  router.post("/auth/logout", authenticate, (_request, response) => {
    response.status(204).end();
  });

  return router;
}
