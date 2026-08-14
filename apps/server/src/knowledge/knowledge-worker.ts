import { randomUUID } from "node:crypto";
import { MDocument } from "@mastra/rag";
import {
  deleteDocumentVectors,
  getAiCapabilities,
  replaceDocumentVectors,
  type KnowledgeVectorChunk,
} from "../ai/ai-runtime.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { minio } from "../minio.js";
import { extractKnowledgeDocument } from "./document-extractor.js";

interface IndexJobRow {
  id: string;
  document_id: string;
  action: "INDEX" | "DELETE";
  attempts: number;
}

interface IndexDocumentRow {
  id: string;
  knowledge_base_id: string;
  name: string;
  content_type: string;
  size_bytes: string;
  bucket_name: string;
  object_key: string;
  attachment_state: string;
}

async function claimJob(): Promise<IndexJobRow | null> {
  return transaction(async (client) => {
    const result = await client.query<IndexJobRow>(
      `SELECT id, document_id, action, attempts
         FROM knowledge_index_jobs
        WHERE (
          (status = 'QUEUED' AND next_attempt_at <= NOW())
          OR (status = 'RUNNING' AND updated_at < NOW() - INTERVAL '15 minutes')
        )
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const job = result.rows[0];
    if (!job) return null;
    const claimed = await client.query<IndexJobRow>(
      `UPDATE knowledge_index_jobs
          SET status = 'RUNNING', attempts = attempts + 1,
              error_message = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING id, document_id, action, attempts`,
      [job.id],
    );
    if (job.action === "INDEX") {
      await client.query(
        `UPDATE knowledge_documents
            SET status = 'INDEXING', error_message = NULL, updated_at = NOW()
          WHERE id = $1`,
        [job.document_id],
      );
    }
    return claimed.rows[0] ?? null;
  });
}

async function loadDocument(documentId: string): Promise<IndexDocumentRow | null> {
  const result = await query<IndexDocumentRow>(
    `SELECT document.id, document.knowledge_base_id, document.name, document.content_type,
            document.size_bytes::text, attachment.bucket_name, attachment.object_key,
            attachment.state AS attachment_state
       FROM knowledge_documents document
       JOIN attachments attachment ON attachment.id = document.attachment_id
      WHERE document.id = $1`,
    [documentId],
  );
  return result.rows[0] ?? null;
}

async function downloadObject(document: IndexDocumentRow): Promise<Buffer> {
  if (document.attachment_state !== "READY") throw new Error("原文件尚未就绪");
  const expectedBytes = Number(document.size_bytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > config.fileMaxBytes) {
    throw new Error("文件大小超出知识库处理限制");
  }
  const stream = await minio.getObject(document.bucket_name, document.object_key);
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of stream) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    bytes += buffer.length;
    if (bytes > config.fileMaxBytes) {
      stream.destroy();
      throw new Error("文件读取超过知识库处理限制");
    }
    parts.push(buffer);
  }
  return Buffer.concat(parts, bytes);
}

async function indexDocument(job: IndexJobRow): Promise<void> {
  const document = await loadDocument(job.document_id);
  if (!document) {
    // 文档可能在任务排队期间被用户删除；删除任务会负责清理可能存在的旧向量。
    return;
  }
  const file = await downloadObject(document);
  const extracted = await extractKnowledgeDocument(file, document.name, document.content_type);
  const mDocument = MDocument.fromText(extracted.text, {
    documentId: document.id,
    knowledgeBaseId: document.knowledge_base_id,
    sourceKind: extracted.kind,
  });
  const pieces = await mDocument.chunk({
    strategy: "recursive",
    maxSize: config.ai.knowledge.chunkSize,
    overlap: Math.min(config.ai.knowledge.chunkOverlap, config.ai.knowledge.chunkSize - 1),
  });
  const usablePieces = pieces.map((piece) => piece.text.trim()).filter(Boolean);
  if (usablePieces.length === 0) throw new Error("文档中没有可索引的文字");
  if (usablePieces.length > config.ai.knowledge.maxChunks) {
    throw new Error(`文档切片超过 ${config.ai.knowledge.maxChunks} 个限制`);
  }

  const chunks: KnowledgeVectorChunk[] = usablePieces.map((text, position) => ({
    id: randomUUID(),
    knowledgeBaseId: document.knowledge_base_id,
    documentId: document.id,
    position,
    text,
  }));
  // 向量是可重建派生数据，先原子替换向量，再提交 NearChat 中的来源文本。
  await replaceDocumentVectors(chunks);
  await transaction(async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM knowledge_documents WHERE id = $1 FOR UPDATE`,
      [document.id],
    );
    if (!exists.rowCount) return;
    await client.query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [document.id]);
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO knowledge_chunks (id, document_id, position, text_content)
         VALUES ($1, $2, $3, $4)`,
        [chunk.id, document.id, chunk.position, chunk.text],
      );
    }
    await client.query(
      `UPDATE knowledge_documents
          SET status = 'READY', chunk_count = $2, error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [document.id, chunks.length],
    );
    await client.query(
      `UPDATE knowledge_bases
          SET updated_at = NOW()
        WHERE id = $1`,
      [document.knowledge_base_id],
    );
  });
}

async function completeJob(jobId: string): Promise<void> {
  await query(
    `UPDATE knowledge_index_jobs
        SET status = 'COMPLETED', error_message = NULL, updated_at = NOW()
      WHERE id = $1`,
    [jobId],
  );
}

async function failJob(job: IndexJobRow, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : "索引任务执行失败").slice(0, 500);
  const retry = job.attempts < 3;
  await transaction(async (client) => {
    await client.query(
      `UPDATE knowledge_index_jobs
          SET status = $2,
              next_attempt_at = CASE
                WHEN $2 = 'QUEUED' THEN NOW() + ($3::double precision * INTERVAL '1 second')
                ELSE next_attempt_at
              END,
              error_message = $4,
              updated_at = NOW()
        WHERE id = $1`,
      [job.id, retry ? "QUEUED" : "FAILED", 2 ** job.attempts * 5, message],
    );
    if (job.action === "INDEX") {
      await client.query(
        `UPDATE knowledge_documents
            SET status = $2, error_message = $3, updated_at = NOW()
          WHERE id = $1`,
        [job.document_id, retry ? "QUEUED" : "FAILED", message],
      );
    }
  });
  console.error(`Knowledge ${job.action.toLowerCase()} job ${job.id} failed:`, error);
}

async function processJob(job: IndexJobRow): Promise<void> {
  try {
    if (job.action === "DELETE") await deleteDocumentVectors(job.document_id);
    else await indexDocument(job);
    await completeJob(job.id);
  } catch (error) {
    await failJob(job, error);
  }
}

/**
 * 轻量持久任务器适合当前单体与小规模 Rancher 部署。任务状态在 PostgreSQL 中，
 * 服务重启会继续处理；AI 未就绪时不认领任务，文件仍安全保留在 MinIO。
 */
export function startKnowledgeIndexWorker(): () => void {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped || !getAiCapabilities().features.knowledgeIndexing) return;
    running = true;
    try {
      // 单轮最多处理 10 项，既缩短新任务等待，也不长期占据事件循环。
      for (let count = 0; count < 10 && !stopped; count += 1) {
        const job = await claimJob();
        if (!job) break;
        await processJob(job);
      }
    } catch (error) {
      console.error("Knowledge index worker cycle failed:", error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, config.ai.knowledge.pollMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
