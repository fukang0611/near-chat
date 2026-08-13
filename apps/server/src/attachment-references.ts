import type { PoolClient } from "pg";

/**
 * 只有完全脱离消息且不再被收藏引用的附件才能进入对象回收队列。
 * 后续新增附件引用类型时，只需在本模块补充检查，避免各删除入口语义漂移。
 */
export async function stageDetachedAttachmentsForCleanup(
  client: PoolClient,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  await client.query(
    `UPDATE attachments attachment
        SET state = 'CLEANUP_FAILED',
            state_updated_at = NOW()
      WHERE attachment.id = ANY($1::uuid[])
        AND attachment.message_id IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM favorite_attachments favorite_link
           WHERE favorite_link.attachment_id = attachment.id
        )`,
    [attachmentIds],
  );
}

/** 撤回消息时解除附件归属；仍被收藏的对象继续保持 READY。 */
export async function detachMessageAttachments(
  client: PoolClient,
  messageId: string,
): Promise<void> {
  await client.query(
    `UPDATE attachments attachment
        SET message_id = NULL,
            state = CASE
              WHEN EXISTS (
                SELECT 1
                  FROM favorite_attachments favorite_link
                 WHERE favorite_link.attachment_id = attachment.id
              ) THEN 'READY'
              ELSE 'CLEANUP_FAILED'
            END,
            state_updated_at = NOW()
      WHERE attachment.message_id = $1`,
    [messageId],
  );
}

/** 解散会话时采用与单条撤回相同的引用保留规则。 */
export async function detachConversationAttachments(
  client: PoolClient,
  conversationId: string,
): Promise<void> {
  await client.query(
    `UPDATE attachments attachment
        SET message_id = NULL,
            state = CASE
              WHEN EXISTS (
                SELECT 1
                  FROM favorite_attachments favorite_link
                 WHERE favorite_link.attachment_id = attachment.id
              ) THEN 'READY'
              ELSE 'CLEANUP_FAILED'
            END,
            state_updated_at = NOW()
       FROM messages message
      WHERE attachment.message_id = message.id
        AND message.conversation_id = $1`,
    [conversationId],
  );
}
