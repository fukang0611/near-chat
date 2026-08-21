import type { SyncChange } from "@near-chat/domain";

export interface BootstrapPage {
  phase: "BACKFILL" | "SNAPSHOT";
  changes: SyncChange[];
  watermark: string;
  cursor: string | null;
  hasMore: boolean;
  nextPageToken: string | null;
}

type ApplyResult = "APPLIED" | "DEFERRED" | "BLOCKED";

interface BootstrapPaginationEffects {
  fetchPage(pageToken?: string): Promise<BootstrapPage>;
  applyChange(change: SyncChange): Promise<ApplyResult>;
  commitCursor(cursor: string): Promise<void>;
  shouldRestartToken(error: unknown): boolean;
  shouldContinue(): boolean;
  maxPages?: number;
}

function assertActive(shouldContinue: () => boolean): void {
  if (!shouldContinue()) throw new Error("同步已取消");
}

/**
 * bootstrap 页可安全重复应用，但 cursor 只能在完整末页提交。中途失败或账号切换时，
 * 调用方仍保持 null cursor；下次从第一页重放并由最终 pull 收敛分页期间的写入。
 */
export async function consumeBootstrapPages(effects: BootstrapPaginationEffects): Promise<number> {
  const maxPages = effects.maxPages;
  let pageToken: string | undefined;
  let watermark: string | null = null;
  let pulled = 0;
  let restarted = false;
  let seenTokens = new Set<string>();

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (maxPages !== undefined && pageIndex >= maxPages) {
      throw new Error("bootstrap 分页超过测试安全上限，游标未推进");
    }
    assertActive(effects.shouldContinue);
    let page: BootstrapPage;
    try {
      page = await effects.fetchPage(pageToken);
    } catch (error) {
      if (pageToken && !restarted && effects.shouldRestartToken(error)) {
        // 令牌有 24 小时有效期。已应用页面是幂等的，从头获取新 watermark 即可。
        restarted = true;
        pageToken = undefined;
        watermark = null;
        pulled = 0;
        seenTokens = new Set<string>();
        continue;
      }
      throw error;
    }
    assertActive(effects.shouldContinue);
    if (!page.watermark) throw new Error("bootstrap 响应缺少冻结 watermark");
    if (watermark === null) watermark = page.watermark;
    else if (page.watermark !== watermark) throw new Error("bootstrap 分页 watermark 不一致");

    for (const change of page.changes) {
      assertActive(effects.shouldContinue);
      if ((await effects.applyChange(change)) === "BLOCKED") {
        throw new Error("bootstrap 遇到尚未持久化的冲突版本，游标已保留供重试");
      }
      pulled += 1;
    }

    if (!page.hasMore) {
      if (page.nextPageToken !== null || page.cursor !== watermark) {
        throw new Error("bootstrap 末页游标契约无效");
      }
      await effects.commitCursor(page.cursor);
      return pulled;
    }
    if (page.cursor !== null || !page.nextPageToken) {
      throw new Error("bootstrap 中间页游标契约无效");
    }
    if (seenTokens.has(page.nextPageToken)) throw new Error("bootstrap 返回了重复页令牌");
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}
