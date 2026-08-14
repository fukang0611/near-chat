import type { PoolClient } from "pg";

/**
 * 只有完全脱离原消息、转发消息、收藏、知识库和助理工作区的附件才能进入对象回收队列。
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
        )
        AND NOT EXISTS (
          SELECT 1
            FROM message_attachment_links message_link
           WHERE message_link.attachment_id = attachment.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM knowledge_documents knowledge_document
           WHERE knowledge_document.attachment_id = attachment.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM ai_assistant_files assistant_file
           WHERE assistant_file.attachment_id = attachment.id
        )`,
    [attachmentIds],
  );
}

/** 撤回消息时解除拥有和转发引用；其他消息或收藏仍引用的对象继续保持 READY。 */
export async function detachMessageAttachments(
  client: PoolClient,
  messageId: string,
): Promise<void> {
  const linked = await client.query<{ attachment_id: string }>(
    `DELETE FROM message_attachment_links
      WHERE message_id = $1
      RETURNING attachment_id`,
    [messageId],
  );
  await client.query(
    `UPDATE attachments attachment
        SET message_id = NULL,
            state = CASE
              WHEN EXISTS (
                SELECT 1
                  FROM favorite_attachments favorite_link
                 WHERE favorite_link.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM message_attachment_links message_link
                 WHERE message_link.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM knowledge_documents knowledge_document
                 WHERE knowledge_document.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM ai_assistant_files assistant_file
                 WHERE assistant_file.attachment_id = attachment.id
              ) THEN 'READY'
              ELSE 'CLEANUP_FAILED'
            END,
            state_updated_at = NOW()
      WHERE attachment.message_id = $1`,
    [messageId],
  );
  await stageDetachedAttachmentsForCleanup(
    client,
    linked.rows.map((row) => row.attachment_id),
  );
}

/** 解散会话时采用与单条撤回相同的引用保留规则。 */
export async function detachConversationAttachments(
  client: PoolClient,
  conversationId: string,
): Promise<void> {
  const linked = await client.query<{ attachment_id: string }>(
    `DELETE FROM message_attachment_links message_link
      USING messages message
      WHERE message_link.message_id = message.id
        AND message.conversation_id = $1
      RETURNING message_link.attachment_id`,
    [conversationId],
  );
  await client.query(
    `UPDATE attachments attachment
        SET message_id = NULL,
            state = CASE
              WHEN EXISTS (
                SELECT 1
                  FROM favorite_attachments favorite_link
                 WHERE favorite_link.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM message_attachment_links remaining_link
                 WHERE remaining_link.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM knowledge_documents knowledge_document
                 WHERE knowledge_document.attachment_id = attachment.id
              ) OR EXISTS (
                SELECT 1
                  FROM ai_assistant_files assistant_file
                 WHERE assistant_file.attachment_id = attachment.id
              ) THEN 'READY'
              ELSE 'CLEANUP_FAILED'
            END,
            state_updated_at = NOW()
       FROM messages message
      WHERE attachment.message_id = message.id
        AND message.conversation_id = $1`,
    [conversationId],
  );
  await stageDetachedAttachmentsForCleanup(
    client,
    linked.rows.map((row) => row.attachment_id),
  );
}
