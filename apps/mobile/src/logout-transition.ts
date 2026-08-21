import type { SyncProfile } from "./models";

export interface LogoutTransitionEffects {
  invalidateProfileTransitions(): Promise<void>;
  cancelBackgroundSync(): Promise<void>;
  retireAccount(accountKey: string, finalize: () => Promise<void>): Promise<void>;
  cancelReminders(accountKey: string): Promise<void>;
  clearProfile(): Promise<void>;
  restoreProfile(profile: SyncProfile): Promise<void>;
  activateAccount(accountKey: string): void;
  scheduleBackgroundSync(): Promise<void>;
  reconcileReminders(accountKey: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LogoutTransitionError extends Error {
  readonly originalError: unknown;
  readonly recoveryErrors: unknown[];

  constructor(originalError: unknown, recoveryErrors: unknown[]) {
    super(
      recoveryErrors.length
        ? `退出失败，且账号状态未能完整恢复：${recoveryErrors.map(errorMessage).join("；")}`
        : `退出失败，已保留当前账号：${errorMessage(originalError)}`,
    );
    this.name = "LogoutTransitionError";
    this.originalError = originalError;
    this.recoveryErrors = recoveryErrors;
  }
}

/**
 * 先冻结账号副作用并完成持久清理；调用方只有在本函数成功后才能把 UI 切到 LOCAL。
 * 任一步失败都会重新写回完整凭据、恢复账号写入与后台同步，避免半退出状态。
 */
export async function prepareLogoutTransition(
  profile: SyncProfile,
  accountKey: string,
  effects: LogoutTransitionEffects,
): Promise<void> {
  try {
    await effects.invalidateProfileTransitions();
    await effects.cancelBackgroundSync();
    await effects.retireAccount(accountKey, () => effects.cancelReminders(accountKey));
    await effects.clearProfile();
  } catch (error) {
    effects.activateAccount(accountKey);
    const recoveryErrors: unknown[] = [];
    let profileRestored = false;
    try {
      await effects.restoreProfile(profile);
      profileRestored = true;
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    if (profileRestored) {
      try {
        await effects.scheduleBackgroundSync();
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    try {
      await effects.reconcileReminders(accountKey);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    throw new LogoutTransitionError(error, recoveryErrors);
  }
}
