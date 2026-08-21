export class SupersededProfileTransitionError extends Error {
  constructor() {
    super("登录操作已被更新的账号操作替代");
    this.name = "SupersededProfileTransitionError";
  }
}

/**
 * 认证请求可并发等待网络，但涉及 Room 迁移和 Keystore 的提交必须串行且 latest-wins。
 * 已开始的提交允许原子收尾；若期间出现新尝试，旧调用不会再进入 React 状态层。
 */
export class ProfileTransitionCoordinator {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  begin(): { commit<T>(operation: () => Promise<T>): Promise<T> } {
    const generation = ++this.generation;
    return {
      commit: <T>(operation: () => Promise<T>) => this.commit(generation, operation),
    };
  }

  private async commit<T>(generation: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (generation !== this.generation) throw new SupersededProfileTransitionError();
      const result = await operation();
      if (generation !== this.generation) throw new SupersededProfileTransitionError();
      return result;
    } finally {
      release();
    }
  }

  /** 登出先让所有尚未提交的登录失效，再等待正在提交的迁移结束。 */
  async invalidateAndWait(): Promise<void> {
    this.generation += 1;
    await this.tail;
  }
}
