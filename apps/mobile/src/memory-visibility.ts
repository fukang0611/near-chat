import type { LocalMemory } from "./models";

/** 移动端列表与 Agent 工具共用同一条私人、活跃、未过期边界。 */
export function isVisiblePrivateMemory(value: unknown, nowMs = Date.now()): value is LocalMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Partial<LocalMemory>;
  if (memory.scope !== "PRIVATE" || memory.status !== "ACTIVE") return false;
  if (memory.expiresAt === null || memory.expiresAt === undefined) return true;
  const expiresAt = Date.parse(memory.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}
