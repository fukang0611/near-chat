import type { NextFunction, Request, Response } from "express";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { config } from "./config.js";
import { query } from "./database.js";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "USER";
  avatarColor: string;
  tokenVersion: number;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "USER";
  avatar_color: string;
  token_version: number;
  enabled: boolean;
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarColor: row.avatar_color,
    tokenVersion: row.token_version,
  };
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ version: user.tokenVersion }, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
  });
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

export async function userFromToken(token: string): Promise<AuthUser | null> {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload & {
      version?: number;
    };
    if (!payload.sub || typeof payload.version !== "number") return null;

    const result = await query<UserRow>(
      `SELECT id, username, display_name, role, avatar_color, token_version, enabled
         FROM users
        WHERE id = $1`,
      [payload.sub],
    );
    const row = result.rows[0];
    if (!row?.enabled || row.token_version !== payload.version) return null;
    return toAuthUser(row);
  } catch {
    return null;
  }
}

export async function authenticate(request: Request, response: Response, next: NextFunction) {
  const token = bearerToken(request);
  const user = token ? await userFromToken(token) : null;
  if (!user) {
    response.status(401).json({ message: "登录状态已失效，请重新登录" });
    return;
  }
  request.user = user;
  next();
}

export function requireAdmin(request: Request, response: Response, next: NextFunction) {
  if (request.user?.role !== "ADMIN") {
    response.status(403).json({ message: "需要管理员权限" });
    return;
  }
  next();
}
