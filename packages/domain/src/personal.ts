export const PERSONAL_ENTITY_TYPES = [
  "PERSONAL_TASK",
  "PERSONAL_REMINDER",
  "PERSONAL_RECORD",
] as const;
export type PersonalEntityType = (typeof PERSONAL_ENTITY_TYPES)[number];

export function isPersonalEntityType(value: string): value is PersonalEntityType {
  return (PERSONAL_ENTITY_TYPES as readonly string[]).includes(value);
}

export interface PersonalTask {
  id: string;
  title: string;
  note: string;
  dueAt: string | null;
  completedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalReminder {
  id: string;
  title: string;
  note: string;
  scheduledAt: string;
  completedAt: string | null;
  notifiedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalRecord {
  id: string;
  title: string;
  content: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 完成状态只能单调向前，旧离线设备不得把事项重新打开。 */
export function resolveCompletedAt(
  current: string | null,
  incoming: string | null | undefined,
): string | null {
  return current ?? incoming ?? null;
}
