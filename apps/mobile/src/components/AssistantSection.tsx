import { FormEvent, useEffect, useMemo, useState } from "react";
import { LocalAgentRuntime } from "@near-chat/agent-protocol";
import type {
  LocalAssistant,
  LocalAssistantMessage,
  LocalAssistantThread,
  LocalMemory,
} from "../models";
import {
  ASSISTANT_INSTRUCTIONS_MAX,
  ASSISTANT_MESSAGE_MAX,
  ASSISTANT_NAME_MAX,
  validateAssistantDraft,
  validateAssistantMessage,
} from "../entity-limits";
import {
  listEntities,
  nativeAgentTransport,
  saveLocalEntity,
  searchEntities,
  secureGet,
} from "../native";
import {
  createDefaultAssistantWorkspace,
  createMissingAssistantThreads,
} from "../assistant-defaults";
import { createDeviceGeneratedAssistantMessage } from "../assistant-messages";
import { prepareAssistantMemoryAugmentation } from "../assistant-memory-context";
import { DEFAULT_ASSISTANT_TOOL_GRANTS } from "@near-chat/domain";

const now = () => new Date().toISOString();
const workspaceInitializers = new Map<string, Promise<void>>();

async function ensureDefaultWorkspace(
  accountKey: string,
  sessionGeneration: string,
  isAccountActive: () => boolean,
): Promise<void> {
  const initializerKey = `${accountKey}\u0000${sessionGeneration}`;
  const active = workspaceInitializers.get(initializerKey);
  if (active) return active;
  const created = (async () => {
    const [existingAssistants, existingThreads] = await Promise.all([
      listEntities(accountKey, "ASSISTANT") as Promise<LocalAssistant[]>,
      listEntities(accountKey, "ASSISTANT_THREAD") as Promise<LocalAssistantThread[]>,
    ]);
    if (!isAccountActive()) return;

    if (existingAssistants.length === 0) {
      const { assistant, thread } = createDefaultAssistantWorkspace(now());
      // 若进程在两次写入之间退出，下次初始化会进入下面的孤儿修复分支。
      await saveLocalEntity(accountKey, "ASSISTANT", assistant);
      if (!isAccountActive()) return;
      await saveLocalEntity(accountKey, "ASSISTANT_THREAD", thread);
      return;
    }

    const repairs = createMissingAssistantThreads(existingAssistants, existingThreads, now());
    for (const thread of repairs) {
      if (!isAccountActive()) return;
      await saveLocalEntity(accountKey, "ASSISTANT_THREAD", thread);
    }
  })();
  workspaceInitializers.set(initializerKey, created);
  try {
    await created;
  } finally {
    workspaceInitializers.delete(initializerKey);
  }
}

interface Props {
  accountKey: string;
  canInitializeDefault: boolean;
  refreshVersion: number;
  onChanged(): void;
  sessionGeneration: string;
  isAccountActive(): boolean;
}

export function AssistantSection({
  accountKey,
  canInitializeDefault,
  refreshVersion,
  onChanged,
  sessionGeneration,
  isAccountActive,
}: Props) {
  const [assistants, setAssistants] = useState<LocalAssistant[]>([]);
  const [threads, setThreads] = useState<LocalAssistantThread[]>([]);
  const [messages, setMessages] = useState<LocalAssistantMessage[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    if (canInitializeDefault) {
      await ensureDefaultWorkspace(accountKey, sessionGeneration, isAccountActive);
    }
    if (!isAccountActive()) return;
    const nextAssistants = await listEntities(accountKey, "ASSISTANT");
    const nextThreads = await listEntities(accountKey, "ASSISTANT_THREAD");
    const nextMessages = await listEntities(accountKey, "ASSISTANT_MESSAGE");
    if (!isAccountActive()) return;
    setAssistants(nextAssistants);
    setThreads(nextThreads);
    setMessages(nextMessages);
    if (!nextAssistants.some((assistant) => assistant.id === selectedAssistantId)) {
      setSelectedAssistantId(nextAssistants[0]?.id ?? "");
    }
  };

  useEffect(() => {
    void reload();
    // refreshVersion 是跨模块同步完成后的显式失效信号。
  }, [accountKey, canInitializeDefault, refreshVersion]);

  const assistant = creating
    ? undefined
    : (assistants.find((candidate) => candidate.id === selectedAssistantId) ?? assistants[0]);
  const assistantThreads = threads.filter(
    (candidate) => candidate.assistantId === assistant?.id && !candidate.archived,
  );
  const thread = assistantThreads.find((candidate) => candidate.isDefault) ?? assistantThreads[0];
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.threadId === thread?.id),
    [messages, thread?.id],
  );

  const saveAssistant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAccountActive()) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const instructions = String(form.get("instructions") ?? "").trim();
    const validationError = validateAssistantDraft(name, instructions);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    const timestamp = now();
    const next: LocalAssistant = assistant
      ? { ...assistant, name, instructions, updatedAt: timestamp }
      : {
          id: crypto.randomUUID(),
          name,
          description: "本地自定义助理",
          category: "GENERAL",
          instructions,
          avatarColor: "#2FA98C",
          modelId: null,
          toolGrants: { ...DEFAULT_ASSISTANT_TOOL_GRANTS },
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    await saveLocalEntity(accountKey, "ASSISTANT", next);
    if (!isAccountActive()) return;
    if (!thread || thread.assistantId !== next.id) {
      const nextThread: LocalAssistantThread = {
        id: crypto.randomUUID(),
        assistantId: next.id,
        title: "默认对话",
        archived: false,
        isDefault: true,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await saveLocalEntity(accountKey, "ASSISTANT_THREAD", nextThread);
      if (!isAccountActive()) return;
    }
    setSelectedAssistantId(next.id);
    setCreating(false);
    await reload();
    onChanged();
  };

  const newAssistant = () => {
    setCreating(true);
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assistant || !thread || busy) return;
    const form = new FormData(event.currentTarget);
    const content = String(form.get("message") ?? "").trim();
    const validationError = validateAssistantMessage(content);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError("");
    const createdAt = now();
    const userMessage: LocalAssistantMessage = {
      id: crypto.randomUUID(),
      assistantId: assistant.id,
      threadId: thread.id,
      role: "USER",
      content,
      modelId: null,
      sources: [],
      revision: 0,
      createdAt,
    };
    try {
      if (!isAccountActive()) return;
      await saveLocalEntity(accountKey, "ASSISTANT_MESSAGE", userMessage);
      if (!isAccountActive()) return;
      setMessages((current) => [...current, userMessage]);
      event.currentTarget.reset();
      const [baseUrl, apiKey, configuredModel] = await Promise.all([
        secureGet("model-base-url"),
        secureGet("model-api-key"),
        secureGet("model-name"),
      ]);
      const model = configuredModel;
      if (!isAccountActive()) return;
      if (!baseUrl || !apiKey || !model)
        throw new Error("请先在“我的”中配置模型地址、模型名和 API Key");

      const allowPrivateMemory = assistant.toolGrants?.privateMemoryRead === true;
      const runtime = new LocalAgentRuntime(
        { baseUrl, apiKey, model, timeoutMs: 45_000 },
        nativeAgentTransport,
        allowPrivateMemory
          ? {
              search_local_memories: async (argumentsValue) => {
                if (!isAccountActive()) return [];
                const query = typeof argumentsValue.query === "string" ? argumentsValue.query : "";
                const hits = await searchEntities(accountKey, query, ["MEMORY"], 5);
                if (!isAccountActive()) return [];
                return hits.map(({ entity }) => entity as LocalMemory);
              },
            }
          : {},
      );
      const memoryAugmentation = await prepareAssistantMemoryAugmentation(assistant, () =>
        runtime.executeTool({
          id: crypto.randomUUID(),
          name: "search_local_memories",
          arguments: { query: content },
        }),
      );
      if (!isAccountActive()) return;
      const response = await runtime.generate({
        modelId: null,
        instructions: memoryAugmentation.instructions,
        messages: [...visibleMessages, userMessage].slice(-30).map((message) => ({
          role: message.role === "USER" ? "user" : "assistant",
          content: message.content,
        })),
        toolContext: {
          requesterUserId: accountKey,
          assistantId: assistant.id,
          invocationId: null,
          visibility: "PRIVATE_PREVIEW",
          allowedConversationIds: [],
          allowPrivateMemory: memoryAugmentation.allowPrivateMemory,
        },
        sourceIds: memoryAugmentation.sourceIds,
      });
      if (!isAccountActive()) return;
      const responseValidationError = validateAssistantMessage(response.text);
      if (responseValidationError) {
        throw new Error(`模型回复无法保存：${responseValidationError}`);
      }
      const reply = createDeviceGeneratedAssistantMessage({
        id: crypto.randomUUID(),
        assistantId: assistant.id,
        threadId: thread.id,
        content: response.text,
        sources: memoryAugmentation.sources,
        createdAt: now(),
      });
      await saveLocalEntity(accountKey, "ASSISTANT_MESSAGE", reply);
      if (!isAccountActive()) return;
      setMessages((current) => [...current, reply]);
      onChanged();
    } catch (caught) {
      if (!isAccountActive()) return;
      setError(caught instanceof Error ? caught.message : "助理请求失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="section-title-row">
        <div>
          <h1>本地助理</h1>
          <small>对话保存在 Room；模型请求直连你配置的兼容接口。</small>
        </div>
        <button className="secondary" onClick={newAssistant}>
          新助理
        </button>
      </div>
      {assistants.length > 1 && (
        <select
          value={selectedAssistantId}
          onChange={(event) => {
            setCreating(false);
            setSelectedAssistantId(event.target.value);
          }}
        >
          {assistants.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      )}
      <details>
        <summary>助理设置</summary>
        <form key={assistant?.id ?? "new"} onSubmit={saveAssistant}>
          <input
            name="name"
            defaultValue={assistant?.name ?? ""}
            placeholder="助理名称"
            maxLength={ASSISTANT_NAME_MAX}
            required
          />
          <textarea
            name="instructions"
            defaultValue={assistant?.instructions ?? ""}
            placeholder="助理说明"
            maxLength={ASSISTANT_INSTRUCTIONS_MAX}
            required
          />
          <button>保存助理</button>
        </form>
      </details>
      <div className="message-list" aria-live="polite">
        {visibleMessages.length === 0 && <p className="empty">还没有对话。断网时历史仍可查看。</p>}
        {visibleMessages.map((message) => (
          <article key={message.id} className={`message ${message.role.toLocaleLowerCase()}`}>
            <div>
              <strong>{message.role === "USER" ? "我" : (assistant?.name ?? "助理")}</strong>
              <p>{message.content}</p>
              {message.sources.length > 0 && (
                <small>引用了 {message.sources.length} 条本地记忆</small>
              )}
            </div>
          </article>
        ))}
      </div>
      <form onSubmit={send}>
        <textarea
          name="message"
          placeholder="给本地助理发消息"
          maxLength={ASSISTANT_MESSAGE_MAX}
          required
        />
        <button disabled={busy}>{busy ? "正在生成…" : "发送"}</button>
        {error && <small className="error-text">{error}</small>}
      </form>
    </section>
  );
}
