# Rancher 部署

在 Rancher 导入 `near-chat.yaml` 前只需修改以下内容：

1. 将 `Deployment` 的 `image` 改为离线仓库中的 AMD64 镜像地址；如果镜像已导入所有工作节点，可保留 `near-chat-app:1.1.0`。
2. 将 `ConfigMap` 中的 MinIO 地址、端口、SSL 和 Bucket 改为现有服务信息。
3. 将 `Secret` 中的 PostgreSQL URL、JWT、MinIO 密钥和初始管理员密码全部替换。
4. 将 Ingress 的 `ingressClassName` 和域名改为集群实际值；不使用 Ingress 时可删除最后一段并通过 Rancher 暴露 Service。

应用同时托管前端静态文件和后端接口，只需要部署一个容器。当前实时在线状态位于应用内存，因此必须保持 `replicas: 1`。
