import { createServer } from "node:http";
import {
  ensureAiSettings,
  loadAiSettings,
  markVectorEmbeddingRevision,
} from "./ai/ai-settings-service.js";
import { initializeAiRuntime, shutdownAiRuntime } from "./ai/ai-runtime.js";
import { startAttachmentCleanup } from "./attachment-cleanup.js";
import { startAssistantBrowserSessionCleanup } from "./assistant/assistant-browser-service.js";
import { startAssistantReminderWorker } from "./assistant/assistant-reminder-worker.js";
import { startAssistantTaskWorker } from "./assistant/assistant-task-worker.js";
import { startAssistantInvocationWorker } from "./assistant/assistant-invocation-service.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { initializeDatabase, pool } from "./database.js";
import { initializeMinio } from "./minio.js";
import { startKnowledgeIndexWorker } from "./knowledge/knowledge-worker.js";
import { queueAllKnowledgeDocumentsForReindex } from "./knowledge/knowledge-service.js";
import { startMemoryCaptureWorker } from "./memory-capture-service.js";
import {
  startConfiguredDingTalkStreams,
  startConnectorWorker,
} from "./connectors/connector-worker.js";
import { queueAllMemoryVectorsForReindex } from "./memory-service.js";
import { broadcastReceiptChanges, markPendingMessagesDelivered } from "./receipt-service.js";
import { RealtimeHub } from "./realtime.js";

async function main() {
  // 基础设施就绪后再开放端口，避免健康检查通过但核心依赖仍不可用。
  await initializeDatabase();
  await initializeMinio();
  // 环境变量只创建首份设置；之后启动时始终加载管理员最后保存的版本。
  await ensureAiSettings();
  const aiSettings = await loadAiSettings();
  // AI 初始化始终自行降级，绝不会阻断已有聊天、文件和实时连接能力。
  const aiRuntime = await initializeAiRuntime(aiSettings);
  if (aiRuntime.indexRecreated) {
    await queueAllKnowledgeDocumentsForReindex();
    await queueAllMemoryVectorsForReindex();
    await markVectorEmbeddingRevision(aiSettings.embeddingRevision);
  }
  const stopAttachmentCleanup = startAttachmentCleanup();
  const stopKnowledgeIndexWorker = startKnowledgeIndexWorker();
  const stopMemoryCaptureWorker = startMemoryCaptureWorker();
  const stopAssistantBrowserSessionCleanup = startAssistantBrowserSessionCleanup();

  const realtime = new RealtimeHub();
  const stopAssistantTaskWorker = startAssistantTaskWorker(realtime);
  const stopAssistantReminderWorker = startAssistantReminderWorker(realtime);
  const stopAssistantInvocationWorker = startAssistantInvocationWorker();
  const stopConnectorWorker = startConnectorWorker();
  // Stream 配置错误只禁用对应外部能力，绝不能阻断 NearChat 核心服务启动。
  const stopDingTalkStreams = await startConfiguredDingTalkStreams();
  realtime.onUserOnline(async (userId) => {
    const changes = await markPendingMessagesDelivered(userId);
    await broadcastReceiptChanges(realtime, changes);
  });
  const app = createApp(realtime);
  const server = createServer(app);
  realtime.attach(server);

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`NearChat is listening on http://0.0.0.0:${config.port}`);
  });

  // 收到容器停止信号时先停止接收连接，再释放数据库连接池。
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopAttachmentCleanup();
    stopKnowledgeIndexWorker();
    stopMemoryCaptureWorker();
    stopAssistantTaskWorker();
    stopAssistantReminderWorker();
    stopAssistantInvocationWorker();
    stopConnectorWorker();
    stopDingTalkStreams();
    stopAssistantBrowserSessionCleanup();
    realtime.close();
    server.close(async () => {
      await shutdownAiRuntime().catch((error) =>
        console.error("Failed to close AI runtime cleanly:", error),
      );
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("NearChat failed to start", error);
  process.exit(1);
});
