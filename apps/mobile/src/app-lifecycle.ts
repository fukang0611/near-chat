/** React StrictMode 会重复执行 effect；该门闩保证设备初始化与首次同步只启动一次。 */
export function createInitializationGate(): () => boolean {
  let started = false;
  return () => {
    if (started) return false;
    started = true;
    return true;
  };
}

/** 团队命名空间必须先完成 bootstrap，避免把“空库”误判成首次使用。 */
export function canInitializeDefaultWorkspace(
  connectedAccountKey: string | null,
  synchronizedAccountKey: string,
): boolean {
  return connectedAccountKey === null || connectedAccountKey === synchronizedAccountKey;
}

/** 账号或不可复用的会话代次变化时，强制卸载旧账号页面及其在途异步 state。 */
export function accountViewKey(accountKey: string, sessionGeneration: string): string {
  return `${accountKey}\u0000${sessionGeneration}`;
}
