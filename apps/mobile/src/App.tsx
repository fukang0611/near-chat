import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantSection } from "./components/AssistantSection";
import { ConflictPanel } from "./components/ConflictPanel";
import { MemorySection } from "./components/MemorySection";
import { RecordsSection } from "./components/RecordsSection";
import { SettingsSection } from "./components/SettingsSection";
import { TasksSection } from "./components/TasksSection";
import {
  accountViewKey,
  canInitializeDefaultWorkspace,
  createInitializationGate,
} from "./app-lifecycle";
import {
  accountMutationTargets,
  activateAccountMutations,
  resetAccountMutationRoute,
  retireAccountMutations,
} from "./account-mutations";
import type { MobileSyncState, StoredSyncConflict, SyncProfile } from "./models";
import {
  consumeBackgroundSyncRequest,
  cancelBackgroundSync,
  ensureInstallationId,
  listConflicts,
  listEntities,
  scheduleBackgroundSync,
} from "./native";
import {
  cancelCurrentReminderAccount,
  reconcileCurrentReminderAccount,
} from "./reminder-reconcile";
import { prepareLogoutTransition } from "./logout-transition";
import { localNamespace } from "./sync-logic";
import {
  clearStoredProfile,
  invalidateProfileTransitions,
  loadStoredProfile,
  resetDeviceRegistrationCache,
  restoreStoredProfile,
  syncPersonalData,
} from "./sync";
import "./styles.css";

type Section = "ASSISTANT" | "MEMORIES" | "TASKS" | "RECORDS" | "SETTINGS";

const INITIAL_SYNC_STATE: MobileSyncState = {
  phase: "LOCAL",
  message: "个人离线模式",
  pushed: 0,
  pulled: 0,
  conflicts: 0,
};

export default function App() {
  const [section, setSection] = useState<Section>("ASSISTANT");
  const [accountKey, setAccountKey] = useState("");
  const [profile, setProfile] = useState<SyncProfile | null>(null);
  const [syncState, setSyncState] = useState<MobileSyncState>(INITIAL_SYNC_STATE);
  const [conflicts, setConflicts] = useState<StoredSyncConflict[]>([]);
  const [syncReadyAccountKey, setSyncReadyAccountKey] = useState("");
  const [accountTransitionBusy, setAccountTransitionBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const initialSessionGeneration = useRef(crypto.randomUUID()).current;
  const [accountSessionGeneration, setAccountSessionGeneration] =
    useState(initialSessionGeneration);
  const syncing = useRef(false);
  const syncRerunRequested = useRef(false);
  const profileTransitioning = useRef(false);
  const syncEpoch = useRef(0);
  const pendingSyncTimer = useRef<number | null>(null);
  const activeAccountKeyRef = useRef("");
  const activeProfileRef = useRef<SyncProfile | null>(null);
  const activeSessionGenerationRef = useRef(initialSessionGeneration);
  const initializationGate = useRef(createInitializationGate()).current;
  const runSyncRef = useRef<(target?: SyncProfile | null) => Promise<boolean>>(async () => false);

  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);

  const reloadConflicts = useCallback(
    async (key: string, shouldApply: () => boolean = () => true) => {
      const next = await listConflicts(key);
      if (!shouldApply()) return;
      setConflicts(next);
      if (next.length) {
        setSyncState((current) => ({
          ...current,
          phase: "CONFLICT",
          conflicts: next.length,
          message: `有 ${next.length} 项同步冲突待处理`,
        }));
      }
    },
    [],
  );

  const runSync = useCallback(
    async (target = activeProfileRef.current) => {
      if (!target || profileTransitioning.current) return false;
      if (syncing.current) {
        syncRerunRequested.current = true;
        return false;
      }
      const epoch = syncEpoch.current;
      const stillCurrent = () =>
        epoch === syncEpoch.current &&
        activeAccountKeyRef.current === target.accountKey &&
        activeProfileRef.current?.accountKey === target.accountKey &&
        activeProfileRef.current.token === target.token;
      syncRerunRequested.current = false;
      syncing.current = true;
      try {
        const result = await syncPersonalData(
          target,
          (state) => {
            if (stillCurrent()) setSyncState(state);
          },
          stillCurrent,
        );
        if (!stillCurrent()) return false;
        setSyncState(result);
        await reloadConflicts(target.accountKey, stillCurrent);
        if (!stillCurrent()) return false;
        setSyncReadyAccountKey(target.accountKey);
        refresh();
        return true;
      } catch (error) {
        if (!stillCurrent()) return false;
        const conflictCount = (await listConflicts(target.accountKey)).length;
        if (!stillCurrent()) return false;
        setSyncState({
          phase: "ERROR",
          message: error instanceof Error ? error.message : "同步失败，请稍后重试",
          pushed: 0,
          pulled: 0,
          conflicts: conflictCount,
        });
        return false;
      } finally {
        if (stillCurrent()) {
          syncing.current = false;
          if (syncRerunRequested.current) {
            syncRerunRequested.current = false;
            const latestProfile = activeProfileRef.current;
            if (latestProfile) queueMicrotask(() => void runSyncRef.current(latestProfile));
          }
        }
      }
    },
    [refresh, reloadConflicts],
  );

  useEffect(() => {
    runSyncRef.current = runSync;
  }, [runSync]);

  const localChanged = useCallback(
    (changedAccountKey: string, originGeneration: string) => {
      if (profileTransitioning.current) return;
      if (
        originGeneration !== activeSessionGenerationRef.current ||
        !accountMutationTargets(changedAccountKey, activeAccountKeyRef.current)
      )
        return;
      refresh();
      const currentProfile = activeProfileRef.current;
      if (!currentProfile || !navigator.onLine) return;
      if (pendingSyncTimer.current !== null) window.clearTimeout(pendingSyncTimer.current);
      const epoch = syncEpoch.current;
      pendingSyncTimer.current = window.setTimeout(() => {
        pendingSyncTimer.current = null;
        const latestProfile = activeProfileRef.current;
        if (
          epoch !== syncEpoch.current ||
          !latestProfile ||
          originGeneration !== activeSessionGenerationRef.current ||
          !accountMutationTargets(changedAccountKey, activeAccountKeyRef.current)
        )
          return;
        void runSyncRef.current(latestProfile);
      }, 800);
    },
    [refresh],
  );

  useEffect(() => {
    if (!initializationGate()) return;
    void (async () => {
      const installationId = await ensureInstallationId();
      const stored = await loadStoredProfile();
      const key = stored?.accountKey ?? localNamespace(installationId);
      const generation = activeSessionGenerationRef.current;
      const stillCurrent = () =>
        generation === activeSessionGenerationRef.current && activeAccountKeyRef.current === key;
      if (stored) activateAccountMutations(key);
      else resetAccountMutationRoute(key);
      activeProfileRef.current = stored;
      activeAccountKeyRef.current = key;
      setProfile(stored);
      setAccountKey(key);
      setSyncState(
        stored
          ? { ...INITIAL_SYNC_STATE, phase: "CONNECTED", message: `已连接 ${stored.username}` }
          : INITIAL_SYNC_STATE,
      );
      if (stored) {
        await scheduleBackgroundSync();
        if (!stillCurrent()) return;
      }
      await reconcileCurrentReminderAccount(key, stillCurrent);
      if (!stillCurrent()) return;
      await reloadConflicts(key, stillCurrent);
      if (stored && navigator.onLine && stillCurrent()) void runSyncRef.current(stored);
    })();
  }, [initializationGate, reloadConflicts]);

  useEffect(() => {
    const handleOnline = () => void runSync();
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void consumeBackgroundSyncRequest().then((requested) => {
        if (requested || navigator.onLine) void runSync();
      });
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      if (pendingSyncTimer.current !== null) window.clearTimeout(pendingSyncTimer.current);
    };
  }, [runSync]);

  const connected = async (nextProfile: SyncProfile) => {
    syncEpoch.current += 1;
    const epoch = syncEpoch.current;
    syncing.current = false;
    syncRerunRequested.current = false;
    if (pendingSyncTimer.current !== null) {
      window.clearTimeout(pendingSyncTimer.current);
      pendingSyncTimer.current = null;
    }
    const previousAccountKey = activeAccountKeyRef.current;
    const previousWasLocal = previousAccountKey === localNamespace(nextProfile.installationId);
    let generation = activeSessionGenerationRef.current;
    if (previousAccountKey && previousAccountKey !== nextProfile.accountKey && !previousWasLocal) {
      generation = crypto.randomUUID();
      activeSessionGenerationRef.current = generation;
      setAccountSessionGeneration(generation);
    }
    activeProfileRef.current = nextProfile;
    activeAccountKeyRef.current = nextProfile.accountKey;
    activateAccountMutations(nextProfile.accountKey);
    const stillCurrent = () =>
      epoch === syncEpoch.current &&
      generation === activeSessionGenerationRef.current &&
      activeAccountKeyRef.current === nextProfile.accountKey &&
      activeProfileRef.current?.token === nextProfile.token;
    setSyncReadyAccountKey("");
    setProfile(nextProfile);
    setAccountKey(nextProfile.accountKey);
    setSyncState({
      ...INITIAL_SYNC_STATE,
      phase: "CONNECTED",
      message: `已连接 ${nextProfile.username}`,
    });
    if (previousAccountKey && previousAccountKey !== nextProfile.accountKey && !previousWasLocal) {
      await retireAccountMutations(previousAccountKey, async () => {
        await cancelCurrentReminderAccount(previousAccountKey);
      });
      if (!stillCurrent()) throw new Error("账号连接已取消");
    }
    await reconcileCurrentReminderAccount(nextProfile.accountKey, stillCurrent);
    if (!stillCurrent()) throw new Error("账号连接已取消");
    await scheduleBackgroundSync();
    if (!stillCurrent()) throw new Error("账号连接已取消");
    await reloadConflicts(nextProfile.accountKey, stillCurrent);
    if (!stillCurrent()) throw new Error("账号连接已取消");
    refresh();
    if (!(await runSync(nextProfile))) {
      throw new Error("登录成功，但首次同步尚未完成；请联网后点击“立即同步”");
    }
  };

  const logout = async () => {
    if (profileTransitioning.current) throw new Error("账号状态正在切换，请稍候");
    const previousProfile = activeProfileRef.current;
    const previousAccountKey = activeAccountKeyRef.current;
    if (!previousProfile || !previousAccountKey) return;
    profileTransitioning.current = true;
    setAccountTransitionBusy(true);
    syncEpoch.current += 1;
    const epoch = syncEpoch.current;
    syncing.current = false;
    syncRerunRequested.current = false;
    const previousGeneration = activeSessionGenerationRef.current;
    const nextGeneration = crypto.randomUUID();
    activeSessionGenerationRef.current = nextGeneration;
    const stillCurrent = () =>
      epoch === syncEpoch.current &&
      nextGeneration === activeSessionGenerationRef.current &&
      activeAccountKeyRef.current === previousAccountKey &&
      activeProfileRef.current?.token === previousProfile.token;
    if (pendingSyncTimer.current !== null) {
      window.clearTimeout(pendingSyncTimer.current);
      pendingSyncTimer.current = null;
    }
    try {
      const installationId = await ensureInstallationId();
      if (!stillCurrent()) return;
      await prepareLogoutTransition(previousProfile, previousAccountKey, {
        invalidateProfileTransitions,
        cancelBackgroundSync,
        retireAccount: retireAccountMutations,
        cancelReminders: cancelCurrentReminderAccount,
        clearProfile: clearStoredProfile,
        restoreProfile: restoreStoredProfile,
        activateAccount: activateAccountMutations,
        scheduleBackgroundSync,
        reconcileReminders: reconcileCurrentReminderAccount,
      });
      if (!stillCurrent()) return;
      resetDeviceRegistrationCache();
      const key = localNamespace(installationId);
      resetAccountMutationRoute(key);
      activeProfileRef.current = null;
      activeAccountKeyRef.current = key;
      setAccountSessionGeneration(nextGeneration);
      setProfile(null);
      setSyncReadyAccountKey("");
      setAccountKey(key);
      setConflicts([]);
      setSyncState(INITIAL_SYNC_STATE);
      try {
        await reconcileCurrentReminderAccount(
          key,
          () =>
            nextGeneration === activeSessionGenerationRef.current &&
            activeAccountKeyRef.current === key,
        );
      } catch (error) {
        setSyncState({
          ...INITIAL_SYNC_STATE,
          phase: "ERROR",
          message: error instanceof Error ? error.message : "本地提醒恢复失败",
        });
      }
      refresh();
    } catch (error) {
      if (stillCurrent()) {
        activeSessionGenerationRef.current = previousGeneration;
        setAccountSessionGeneration(previousGeneration);
        setSyncState((current) => ({
          ...current,
          phase: "ERROR",
          message: error instanceof Error ? error.message : "退出失败，已保留当前账号",
        }));
      }
      throw error;
    } finally {
      profileTransitioning.current = false;
      setAccountTransitionBusy(false);
    }
  };

  if (!accountKey) return <main className="mobile-shell loading">正在打开本地数据库…</main>;

  const statusClass = syncState.phase.toLocaleLowerCase();
  return (
    <main className="mobile-shell">
      <header className="app-header">
        <div>
          <span>近聊</span>
          <strong>{profile ? `团队账号 · ${profile.username}` : "个人模式"}</strong>
        </div>
        <button
          className={`status-pill ${statusClass}`}
          onClick={() => void runSync()}
          disabled={!profile || syncState.phase === "SYNCING" || accountTransitionBusy}
        >
          {syncState.phase === "SYNCING"
            ? "同步中"
            : syncState.phase === "CONFLICT"
              ? "有冲突"
              : profile
                ? "已连接"
                : "完全离线"}
        </button>
        <small>{syncState.message}</small>
      </header>

      {conflicts.length > 0 && (
        <ConflictPanel
          conflicts={conflicts}
          onResolved={async () => {
            const stillCurrent = () =>
              accountSessionGeneration === activeSessionGenerationRef.current &&
              accountMutationTargets(accountKey, activeAccountKeyRef.current);
            await reloadConflicts(accountKey, stillCurrent);
            if (stillCurrent()) refresh();
          }}
          onRetrySync={() => runSync()}
          isActive={() =>
            accountSessionGeneration === activeSessionGenerationRef.current &&
            accountMutationTargets(accountKey, activeAccountKeyRef.current)
          }
        />
      )}

      {section === "ASSISTANT" && (
        <AssistantSection
          key={accountViewKey(accountKey, accountSessionGeneration)}
          accountKey={accountKey}
          canInitializeDefault={canInitializeDefaultWorkspace(
            profile?.accountKey ?? null,
            syncReadyAccountKey,
          )}
          refreshVersion={refreshVersion}
          onChanged={() => localChanged(accountKey, accountSessionGeneration)}
          sessionGeneration={accountSessionGeneration}
          isAccountActive={() =>
            accountSessionGeneration === activeSessionGenerationRef.current &&
            accountMutationTargets(accountKey, activeAccountKeyRef.current)
          }
        />
      )}
      {section === "MEMORIES" && (
        <MemorySection
          key={accountViewKey(accountKey, accountSessionGeneration)}
          accountKey={accountKey}
          refreshVersion={refreshVersion}
          onChanged={() => localChanged(accountKey, accountSessionGeneration)}
        />
      )}
      {section === "TASKS" && (
        <TasksSection
          key={accountViewKey(accountKey, accountSessionGeneration)}
          accountKey={accountKey}
          refreshVersion={refreshVersion}
          onChanged={() => localChanged(accountKey, accountSessionGeneration)}
          isAccountActive={() =>
            accountSessionGeneration === activeSessionGenerationRef.current &&
            accountMutationTargets(accountKey, activeAccountKeyRef.current)
          }
        />
      )}
      {section === "RECORDS" && (
        <RecordsSection
          key={accountViewKey(accountKey, accountSessionGeneration)}
          accountKey={accountKey}
          refreshVersion={refreshVersion}
          onChanged={() => localChanged(accountKey, accountSessionGeneration)}
        />
      )}
      {section === "SETTINGS" && (
        <SettingsSection
          key={accountViewKey(accountKey, accountSessionGeneration)}
          accountKey={accountKey}
          profile={profile}
          syncState={syncState}
          onConnected={connected}
          onLogout={logout}
          onSync={async () => {
            await runSync();
          }}
        />
      )}

      <nav aria-label="移动端主导航">
        {(
          [
            ["ASSISTANT", "助理"],
            ["MEMORIES", "记忆"],
            ["TASKS", "任务"],
            ["RECORDS", "记录"],
            ["SETTINGS", "我的"],
          ] as const
        ).map(([item, label]) => (
          <button
            key={item}
            className={section === item ? "active" : ""}
            onClick={() => setSection(item)}
            disabled={accountTransitionBusy}
          >
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}
