import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";

const SETTINGS_ID = 1;
const SECRET_FORMAT = "v1";
const SETTINGS_LOCK_ID = 740_219;

export interface AiChatModelSettings {
  id: string;
  name: string;
  baseUrl: string | null;
  apiKey: string | null;
  providerModel: string;
  enabled: boolean;
}

/** 服务端运行时使用的完整设置，绝不能直接作为 HTTP 响应返回。 */
export interface AiRuntimeSettings {
  enabled: boolean;
  models: AiChatModelSettings[];
  defaultChatModelId: string | null;
  embedding: {
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
    dimensions: number;
  };
  revision: number;
  embeddingRevision: number;
  vectorEmbeddingRevision: number;
  updatedAt: string;
}

/** 管理端模型只暴露“是否已保存密钥”，永远不返回密钥正文或密文。 */
export interface AdminAiModel {
  id: string;
  name: string;
  baseUrl: string;
  providerModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  isDefault: boolean;
  updatedAt: string;
}

export interface AdminAiSettings {
  enabled: boolean;
  defaultChatModelId: string | null;
  models: AdminAiModel[];
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  revision: number;
  updatedAt: string;
}

export interface UpdateAiSettingsInput {
  enabled: boolean;
  defaultChatModelId: string | null;
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
  /** undefined 保留原值，null 清空，字符串替换。 */
  embeddingApiKey?: string | null;
}

export interface SaveAiModelInput {
  name: string;
  baseUrl: string | null;
  providerModel: string;
  enabled: boolean;
  /** undefined 保留原值（仅更新），null 清空，字符串替换。 */
  apiKey?: string | null;
}

export interface PublicAiModel {
  id: string;
  name: string;
  providerModel: string;
  isDefault: boolean;
}

interface AiSettingsRow {
  enabled: boolean;
  default_chat_model_id: string | null;
  embedding_base_url: string | null;
  embedding_api_key_encrypted: string | null;
  embedding_model: string | null;
  embedding_dimensions: number;
  revision: number;
  embedding_revision: number;
  vector_embedding_revision: number;
  updated_at: Date;
}

interface AiModelRow {
  id: string;
  name: string;
  base_url: string | null;
  api_key_encrypted: string | null;
  provider_model: string;
  enabled: boolean;
  updated_at: Date;
}

function encryptionKey(value = config.aiSettingsEncryptionKey): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** AES-256-GCM 同时保护密钥内容和完整性，每次写入均使用随机 IV。 */
export function encryptAiSecret(value: string, key?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_FORMAT,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

export function decryptAiSecret(value: string, key?: string): string {
  const [version, ivText, tagText, encryptedText, extra] = value.split(":");
  if (version !== SECRET_FORMAT || !ivText || !tagText || !encryptedText || extra) {
    throw new Error("无法识别 AI 密钥的加密格式");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(key),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptOrNull(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptAiSecret(value);
  } catch (error) {
    // 运维误换加密密钥时只降级 AI Provider，绝不能阻断聊天主服务启动。
    console.warn("Stored AI provider key cannot be decrypted; replace it in Admin Center:", error);
    return null;
  }
}

function nextEncryptedSecret(
  current: string | null,
  next: string | null | undefined,
): string | null {
  if (next === undefined) return current;
  return next === null ? null : encryptAiSecret(next);
}

function sameSecret(encrypted: string | null, next: string | null | undefined): boolean {
  if (next === undefined) return true;
  if (next === null) return encrypted === null;
  if (!encrypted) return false;
  try {
    return decryptAiSecret(encrypted) === next;
  } catch {
    return false;
  }
}

async function selectSettings(client?: PoolClient, lock = false): Promise<AiSettingsRow> {
  const sql = `SELECT enabled, default_chat_model_id, embedding_base_url,
                      embedding_api_key_encrypted, embedding_model, embedding_dimensions,
                      revision, embedding_revision, vector_embedding_revision, updated_at
                 FROM ai_settings
                WHERE id = $1${lock ? " FOR UPDATE" : ""}`;
  const result = client
    ? await client.query<AiSettingsRow>(sql, [SETTINGS_ID])
    : await query<AiSettingsRow>(sql, [SETTINGS_ID]);
  const row = result.rows[0];
  if (!row) throw new Error("AI 设置尚未初始化");
  return row;
}

async function selectModels(client?: PoolClient): Promise<AiModelRow[]> {
  const sql = `SELECT id, name, base_url, api_key_encrypted, provider_model, enabled, updated_at
                 FROM ai_model_configs
                ORDER BY enabled DESC, updated_at DESC, name`;
  const result = client ? await client.query<AiModelRow>(sql) : await query<AiModelRow>(sql);
  return result.rows;
}

function runtimeSettings(settings: AiSettingsRow, models: AiModelRow[]): AiRuntimeSettings {
  return {
    enabled: settings.enabled,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      baseUrl: model.base_url,
      apiKey: decryptOrNull(model.api_key_encrypted),
      providerModel: model.provider_model,
      enabled: model.enabled,
    })),
    defaultChatModelId: settings.default_chat_model_id,
    embedding: {
      baseUrl: settings.embedding_base_url,
      apiKey: decryptOrNull(settings.embedding_api_key_encrypted),
      model: settings.embedding_model,
      dimensions: settings.embedding_dimensions,
    },
    revision: settings.revision,
    embeddingRevision: settings.embedding_revision,
    vectorEmbeddingRevision: settings.vector_embedding_revision,
    updatedAt: settings.updated_at.toISOString(),
  };
}

function publicSettings(settings: AiSettingsRow, models: AiModelRow[]): AdminAiSettings {
  return {
    enabled: settings.enabled,
    defaultChatModelId: settings.default_chat_model_id,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      baseUrl: model.base_url ?? "",
      providerModel: model.provider_model,
      enabled: model.enabled,
      hasApiKey: Boolean(model.api_key_encrypted),
      isDefault: settings.default_chat_model_id === model.id,
      updatedAt: model.updated_at.toISOString(),
    })),
    embeddingBaseUrl: settings.embedding_base_url ?? "",
    embeddingModel: settings.embedding_model ?? "",
    embeddingDimensions: settings.embedding_dimensions,
    hasEmbeddingApiKey: Boolean(settings.embedding_api_key_encrypted),
    revision: settings.revision,
    updatedAt: settings.updated_at.toISOString(),
  };
}

/** 环境变量仅引导第一条设置与默认模型，已有数据库配置永远不会被覆盖。 */
export async function ensureAiSettings(): Promise<void> {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SETTINGS_LOCK_ID]);
    const existing = await client.query(`SELECT 1 FROM ai_settings WHERE id = $1`, [SETTINGS_ID]);
    if (existing.rowCount) return;

    const chatBaseUrl = config.ai.chat.baseUrl ?? config.ai.sharedBaseUrl ?? null;
    const chatApiKey = config.ai.chat.apiKey ?? config.ai.sharedApiKey ?? null;
    let defaultModelId: string | null = null;
    if (config.ai.chat.model) {
      defaultModelId = randomUUID();
      await client.query(
        `INSERT INTO ai_model_configs
           (id, name, base_url, api_key_encrypted, provider_model, enabled)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [
          defaultModelId,
          config.ai.chat.model,
          chatBaseUrl,
          chatApiKey ? encryptAiSecret(chatApiKey) : null,
          config.ai.chat.model,
        ],
      );
    }
    const embeddingBaseUrl = config.ai.embedding.baseUrl ?? config.ai.sharedBaseUrl ?? null;
    const embeddingApiKey = config.ai.embedding.apiKey ?? config.ai.sharedApiKey ?? null;
    await client.query(
      `INSERT INTO ai_settings
         (id, enabled, default_chat_model_id, embedding_base_url,
          embedding_api_key_encrypted, embedding_model, embedding_dimensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        SETTINGS_ID,
        config.ai.enabled,
        defaultModelId,
        embeddingBaseUrl,
        embeddingApiKey ? encryptAiSecret(embeddingApiKey) : null,
        config.ai.embedding.model ?? null,
        config.ai.embedding.dimensions,
      ],
    );
  });
}

export async function loadAiSettings(): Promise<AiRuntimeSettings> {
  await ensureAiSettings();
  const [settings, models] = await Promise.all([selectSettings(), selectModels()]);
  return runtimeSettings(settings, models);
}

export async function getAdminAiSettings(): Promise<AdminAiSettings> {
  await ensureAiSettings();
  const [settings, models] = await Promise.all([selectSettings(), selectModels()]);
  return publicSettings(settings, models);
}

export interface UpdatedAiSettings {
  settings: AdminAiSettings;
  runtime: AiRuntimeSettings;
  embeddingChanged: boolean;
}

export async function updateAiSettings(
  actorId: string,
  input: UpdateAiSettingsInput,
): Promise<UpdatedAiSettings> {
  await ensureAiSettings();
  const changed = await transaction(async (client) => {
    const current = await selectSettings(client, true);
    const models = await selectModels(client);
    const enabledModels = models.filter((model) => model.enabled);
    let defaultModelId = input.defaultChatModelId;
    if (defaultModelId && !enabledModels.some((model) => model.id === defaultModelId)) {
      throw new ApiError(400, "默认模型必须是已启用的模型");
    }
    if (!defaultModelId && enabledModels.length > 0) defaultModelId = enabledModels[0]!.id;
    if (input.enabled && enabledModels.length === 0) {
      throw new ApiError(400, "启用 AI 前至少需要配置一个可用的对话模型");
    }

    const embeddingChanged =
      current.embedding_base_url !== input.embeddingBaseUrl ||
      current.embedding_model !== input.embeddingModel ||
      current.embedding_dimensions !== input.embeddingDimensions ||
      !sameSecret(current.embedding_api_key_encrypted, input.embeddingApiKey);
    const result = await client.query<AiSettingsRow>(
      `UPDATE ai_settings
          SET enabled = $2,
              default_chat_model_id = $3,
              embedding_base_url = $4,
              embedding_api_key_encrypted = $5,
              embedding_model = $6,
              embedding_dimensions = $7,
              revision = revision + 1,
              embedding_revision = embedding_revision + CASE WHEN $8 THEN 1 ELSE 0 END,
              updated_by = $9,
              updated_at = NOW()
        WHERE id = $1
        RETURNING enabled, default_chat_model_id, embedding_base_url,
                  embedding_api_key_encrypted, embedding_model, embedding_dimensions,
                  revision, embedding_revision, vector_embedding_revision, updated_at`,
      [
        SETTINGS_ID,
        input.enabled,
        defaultModelId,
        input.embeddingBaseUrl,
        nextEncryptedSecret(current.embedding_api_key_encrypted, input.embeddingApiKey),
        input.embeddingModel,
        input.embeddingDimensions,
        embeddingChanged,
        actorId,
      ],
    );
    return { settings: result.rows[0]!, models, embeddingChanged };
  });
  return {
    settings: publicSettings(changed.settings, changed.models),
    runtime: runtimeSettings(changed.settings, changed.models),
    embeddingChanged: changed.embeddingChanged,
  };
}

async function reloadPublicAndRuntime(): Promise<{
  settings: AdminAiSettings;
  runtime: AiRuntimeSettings;
}> {
  const [settings, models] = await Promise.all([selectSettings(), selectModels()]);
  return { settings: publicSettings(settings, models), runtime: runtimeSettings(settings, models) };
}

export async function createAiModel(
  actorId: string,
  input: SaveAiModelInput,
): Promise<{ settings: AdminAiSettings; runtime: AiRuntimeSettings; modelId: string }> {
  await ensureAiSettings();
  if (!input.baseUrl && !input.apiKey) {
    throw new ApiError(400, "模型必须配置 API Key 或本地 OpenAI 兼容服务地址");
  }
  const modelId = randomUUID();
  try {
    await transaction(async (client) => {
      const settings = await selectSettings(client, true);
      await client.query(
        `INSERT INTO ai_model_configs
           (id, name, base_url, api_key_encrypted, provider_model, enabled, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          modelId,
          input.name,
          input.baseUrl,
          input.apiKey ? encryptAiSecret(input.apiKey) : null,
          input.providerModel,
          input.enabled,
          actorId,
        ],
      );
      const defaultId = settings.default_chat_model_id ?? (input.enabled ? modelId : null);
      await client.query(
        `UPDATE ai_settings
            SET default_chat_model_id = $2, revision = revision + 1,
                updated_by = $3, updated_at = NOW()
          WHERE id = $1`,
        [SETTINGS_ID, defaultId, actorId],
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ApiError(409, "模型名称已存在");
    }
    throw error;
  }
  return { ...(await reloadPublicAndRuntime()), modelId };
}

export async function updateAiModel(
  actorId: string,
  modelId: string,
  input: SaveAiModelInput,
): Promise<{ settings: AdminAiSettings; runtime: AiRuntimeSettings }> {
  await ensureAiSettings();
  try {
    await transaction(async (client) => {
      const settings = await selectSettings(client, true);
      const found = await client.query<AiModelRow>(
        `SELECT id, name, base_url, api_key_encrypted, provider_model, enabled, updated_at
           FROM ai_model_configs WHERE id = $1 FOR UPDATE`,
        [modelId],
      );
      const current = found.rows[0];
      if (!current) throw new ApiError(404, "模型配置不存在");
      const nextKey = nextEncryptedSecret(current.api_key_encrypted, input.apiKey);
      if (!input.baseUrl && !nextKey) {
        throw new ApiError(400, "模型必须保留 API Key 或本地 OpenAI 兼容服务地址");
      }
      await client.query(
        `UPDATE ai_model_configs
            SET name = $2, base_url = $3, api_key_encrypted = $4,
                provider_model = $5, enabled = $6, updated_by = $7, updated_at = NOW()
          WHERE id = $1`,
        [modelId, input.name, input.baseUrl, nextKey, input.providerModel, input.enabled, actorId],
      );
      let defaultId = settings.default_chat_model_id;
      if (!input.enabled && defaultId === modelId) {
        const replacement = await client.query<{ id: string }>(
          `SELECT id FROM ai_model_configs
            WHERE id <> $1 AND enabled = TRUE
            ORDER BY updated_at DESC LIMIT 1`,
          [modelId],
        );
        defaultId = replacement.rows[0]?.id ?? null;
        if (settings.enabled && !defaultId) {
          throw new ApiError(400, "AI 已启用，不能停用唯一可用的默认模型");
        }
      } else if (input.enabled && !defaultId) {
        defaultId = modelId;
      }
      await client.query(
        `UPDATE ai_settings
            SET default_chat_model_id = $2, revision = revision + 1,
                updated_by = $3, updated_at = NOW()
          WHERE id = $1`,
        [SETTINGS_ID, defaultId, actorId],
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ApiError(409, "模型名称已存在");
    }
    throw error;
  }
  return reloadPublicAndRuntime();
}

export async function deleteAiModel(
  actorId: string,
  modelId: string,
): Promise<{ settings: AdminAiSettings; runtime: AiRuntimeSettings }> {
  await ensureAiSettings();
  await transaction(async (client) => {
    const settings = await selectSettings(client, true);
    const found = await client.query<{ id: string }>(
      `SELECT id FROM ai_model_configs WHERE id = $1 FOR UPDATE`,
      [modelId],
    );
    if (!found.rows[0]) throw new ApiError(404, "模型配置不存在");
    const replacement = await client.query<{ id: string }>(
      `SELECT id FROM ai_model_configs
        WHERE id <> $1 AND enabled = TRUE
        ORDER BY updated_at DESC LIMIT 1`,
      [modelId],
    );
    const nextDefault =
      settings.default_chat_model_id === modelId
        ? (replacement.rows[0]?.id ?? null)
        : settings.default_chat_model_id;
    if (settings.enabled && !nextDefault) {
      throw new ApiError(400, "AI 已启用，不能删除唯一可用的默认模型");
    }
    await client.query(`DELETE FROM ai_model_configs WHERE id = $1`, [modelId]);
    await client.query(
      `UPDATE ai_settings
          SET default_chat_model_id = $2, revision = revision + 1,
              updated_by = $3, updated_at = NOW()
        WHERE id = $1`,
      [SETTINGS_ID, nextDefault, actorId],
    );
  });
  return reloadPublicAndRuntime();
}

export async function listUserAiModels(userId: string): Promise<{
  models: PublicAiModel[];
  selectedModelId: string | null;
  defaultModelId: string | null;
}> {
  const result = await query<AiModelRow & { preferred: boolean; is_default: boolean }>(
    `SELECT model.id, model.name, model.base_url, model.api_key_encrypted,
            model.provider_model, model.enabled, model.updated_at,
            (preference.user_id IS NOT NULL) AS preferred,
            (settings.default_chat_model_id = model.id) AS is_default
       FROM ai_model_configs model
       CROSS JOIN ai_settings settings
       LEFT JOIN user_ai_preferences preference
         ON preference.chat_model_id = model.id AND preference.user_id = $1
      WHERE settings.id = 1 AND settings.enabled = TRUE AND model.enabled = TRUE
        AND (model.api_key_encrypted IS NOT NULL OR model.base_url IS NOT NULL)
      ORDER BY is_default DESC, model.name`,
    [userId],
  );
  const models = result.rows.map((model) => ({
    id: model.id,
    name: model.name,
    providerModel: model.provider_model,
    isDefault: model.is_default,
  }));
  const defaultModelId = models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
  const selectedModelId = result.rows.find((model) => model.preferred)?.id ?? defaultModelId;
  return { models, selectedModelId, defaultModelId };
}

export async function setUserAiModel(userId: string, modelId: string | null): Promise<void> {
  if (!modelId) {
    await query(`DELETE FROM user_ai_preferences WHERE user_id = $1`, [userId]);
    return;
  }
  const available = await query<{ id: string }>(
    `SELECT model.id
       FROM ai_model_configs model
       JOIN ai_settings settings ON settings.id = 1
      WHERE model.id = $1 AND model.enabled = TRUE AND settings.enabled = TRUE
        AND (model.api_key_encrypted IS NOT NULL OR model.base_url IS NOT NULL)`,
    [modelId],
  );
  if (!available.rows[0]) throw new ApiError(400, "所选模型当前不可用");
  await query(
    `INSERT INTO user_ai_preferences (user_id, chat_model_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET chat_model_id = EXCLUDED.chat_model_id, updated_at = NOW()`,
    [userId, modelId],
  );
}

export async function resolveUserAiModelId(
  userId: string,
  requestedModelId?: string,
): Promise<string | null> {
  const models = await listUserAiModels(userId);
  if (requestedModelId && models.models.some((model) => model.id === requestedModelId)) {
    return requestedModelId;
  }
  return models.selectedModelId;
}

/** 向量索引完成重建并重新排队文档后，记录它对应的模型版本。 */
export async function markVectorEmbeddingRevision(embeddingRevision: number): Promise<void> {
  await query(
    `UPDATE ai_settings
        SET vector_embedding_revision = $2
      WHERE id = $1 AND embedding_revision = $2`,
    [SETTINGS_ID, embeddingRevision],
  );
}
