export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Docker 启动时数据库和对象存储可能晚于应用就绪。
 * 统一重试策略可避免不同基础设施模块各自维护一套循环。
 */
export async function retryUntilReady<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 1_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // 循环必然返回或抛错；该分支只用于保持类型完整。
  throw new Error("重试流程意外结束");
}
