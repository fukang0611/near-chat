import type { PoolClient } from "pg";
import { query, transaction } from "./database.js";
import type { ReceiptSummaryDto } from "./message-service.js";
import type { RealtimeHub } from "./realtime.js";

export interface ReceiptChange {
  messageId: string;
  conversationId: string;
  receipt: ReceiptSummaryDto;
}

interface ReceiptRow {
  message_id: string;
  conversation_id: string;
  recipient_count: number;
  delivered_count: number;
  read_count: number;
}

const receiptSummarySelect = `
  SELECT m.id AS message_id,
         m.conversation_id,
         COUNT(mr.user_id)::int AS recipient_count,
         COUNT(mr.delivered_at)::int AS delivered_count,
         COUNT(mr.read_at)::int AS read_count
    FROM messages m
    LEFT JOIN message_receipts mr ON mr.message_id = m.id
   WHERE m.id = ANY($1::uuid[])
   GROUP BY m.id, m.conversation_id
`;

function toChanges(rows: ReceiptRow[]): ReceiptChange[] {
  return rows.map((row) => ({
    messageId: row.message_id,
    conversationId: row.conversation_id,
    receipt: {
      recipientCount: Number(row.recipient_count),
      deliveredCount: Number(row.delivered_count),
      readCount: Number(row.read_count),
    },
  }));
}

async function loadChanges(messageIds: string[], client?: PoolClient): Promise<ReceiptChange[]> {
  const uniqueIds = [...new Set(messageIds)];
  if (uniqueIds.length === 0) return [];
  const result = client
    ? await client.query<ReceiptRow>(receiptSummarySelect, [uniqueIds])
    : await query<ReceiptRow>(receiptSummarySelect, [uniqueIds]);
  return toChanges(result.rows);
}

/** 将实时推送成功的接收方标记为已送达。 */
export async function markMessageDelivered(
  messageId: string,
  recipientIds: string[],
): Promise<ReceiptChange[]> {
  const uniqueRecipientIds = [...new Set(recipientIds)];
  if (uniqueRecipientIds.length === 0) return [];

  const result = await query<{ message_id: string }>(
    `UPDATE message_receipts
        SET delivered_at = COALESCE(delivered_at, NOW())
      WHERE message_id = $1
        AND user_id = ANY($2::uuid[])
        AND delivered_at IS NULL
      RETURNING message_id`,
    [messageId, uniqueRecipientIds],
  );
  return result.rowCount ? loadChanges([messageId]) : [];
}

/** 用户从离线变为在线时，将等待中的消息统一推进到已送达状态。 */
export async function markPendingMessagesDelivered(userId: string): Promise<ReceiptChange[]> {
  const result = await query<{ message_id: string }>(
    `UPDATE message_receipts
        SET delivered_at = NOW()
      WHERE user_id = $1 AND delivered_at IS NULL
      RETURNING message_id`,
    [userId],
  );
  return loadChanges(result.rows.map((row) => row.message_id));
}

/**
 * 精确读到某条消息，避免“拉取历史”和“标记已读”之间到达的新消息被误判。
 * 返回值只包含本次真正发生变化的消息回执。
 */
export async function markConversationRead(
  conversationId: string,
  userId: string,
  throughMessageId: string | null,
): Promise<ReceiptChange[]> {
  return transaction(async (client) => {
    const membership = await client.query(
      `SELECT 1
         FROM conversation_members
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (membership.rowCount === 0) return [];

    const cutoff = throughMessageId
      ? await client.query<{ id: string }>(
          `SELECT id
             FROM messages
            WHERE id = $1 AND conversation_id = $2`,
          [throughMessageId, conversationId],
        )
      : await client.query<{ id: string }>(
          `SELECT id
             FROM messages
            WHERE conversation_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [conversationId],
        );

    const cutoffMessageId = cutoff.rows[0]?.id;
    if (!cutoffMessageId) return [];

    // 时间比较完全留在 PostgreSQL 中，避免 JavaScript Date 的毫秒精度截断微秒。
    await client.query(
      `UPDATE conversation_members
          SET last_read_at = GREATEST(
                last_read_at,
                (SELECT created_at FROM messages WHERE id = $3)
              )
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId, cutoffMessageId],
    );

    const updated = await client.query<{ message_id: string }>(
      `UPDATE message_receipts mr
          SET delivered_at = COALESCE(mr.delivered_at, NOW()),
              read_at = NOW()
         FROM messages m
        WHERE mr.message_id = m.id
          AND mr.user_id = $1
          AND m.conversation_id = $2
          AND m.created_at <= (SELECT created_at FROM messages WHERE id = $3)
          AND mr.read_at IS NULL
        RETURNING mr.message_id`,
      [userId, conversationId, cutoffMessageId],
    );
    return loadChanges(
      updated.rows.map((row) => row.message_id),
      client,
    );
  });
}

/** 按会话批量广播回执，群聊不会为每个成员重复发送同一组事件。 */
export async function broadcastReceiptChanges(
  realtime: RealtimeHub,
  changes: ReceiptChange[],
): Promise<void> {
  if (changes.length === 0) return;

  const conversationIds = [...new Set(changes.map((change) => change.conversationId))];
  const members = await query<{ conversation_id: string; member_ids: string[] }>(
    `SELECT conversation_id, array_agg(user_id) AS member_ids
       FROM conversation_members
      WHERE conversation_id = ANY($1::uuid[])
      GROUP BY conversation_id`,
    [conversationIds],
  );

  for (const conversation of members.rows) {
    realtime.sendToUsers(conversation.member_ids, {
      type: "receipt.changed",
      payload: {
        receipts: changes.filter(
          (change) => change.conversationId === conversation.conversation_id,
        ),
      },
    });
  }
}
