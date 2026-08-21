import type { ConnectorEventStatus, ConnectorJobStatus } from "../types";

export const connectorEventStatuses: ConnectorEventStatus[] = [
  "FAILED",
  "RECEIVED",
  "PROCESSING",
  "PROCESSED",
  "CANCELLED",
];

export const connectorJobStatuses: ConnectorJobStatus[] = [
  "FAILED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "CANCELLED",
];

export const connectorOperationStatusLabels: Record<
  ConnectorEventStatus | ConnectorJobStatus,
  string
> = {
  RECEIVED: "待处理",
  PROCESSING: "处理中",
  PROCESSED: "已处理",
  QUEUED: "待投递",
  RUNNING: "投递中",
  SUCCEEDED: "已投递",
  FAILED: "失败",
  CANCELLED: "已取消",
};

/** 运维界面不展示地址、查询参数或疑似凭据，即使下游把它们写进错误消息。 */
export function safeConnectorOperationError(error: string | null): string {
  if (!error?.trim()) return "未记录可公开的失败原因，请结合服务端日志排查";
  const normalized = error
    .replace(/\bBearer\s+[^\s,"';}]+/gi, "Bearer [已隐藏]")
    .replace(/https?:\/\/[^\s)]+/gi, "[外部地址已隐藏]")
    .replace(
      /(["']?(?:api[_-]?key|key|token|secret|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi,
      "$1[已隐藏]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 180) || "外部处理失败，详细信息仅保留在服务端日志";
}

export function formatOperationTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
