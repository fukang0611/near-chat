import { config } from "./config.js";
import { query, transaction } from "./database.js";
import { minio } from "./minio.js";
import { retryOperation } from "./retry.js";

interface CleanupAttachmentRow {
  id: string;
  bucket_name: string;
  object_key: string;
}

async function claimOrphanAttachments(): Promise<CleanupAttachmentRow[]> {
  return transaction(async (client) => {
    // FOR UPDATE SKIP LOCKED 与发送事务中的附件行锁配合，保证同一附件只会进入一条流程。
    const result = await client.query<CleanupAttachmentRow>(
      `SELECT id, bucket_name, object_key
         FROM attachments
        WHERE message_id IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM favorite_attachments favorite_link
             WHERE favorite_link.attachment_id = attachments.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM message_attachment_links message_link
             WHERE message_link.attachment_id = attachments.id
          )
          AND (
            state = 'CLEANUP_FAILED'
            OR (state = 'CLEANING' AND state_updated_at < NOW() - INTERVAL '10 minutes')
            OR created_at < NOW() - ($1::double precision * INTERVAL '1 hour')
          )
        ORDER BY created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED`,
      [config.fileOrphanTtlHours],
    );
    if (result.rows.length > 0) {
      await client.query(
        `UPDATE attachments
            SET state = 'CLEANING', state_updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)],
      );
    }
    return result.rows;
  });
}

export async function removeAttachmentObject(attachment: CleanupAttachmentRow): Promise<void> {
  await retryOperation(() => minio.removeObject(attachment.bucket_name, attachment.object_key), {
    attempts: config.storageRetryAttempts,
    delayMs: 500,
  });
  await query(
    `DELETE FROM attachments attachment
      WHERE attachment.id = $1
        AND attachment.message_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM favorite_attachments favorite_link
           WHERE favorite_link.attachment_id = attachment.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM message_attachment_links message_link
           WHERE message_link.attachment_id = attachment.id
        )`,
    [attachment.id],
  );
}

/** 回收超过保留期仍未发送的附件；失败记录留待下一轮继续重试。 */
export async function cleanupOrphanAttachments(): Promise<void> {
  const attachments = await claimOrphanAttachments();
  for (const attachment of attachments) {
    try {
      await removeAttachmentObject(attachment);
    } catch (error) {
      await query(
        `UPDATE attachments
            SET state = 'CLEANUP_FAILED', state_updated_at = NOW()
          WHERE id = $1 AND message_id IS NULL`,
        [attachment.id],
      ).catch(() => undefined);
      console.error(`Failed to clean orphan attachment ${attachment.id}:`, error);
    }
  }
}

/** 启动进程内轻量清理器；返回函数用于容器优雅停止。 */
export function startAttachmentCleanup(): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupOrphanAttachments();
    } catch (error) {
      console.error("Attachment cleanup cycle failed:", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, config.fileCleanupIntervalMinutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
