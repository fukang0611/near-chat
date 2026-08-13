import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";
import type { AuthUser } from "./auth.js";
import { publicAvatarUrl } from "./avatar-service.js";
import { config } from "./config.js";

/** 可安全暴露给客户端的业务错误。未识别错误统一按 500 处理。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 鉴权中间件已保证 request.user 存在；此函数把该不变量收敛在一处，
 * 避免每个路由重复可选链和 401 响应。
 */
export function currentUser(request: Request): AuthUser {
  if (!request.user) throw new ApiError(401, "请先登录");
  return request.user;
}

/** 令牌版本仅用于服务端失效控制，绝不返回给浏览器。 */
export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    avatarColor: user.avatarColor,
    avatarUrl: publicAvatarUrl(user.id, user.avatarObjectKey, user.avatarVersion),
  };
}

/** Express 最后一层错误适配器：把内部错误稳定映射为统一 JSON 结构。 */
export function apiErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    response.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({
      message: error.issues[0]?.message ?? "请求参数不正确",
    });
    return;
  }
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? error.field === "avatar"
          ? `头像不能超过 ${Math.round(config.avatarMaxBytes / 1024 / 1024)} MB`
          : `文件不能超过 ${Math.round(config.fileMaxBytes / 1024 / 1024)} MB`
        : "文件上传失败";
    response.status(400).json({ message });
    return;
  }

  const httpStatus =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  if (httpStatus === 400) {
    response.status(400).json({ message: "请求内容不是有效的 JSON" });
    return;
  }
  if (httpStatus === 413) {
    response.status(413).json({ message: "请求内容过大" });
    return;
  }

  console.error(error);
  response.status(500).json({ message: "服务暂时不可用，请稍后重试" });
}
