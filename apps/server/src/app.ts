import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { pool } from "./database.js";
import { apiErrorHandler } from "./http.js";
import { minio } from "./minio.js";
import { RealtimeHub } from "./realtime.js";
import { createAdminRouter } from "./routes/admin-routes.js";
import { createAuthRouter } from "./routes/auth-routes.js";
import { createChatRouter } from "./routes/chat-routes.js";
import { createFileRouter } from "./routes/file-routes.js";

/**
 * 组装 NearChat HTTP 应用。
 *
 * 这里仅保留跨领域的装配顺序：基础中间件、领域路由、静态资源和统一错误处理。
 * 各领域的参数校验、数据库访问和响应映射分别收敛在 routes 目录中。
 */
export function createApp(realtime: RealtimeHub) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      await minio.bucketExists(config.minio.bucket);
      response.json({ status: "UP" });
    } catch {
      response.status(503).json({ status: "DOWN" });
    }
  });

  app.use("/api", createAuthRouter());
  app.use("/api", createChatRouter(realtime));
  app.use("/api", createFileRouter());
  app.use("/api", createAdminRouter(realtime));
  app.use("/api", (_request, response) => {
    response.status(404).json({ message: "接口不存在" });
  });

  // 生产环境由同一个进程托管 Vite 构建产物，并把非 API GET 请求交回前端路由。
  const staticDir = path.resolve(process.cwd(), "../web/dist");
  app.use(express.static(staticDir));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) {
      next();
      return;
    }
    response.sendFile(path.join(staticDir, "index.html"));
  });

  app.use(apiErrorHandler);
  return app;
}
