# Electron 桌面客户端

## 实现边界

桌面客户端是现有 Web 客户端的安全桌面壳，不在用户电脑上启动后端服务。它连接 Rancher 中部署的近聊地址，继续使用服务端提供的 React 页面、HTTP API、WebSocket 和 MinIO 文件访问链路。

这样可以保证：

- 浏览器与桌面端共用一套聊天业务代码。
- 服务端发布新版页面后，桌面端再次打开即可使用，无需同步发布客户端。
- 用户电脑无需安装 Node.js、Rust、PostgreSQL 或 MinIO。

## 第一阶段能力

- 首次启动配置并验证服务器地址。
- 服务器地址保存在 Electron `userData/desktop-config.json`。
- 单实例窗口、关闭后保留托盘、托盘重新打开和退出。
- 通过系统原生通知显示新消息，点击通知打开对应会话。
- 首次登录自动展示通知授权说明，用户确认后触发本机系统授权与测试通知。
- 从托盘、应用菜单或界面系统信息面板重新配置服务器。
- 仅允许当前服务器源站在客户端窗口内导航；外部 HTTP 链接交给系统浏览器。
- 渲染进程关闭 Node.js，启用上下文隔离和沙箱；预加载层只暴露必要接口。

## 开发与打包

安装依赖后运行：

```bash
npm run desktop:start
```

本地调试时可临时指定服务器，不写入常规用户配置：

```bash
NEAR_CHAT_DESKTOP_SERVER_URL=http://127.0.0.1:3000 npm run desktop:start
```

当前平台目录包：

```bash
npm run desktop:package
```

Windows x64 安装包必须在 Windows x64 构建环境运行：

```powershell
npm ci
npm run desktop:make:win
```

安装包输出到 `apps/desktop/out/make/squirrel.windows/x64/`。第一阶段不配置代码签名，Windows 可能显示来源提醒；局域网内部可由管理员统一分发并放行。

> macOS 的 Electron 原生通知基于系统 UNNotification API，应用必须完成代码签名才能正常显示。Windows Squirrel 安装包会自动配置通知所需的开始菜单快捷方式；系统全局关闭通知时，仍需由用户在操作系统设置中重新允许。

## 离线交付

最终用户只需要安装打好的客户端，不需要 npm 依赖。离线构建机需要提前准备当前仓库、匹配 `package-lock.json` 的 npm 缓存，以及 Electron/Forge 所需依赖；最稳妥的方式是在可联网的同版本 Windows 构建机完成安装包后再带入离线网络。
