# 近聊 NearChat

面向局域网的轻量聊天工具，支持账号与会话管理、单聊与群聊、在线状态、未读与消息回执、消息搜索、文本、图片和附件。PostgreSQL 保存业务数据，MinIO 提供私有文件存储。

完整边界与设计见 [第一阶段整体方案](docs/phase-1-plan.md)。

## 快速启动

```bash
docker compose up --build -d
```

启动后访问：

- 聊天界面：<http://localhost:3000>
- MinIO 控制台：<http://localhost:9001>

首次启动会创建演示账号：

| 用户名  | 密码       | 角色     |
| ------- | ---------- | -------- |
| `admin` | `admin123` | 管理员   |
| `alice` | `alice123` | 普通用户 |
| `bob`   | `bob123`   | 普通用户 |

这些密码仅用于本地快速体验。共享给局域网其他用户前，请通过环境变量更换初始化密码和 `JWT_SECRET`。
设置 `SEED_DEMO_USERS=false` 可在全新数据库中只创建管理员，不创建 Alice 和 Bob。

## Rancher 部署

Rancher/Kubernetes 单文件资源清单位于 `deploy/rancher/near-chat.yaml`。导入前修改镜像地址、PostgreSQL URL、MinIO 服务信息、密钥和 Ingress 域名，具体说明见 `deploy/rancher/README.md`。

当前 WebSocket 在线状态保存在应用进程内，Rancher 部署必须保持单副本。

查看状态和日志：

```bash
docker compose ps
docker compose logs -f app
```

停止服务：

```bash
docker compose down
```

如需同时删除 PostgreSQL 与 MinIO 数据卷，必须明确执行 `docker compose down -v`；该操作不可恢复。

## 本地开发

先启动中间件：

```bash
docker compose up -d postgres minio
```

将 `.env.example` 复制为 `.env` 后运行：

```bash
npm install
npm run dev
```

前端开发服务器为 <http://localhost:5173>，后端为 <http://localhost:3000>。

常用质量检查：

```bash
npm run check
npm run smoke # 需要本地服务已启动
```

## 代码结构

```text
apps/server/src/
  app.ts                 HTTP 应用装配与静态资源托管
  routes/                登录、聊天、文件和用户管理领域路由
  message-service.ts     消息查询与 DTO 映射
  receipt-service.ts     送达/已读状态推进与实时广播
  realtime.ts            WebSocket 在线状态与事件分发
  database.ts / minio.ts 基础设施初始化

apps/web/src/
  components/            页面与可复用界面模块
  utils/                 纯格式化和错误文案工具
  api.ts                  HTTP/WebSocket 客户端入口
  styles.css              基础布局和兼容层
  product-polish.css      产品视觉与交互覆盖层
```

注释主要说明不直观的约束和设计原因，例如消息幂等、文件访问权限、实时连接生命周期与焦点管理；能够由代码直接表达的步骤不重复注释。

## 当前限制

- 单文件默认最大 50 MB，上传由应用服务代理。
- 每位用户默认拥有 1 GiB 文件配额，超过 24 小时未发送的附件会自动回收；均可通过环境变量调整。
- 在线状态与实时广播保存在单个应用实例内，暂不支持多副本。
- 不进行 IP/端口扫描；在线用户由聊天服务统一发现。
- 暂无消息撤回、端到端加密和音视频。
