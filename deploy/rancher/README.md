# Rancher 部署

在 Rancher 导入 `near-chat.yaml` 前只需修改以下内容：

1. 将 `Deployment` 的 `image` 改为离线仓库中的 AMD64 镜像地址；如果镜像已导入所有工作节点，可保留 `near-chat-app:1.3.0`。
2. 将 `ConfigMap` 中的 MinIO 地址、端口、SSL 和 Bucket 改为现有服务信息。
3. 将 `Secret` 中的 PostgreSQL URL、JWT、MinIO 密钥和初始管理员密码全部替换。
4. 将 Ingress 的 `ingressClassName` 和域名改为集群实际值；不使用 Ingress 时可删除最后一段并通过 Rancher 暴露 Service。

应用同时托管前端静态文件和后端接口，只需要部署一个容器。当前实时在线状态位于应用内存，因此必须保持 `replicas: 1`。

原生 AI 默认关闭，不影响现有聊天部署。推荐的启用方式：

1. 确认 PostgreSQL 已安装并允许创建 `vector` 扩展。
2. 在 Secret 中设置长期不变的 `AI_SETTINGS_ENCRYPTION_KEY`。
3. 使用管理员账号打开“管理中心 → AI 设置”，添加一个或多个 OpenAI 兼容对话模型并指定默认模型。
4. 配置全局 Embedding 服务、模型与维度，然后开启全局 AI 开关并保存。

`AI_ENABLED`、`AI_BASE_URL`、`AI_API_KEY`、`AI_CHAT_MODEL` 和 `AI_EMBEDDING_*` 只用于数据库首次初始化；管理员保存后配置持久化在 PostgreSQL 中并即时热应用，不需要重启 Pod。模型 API Key 只保存加密值且接口不会回显。

模型或 vector 初始化失败时只有知识库索引与问答降级，`/api/health/ready` 仍只检查核心 PostgreSQL 与 MinIO。

受控浏览器同样默认关闭，只有用户为某个助理显式授权并逐步确认后才会启动隔离的 Chromium 会话。应用镜像已包含系统 Chromium；默认全局最多 4 个、单用户最多 2 个并发会话，空闲 15 分钟自动销毁。可通过 `AI_BROWSER_MAX_SESSIONS`、`AI_BROWSER_MAX_SESSIONS_PER_USER` 和 `AI_BROWSER_SESSION_TTL_MINUTES` 调整。开启该能力时建议保留清单中的 1 GiB 内存上限。

文件治理默认配置为单用户 1 GiB 配额、未发送附件保留 24 小时、每 30 分钟清理一次。可在 `ConfigMap` 中调整 `FILE_USER_QUOTA_BYTES`、`FILE_ORPHAN_TTL_HOURS` 和 `FILE_CLEANUP_INTERVAL_MINUTES`。

发送者默认可在 120 秒内撤回消息，撤回会立即阻断附件访问。可通过 `MESSAGE_RECALL_WINDOW_SECONDS` 调整时限。
