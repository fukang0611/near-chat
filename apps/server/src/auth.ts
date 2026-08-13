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
  avatarObjectKey: string | null;
  avatarVersion: number;
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
  tokenVersion: number;
}

export interface AuthUserRow {
  id: string;
  username: string;
  display_name: string;
  role: "ADMIN" | "USER";
  avatar_color: string;
  avatar_object_key: string | null;
  avatar_version: number;
  status_text: string | null;
  status_emoji: string | null;
  status_expires_at: Date | null;
  token_version: number;
  enabled: boolean;
}

export function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    avatarColor: row.avatar_color,
    avatarObjectKey: row.avatar_object_key,
    avatarVersion: row.avatar_version,
    statusText: row.status_text,
    statusEmoji: row.status_emoji,
    statusExpiresAt: row.status_expires_at,
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

    const result = await query<AuthUserRow>(
      `SELECT id, username, display_name, role, avatar_color, avatar_object_key,
              avatar_version, status_text, status_emoji, status_expires_at,
              token_version, enabled
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
