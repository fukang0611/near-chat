import assert from "node:assert/strict";
import test from "node:test";
import {
  LogoutTransitionError,
  prepareLogoutTransition,
  type LogoutTransitionEffects,
} from "../src/logout-transition.ts";
import type { SyncProfile } from "../src/models.ts";

const profile: SyncProfile = {
  accountKey: "team-a",
  installationId: "installation-a",
  serverUrl: "https://near.example",
  token: "token-a",
  userId: "user-a",
  username: "alice",
};

function effects(
  calls: string[],
  overrides: Partial<LogoutTransitionEffects> = {},
): LogoutTransitionEffects {
  return {
    invalidateProfileTransitions: async () => {
      calls.push("invalidate");
    },
    cancelBackgroundSync: async () => {
      calls.push("cancel-background");
    },
    retireAccount: async (accountKey, finalize) => {
      calls.push(`retire:${accountKey}`);
      await finalize();
    },
    cancelReminders: async (accountKey) => {
      calls.push(`cancel-reminders:${accountKey}`);
    },
    clearProfile: async () => {
      calls.push("clear-profile");
    },
    restoreProfile: async (value) => {
      calls.push(`restore-profile:${value.accountKey}`);
    },
    activateAccount: (accountKey) => {
      calls.push(`activate:${accountKey}`);
    },
    scheduleBackgroundSync: async () => {
      calls.push("schedule-background");
    },
    reconcileReminders: async (accountKey) => {
      calls.push(`reconcile:${accountKey}`);
    },
    ...overrides,
  };
}

test("持久凭据清理失败时恢复账号且不允许调用方提交 LOCAL 状态", async () => {
  const calls: string[] = [];
  let localCommitted = false;
  const operation = prepareLogoutTransition(
    profile,
    profile.accountKey,
    effects(calls, {
      clearProfile: async () => {
        calls.push("clear-profile");
        throw new Error("keystore unavailable");
      },
    }),
  ).then(() => {
    localCommitted = true;
  });

  await assert.rejects(operation, /退出失败，已保留当前账号/);
  assert.equal(localCommitted, false);
  assert.deepEqual(calls, [
    "invalidate",
    "cancel-background",
    "retire:team-a",
    "cancel-reminders:team-a",
    "clear-profile",
    "activate:team-a",
    "restore-profile:team-a",
    "schedule-background",
    "reconcile:team-a",
  ]);
});

test("凭据恢复也失败时显式报告不完整状态且不重启后台同步", async () => {
  const calls: string[] = [];
  const operation = prepareLogoutTransition(
    profile,
    profile.accountKey,
    effects(calls, {
      clearProfile: async () => {
        throw new Error("remove failed");
      },
      restoreProfile: async () => {
        calls.push("restore-profile:failed");
        throw new Error("restore failed");
      },
    }),
  );

  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof LogoutTransitionError);
    assert.match(error.message, /账号状态未能完整恢复/);
    return true;
  });
  assert.equal(calls.includes("schedule-background"), false);
  assert.equal(calls.includes("reconcile:team-a"), true);
});
