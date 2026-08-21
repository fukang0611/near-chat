type MutationGate = { promise: Promise<void>; release(): void };

const aliases = new Map<string, string>();
const gates = new Map<string, MutationGate>();
const pending = new Map<string, Set<Promise<unknown>>>();
const retired = new Set<string>();

function canonicalAccountKey(accountKey: string): string {
  const seen = new Set<string>();
  let current = accountKey;
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

export function resolveAccountMutationKey(accountKey: string): string {
  return canonicalAccountKey(accountKey);
}

function createGate(): MutationGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForPending(accountKey: string): Promise<void> {
  for (;;) {
    const tasks = [...(pending.get(accountKey) ?? [])];
    if (!tasks.length) return;
    await Promise.allSettled(tasks);
  }
}

/** 所有本地实体写入都在账号生命周期屏障内登记。 */
export async function runAccountMutation<T>(
  requestedAccountKey: string,
  operation: (effectiveAccountKey: string) => Promise<T>,
): Promise<T> {
  for (;;) {
    const requestedGate = gates.get(requestedAccountKey);
    if (requestedGate) {
      await requestedGate.promise;
      continue;
    }
    const effectiveAccountKey = canonicalAccountKey(requestedAccountKey);
    const effectiveGate = gates.get(effectiveAccountKey);
    if (effectiveGate) {
      await effectiveGate.promise;
      continue;
    }
    if (retired.has(requestedAccountKey) || retired.has(effectiveAccountKey)) {
      throw new Error("账号已切换，本次本地修改未执行");
    }
    const task = operation(effectiveAccountKey);
    const tasks = pending.get(effectiveAccountKey) ?? new Set<Promise<unknown>>();
    tasks.add(task);
    pending.set(effectiveAccountKey, tasks);
    try {
      return await task;
    } finally {
      tasks.delete(task);
      if (!tasks.size) pending.delete(effectiveAccountKey);
    }
  }
}

/** 冻结旧命名空间，等待既有写入，迁移后让冻结期间的新写入自动路由到新账号。 */
export async function migrateAccountMutations(
  fromAccountKey: string,
  toAccountKey: string,
  migrate: (effectiveFromAccountKey: string, effectiveToAccountKey: string) => Promise<void>,
): Promise<void> {
  if (fromAccountKey === toAccountKey) return;
  const from = canonicalAccountKey(fromAccountKey);
  // journal 重放时 LOCAL 可能已经通过 alias 指向目标账号；此时再次执行 team -> team
  // 会让底层“迁移后删除源命名空间”误删目标数据，必须在 canonicalize 后再次判等。
  if (from === toAccountKey) {
    aliases.set(fromAccountKey, toAccountKey);
    retired.delete(toAccountKey);
    return;
  }
  const gate = createGate();
  gates.set(from, gate);
  try {
    await waitForPending(from);
    await migrate(from, toAccountKey);
    aliases.set(from, toAccountKey);
    aliases.set(fromAccountKey, toAccountKey);
    retired.delete(toAccountKey);
  } finally {
    gates.delete(from);
    gate.release();
  }
}

/** 登出时冻结并清理旧账号；释放后旧页面的迟到 handler 会被拒绝。 */
export async function retireAccountMutations(
  accountKey: string,
  finalize: () => Promise<void>,
): Promise<void> {
  const current = canonicalAccountKey(accountKey);
  const gate = createGate();
  gates.set(current, gate);
  try {
    await waitForPending(current);
    await finalize();
    retired.add(current);
    retired.add(accountKey);
  } finally {
    gates.delete(current);
    gate.release();
  }
}

export function activateAccountMutations(accountKey: string): void {
  retired.delete(accountKey);
  retired.delete(canonicalAccountKey(accountKey));
}

/** 退出团队账号后恢复独立的 LOCAL 命名空间，不再沿用登录迁移建立的别名。 */
export function resetAccountMutationRoute(accountKey: string): void {
  aliases.delete(accountKey);
  retired.delete(accountKey);
}

/** 旧组件闭包可据此判断其账号是否已迁移为当前账号。 */
export function accountMutationTargets(
  requestedAccountKey: string,
  activeAccountKey: string,
): boolean {
  if (!requestedAccountKey || !activeAccountKey) return false;
  const requested = canonicalAccountKey(requestedAccountKey);
  const active = canonicalAccountKey(activeAccountKey);
  return requested === active && !retired.has(requestedAccountKey) && !retired.has(requested);
}
