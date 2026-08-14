import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { PoolClient } from "pg";
import { recordAudit } from "../audit-service.js";
import { config } from "../config.js";
import { query, transaction } from "../database.js";
import { ApiError } from "../http.js";
import { saveAssistantGeneratedBuffer } from "./assistant-file-service.js";

export type AssistantBrowserAction = "OPEN" | "READ" | "SCREENSHOT" | "CLICK" | "FILL";
export type AssistantBrowserRunStatus =
  "AWAITING_CONFIRMATION" | "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type AssistantBrowserStepStatus =
  "AWAITING_CONFIRMATION" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export const ASSISTANT_BROWSER_RUN_LIMIT = 20;
export const ASSISTANT_BROWSER_STEP_LIMIT = 30;
const PAGE_EXCERPT_LIMIT = 12_000;
const PAGE_ELEMENT_LIMIT = 40;

export interface BrowserPermissionInput {
  enabled: boolean;
  allowScreenshot: boolean;
  allowInteraction: boolean;
}

export interface BrowserStepInput {
  action: Exclude<AssistantBrowserAction, "OPEN">;
  elementRef?: string;
}

export interface BrowserElementSnapshot {
  ref: string;
  kind: "LINK" | "BUTTON" | "INPUT" | "TEXTAREA" | "SELECT" | "EDITABLE";
  label: string;
  inputType: string | null;
  href: string | null;
  disabled: boolean;
}

interface BrowserPermissionRow {
  assistant_id: string | null;
  enabled: boolean | null;
  allow_screenshot: boolean | null;
  allow_interaction: boolean | null;
  updated_at: Date | null;
}

interface BrowserRunRow {
  id: string;
  assistant_id: string;
  owner_id: string;
  goal: string;
  start_url: string;
  status: AssistantBrowserRunStatus;
  current_url: string | null;
  page_title: string | null;
  page_excerpt: string | null;
  page_elements: BrowserElementSnapshot[];
  opened_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface BrowserStepRow {
  id: string;
  run_id: string;
  sequence: number;
  action: AssistantBrowserAction;
  status: AssistantBrowserStepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifact_file_id: string | null;
  confirmed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  artifact_attachment_id: string | null;
  artifact_name: string | null;
  artifact_content_type: string | null;
  artifact_size_bytes: string | null;
}

interface BrowserSession {
  assistantId: string;
  ownerId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  touchedAt: number;
  /** 表单值只在当前无痕会话内用于清理页面回显，永不作为步骤参数落库。 */
  sensitiveValues: Set<string>;
}

interface PageSnapshot {
  url: string;
  title: string;
  excerpt: string;
  elements: BrowserElementSnapshot[];
}

const sessions = new Map<string, BrowserSession>();
const launchingSessions = new Map<string, { ownerId: string }>();

/** LEFT JOIN 在尚未授权时仍返回助理行，因此每个授权字段都必须按空值处理。 */
export function publicAssistantBrowserPermission(
  row: BrowserPermissionRow | null,
  assistantId: string,
) {
  return {
    assistantId,
    enabled: row?.enabled ?? false,
    allowRead: true,
    allowScreenshot: row?.allow_screenshot ?? false,
    allowInteraction: row?.allow_interaction ?? false,
    updatedAt: row?.updated_at?.toISOString() ?? null,
  };
}

function publicStep(row: BrowserStepRow) {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    action: row.action,
    status: row.status,
    input: row.input ?? {},
    output: row.output ?? {},
    artifact:
      row.artifact_file_id && row.artifact_attachment_id && row.artifact_name
        ? {
            assistantFileId: row.artifact_file_id,
            attachment: {
              id: row.artifact_attachment_id,
              originalName: row.artifact_name,
              contentType: row.artifact_content_type ?? "image/png",
              sizeBytes: Number(row.artifact_size_bytes ?? 0),
            },
          }
        : null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  };
}

function publicRun(row: BrowserRunRow, steps: BrowserStepRow[]) {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    goal: row.goal,
    startUrl: row.start_url,
    status: row.status,
    currentUrl: row.current_url,
    pageTitle: row.page_title,
    pageExcerpt: row.page_excerpt,
    pageElements: Array.isArray(row.page_elements) ? row.page_elements : [],
    openedAt: row.opened_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    steps: steps.map(publicStep),
  };
}

async function assertAssistantOwner(
  client: PoolClient,
  userId: string,
  assistantId: string,
  lock = false,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM ai_assistants
      WHERE id = $1 AND owner_id = $2${lock ? " FOR UPDATE" : ""}`,
    [assistantId, userId],
  );
  if (!result.rowCount) throw new ApiError(404, "智能助理不存在");
}

async function permissionRow(
  userId: string,
  assistantId: string,
  client?: PoolClient,
): Promise<BrowserPermissionRow | null> {
  const statement = `SELECT permission.assistant_id, permission.enabled,
                            permission.allow_screenshot, permission.allow_interaction,
                            permission.updated_at
                       FROM ai_assistants assistant
                       LEFT JOIN ai_assistant_browser_permissions permission
                         ON permission.assistant_id = assistant.id
                      WHERE assistant.id = $1 AND assistant.owner_id = $2`;
  const result = client
    ? await client.query<BrowserPermissionRow>(statement, [assistantId, userId])
    : await query<BrowserPermissionRow>(statement, [assistantId, userId]);
  if (!result.rowCount) throw new ApiError(404, "智能助理不存在");
  return result.rows[0] ?? null;
}

function requirePermission(
  permission: BrowserPermissionRow | null,
  action: AssistantBrowserAction,
): void {
  if (!permission?.enabled) throw new ApiError(403, "请先为该助理启用浏览器工具");
  if (action === "SCREENSHOT" && !permission.allow_screenshot) {
    throw new ApiError(403, "该助理尚未获得页面截图权限");
  }
  if ((action === "CLICK" || action === "FILL") && !permission.allow_interaction) {
    throw new ApiError(403, "该助理尚未获得页面交互权限");
  }
}

/** 仅允许显式 HTTP(S) 地址；局域网地址可用，但云元数据端点始终拒绝。 */
export function normalizeAssistantBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 2048) throw new ApiError(400, "请输入有效的页面地址");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "页面地址必须包含 http:// 或 https://");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
    throw new ApiError(400, "浏览器工具只支持 HTTP 或 HTTPS 页面");
  }
  if (url.username || url.password) throw new ApiError(400, "页面地址不能携带账号或密码");
  if (isBlockedBrowserDestination(url)) throw new ApiError(400, "该系统保留地址不可访问");
  return url.toString();
}

function isBlockedBrowserDestination(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host.startsWith("169.254.") ||
    host === "100.100.100.200" ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host.startsWith("fe80:")
  );
}

function allowBrowserRequest(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return !isBlockedBrowserDestination(url);
  } catch {
    return false;
  }
}

/** 元素引用由服务端页面快照生成，客户端不能传入任意 CSS 或脚本。 */
export function validateBrowserElementRef(value: string): string {
  if (!/^e(?:[1-9]|[1-3][0-9]|40)$/.test(value)) {
    throw new ApiError(400, "页面元素引用已失效，请先重新读取页面");
  }
  return value;
}

function findChromiumExecutable(): string {
  const candidates = [
    config.ai.browser.executablePath,
    "/usr/bin/chromium-headless-shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((value): value is string => Boolean(value));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new ApiError(503, "浏览器运行时未安装，请检查服务镜像中的 Chromium");
  }
  return executable;
}

async function createSession(run: BrowserRunRow): Promise<BrowserSession> {
  const totalSessions = sessions.size + launchingSessions.size;
  if (totalSessions >= config.ai.browser.maxSessions) {
    throw new ApiError(429, "浏览器执行席位已满，请稍后再试");
  }
  const ownerSessions = [...sessions.values()].filter(
    (session) => session.ownerId === run.owner_id,
  ).length;
  const ownerLaunching = [...launchingSessions.values()].filter(
    (session) => session.ownerId === run.owner_id,
  ).length;
  if (ownerSessions + ownerLaunching >= config.ai.browser.maxSessionsPerUser) {
    throw new ApiError(
      429,
      `每位用户同时最多运行 ${config.ai.browser.maxSessionsPerUser} 个浏览器执行`,
    );
  }
  launchingSessions.set(run.id, { ownerId: run.owner_id });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      executablePath: findChromiumExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
    });
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      colorScheme: "light",
      userAgent: "NearChat Controlled Browser/1.0",
    });
    await context.route("**/*", async (route) => {
      if (!allowBrowserRequest(route.request().url())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.ai.browser.actionTimeoutMs);
    page.setDefaultNavigationTimeout(config.ai.browser.navigationTimeoutMs);
    page.on("download", (download) => void download.cancel());
    const session = {
      assistantId: run.assistant_id,
      ownerId: run.owner_id,
      browser,
      context,
      page,
      touchedAt: Date.now(),
      sensitiveValues: new Set<string>(),
    };
    sessions.set(run.id, session);
    return session;
  } catch (error) {
    await browser?.close().catch(() => undefined);
    throw error;
  } finally {
    launchingSessions.delete(run.id);
  }
}

async function closeSession(runId: string): Promise<void> {
  const session = sessions.get(runId);
  sessions.delete(runId);
  await session?.context.close().catch(() => undefined);
  await session?.browser.close().catch(() => undefined);
}

async function requireSession(run: BrowserRunRow): Promise<BrowserSession> {
  const session = sessions.get(run.id);
  if (!session || session.assistantId !== run.assistant_id || session.ownerId !== run.owner_id) {
    throw new ApiError(409, "浏览器会话已失效，请新建一次执行");
  }
  session.touchedAt = Date.now();
  return session;
}

/** 持久记录保留查询参数名，但清除可能包含搜索词、令牌或表单值的参数值。 */
export function sanitizePersistedBrowserUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...new Set(url.searchParams.keys())]) {
      url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function redactSensitiveText(value: string, sensitiveValues: Set<string>): string {
  let result = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 2) result = result.replaceAll(sensitive, "••••");
  }
  return result;
}

/** Playwright 错误可能包含完整地址；写日志、审计和数据库前统一清除查询值与表单值。 */
export function sanitizeAssistantBrowserError(
  value: string,
  sensitiveValues: Set<string> = new Set(),
): string {
  const withoutUrlSecrets = value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;\]]+$/)?.[0] ?? "";
    const urlValue = trailing ? candidate.slice(0, -trailing.length) : candidate;
    const sanitized = sanitizePersistedBrowserUrl(urlValue);
    return `${sanitized || "[browser-url]"}${trailing}`;
  });
  return redactSensitiveText(withoutUrlSecrets, sensitiveValues).slice(0, 500);
}

async function capturePageSnapshot(
  page: Page,
  sensitiveValues: Set<string>,
): Promise<PageSnapshot> {
  const title = redactSensitiveText(
    (await page.title().catch(() => "")) || "未命名页面",
    sensitiveValues,
  );
  const excerpt = redactSensitiveText(
    (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    )
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    sensitiveValues,
  ).slice(0, PAGE_EXCERPT_LIMIT);
  const elements = await page
    .locator("a, button, input, textarea, select, [role='button'], [contenteditable='true']")
    .evaluateAll((nodes, limit) => {
      document.querySelectorAll("[data-nearchat-ref]").forEach((node) => {
        node.removeAttribute("data-nearchat-ref");
      });
      const snapshots: BrowserElementSnapshot[] = [];
      for (const node of nodes) {
        if (snapshots.length >= limit) break;
        if (!(node instanceof HTMLElement)) continue;
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          box.width < 1 ||
          box.height < 1
        ) {
          continue;
        }
        const tag = node.tagName.toLowerCase();
        const type = node instanceof HTMLInputElement ? (node.type || "text").toLowerCase() : null;
        if (type === "password" || type === "file" || type === "hidden") continue;
        let kind: BrowserElementSnapshot["kind"];
        if (tag === "a") kind = "LINK";
        else if (tag === "button" || node.getAttribute("role") === "button") kind = "BUTTON";
        else if (tag === "input") kind = "INPUT";
        else if (tag === "textarea") kind = "TEXTAREA";
        else if (tag === "select") kind = "SELECT";
        else kind = "EDITABLE";
        const label = (
          node.getAttribute("aria-label") ||
          node.getAttribute("title") ||
          (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
            ? node.placeholder || node.name
            : node.innerText) ||
          `${kind.toLowerCase()} ${snapshots.length + 1}`
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
        const ref = `e${snapshots.length + 1}`;
        node.setAttribute("data-nearchat-ref", ref);
        snapshots.push({
          ref,
          kind,
          label,
          inputType: type,
          href: node instanceof HTMLAnchorElement ? node.href.slice(0, 2048) : null,
          disabled:
            ("disabled" in node && Boolean((node as HTMLButtonElement).disabled)) ||
            node.getAttribute("aria-disabled") === "true",
        });
      }
      return snapshots;
    }, PAGE_ELEMENT_LIMIT);
  return {
    url: sanitizePersistedBrowserUrl(page.url()),
    title: title.slice(0, 500),
    excerpt,
    elements: elements.map((element) => ({
      ...element,
      label: redactSensitiveText(element.label, sensitiveValues),
      href: element.href ? sanitizePersistedBrowserUrl(element.href) : null,
    })),
  };
}

function elementForAction(
  run: BrowserRunRow,
  ref: string,
  action: "CLICK" | "FILL",
): BrowserElementSnapshot {
  const element = (Array.isArray(run.page_elements) ? run.page_elements : []).find(
    (candidate) => candidate.ref === ref,
  );
  if (!element) throw new ApiError(409, "页面元素引用已失效，请先重新读取页面");
  if (element.disabled) throw new ApiError(409, "该页面元素当前不可操作");
  if (action === "FILL" && !["INPUT", "TEXTAREA", "EDITABLE"].includes(element.kind)) {
    throw new ApiError(400, "所选元素不是可填写的文本区域");
  }
  return element;
}

async function selectRun(
  client: PoolClient,
  userId: string,
  assistantId: string,
  runId: string,
  lock = false,
): Promise<BrowserRunRow> {
  const result = await client.query<BrowserRunRow>(
    `SELECT run.*
       FROM ai_assistant_browser_runs run
      WHERE run.id = $1 AND run.assistant_id = $2 AND run.owner_id = $3
      ${lock ? "FOR UPDATE" : ""}`,
    [runId, assistantId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "浏览器执行记录不存在");
  return result.rows[0];
}

const STEP_COLUMNS = `
  step.id, step.run_id, step.sequence, step.action, step.status, step.input, step.output,
  step.artifact_file_id, step.confirmed_at, step.started_at, step.completed_at,
  step.error_message, step.created_at,
  attachment.id AS artifact_attachment_id, attachment.original_name AS artifact_name,
  attachment.content_type AS artifact_content_type,
  attachment.size_bytes::text AS artifact_size_bytes`;

async function loadSteps(runIds: string[], client?: PoolClient): Promise<BrowserStepRow[]> {
  if (runIds.length === 0) return [];
  const statement = `SELECT ${STEP_COLUMNS}
     FROM ai_assistant_browser_steps step
     LEFT JOIN ai_assistant_files assistant_file ON assistant_file.id = step.artifact_file_id
     LEFT JOIN attachments attachment
       ON attachment.id = assistant_file.attachment_id AND attachment.state = 'READY'
    WHERE step.run_id = ANY($1::uuid[])
    ORDER BY step.run_id, step.sequence`;
  const result = client
    ? await client.query<BrowserStepRow>(statement, [runIds])
    : await query<BrowserStepRow>(statement, [runIds]);
  return result.rows;
}

export async function getAiAssistantBrowserPermission(userId: string, assistantId: string) {
  return publicAssistantBrowserPermission(await permissionRow(userId, assistantId), assistantId);
}

export async function updateAiAssistantBrowserPermission(
  userId: string,
  assistantId: string,
  input: BrowserPermissionInput,
) {
  const allowScreenshot = input.enabled && input.allowScreenshot;
  const allowInteraction = input.enabled && input.allowInteraction;
  const permission = await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId, true);
    const result = await client.query<BrowserPermissionRow>(
      `INSERT INTO ai_assistant_browser_permissions
         (assistant_id, owner_id, enabled, allow_screenshot, allow_interaction, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (assistant_id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             allow_screenshot = EXCLUDED.allow_screenshot,
             allow_interaction = EXCLUDED.allow_interaction,
             updated_at = NOW()
       RETURNING assistant_id, enabled, allow_screenshot, allow_interaction, updated_at`,
      [assistantId, userId, input.enabled, allowScreenshot, allowInteraction],
    );
    if (!input.enabled) {
      await client.query(
        `UPDATE ai_assistant_browser_steps step
            SET status = 'CANCELLED', completed_at = NOW(),
                error_message = '用户关闭了浏览器工具'
           FROM ai_assistant_browser_runs run
          WHERE step.run_id = run.id AND run.assistant_id = $1 AND run.owner_id = $2
            AND step.status IN ('AWAITING_CONFIRMATION', 'RUNNING')`,
        [assistantId, userId],
      );
      await client.query(
        `UPDATE ai_assistant_browser_runs
            SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(),
                error_message = '用户关闭了浏览器工具'
          WHERE assistant_id = $1 AND owner_id = $2
            AND status IN ('AWAITING_CONFIRMATION', 'ACTIVE')`,
        [assistantId, userId],
      );
    }
    await recordAudit(
      {
        actorId: userId,
        action: "AI_ASSISTANT_BROWSER_PERMISSION_UPDATE",
        targetType: "AI_ASSISTANT",
        targetId: assistantId,
        details: {
          enabled: input.enabled,
          allowScreenshot,
          allowInteraction,
        },
      },
      client,
    );
    return result.rows[0]!;
  });
  if (!input.enabled) {
    const runIds = [...sessions.entries()]
      .filter(([, session]) => session.assistantId === assistantId && session.ownerId === userId)
      .map(([runId]) => runId);
    await Promise.all(runIds.map(closeSession));
  }
  return publicAssistantBrowserPermission(permission, assistantId);
}

/** 删除助理时立即释放其无痕浏览器，不等待空闲回收周期。 */
export async function closeAiAssistantBrowserSessions(
  userId: string,
  assistantId: string,
): Promise<void> {
  const runIds = [...sessions.entries()]
    .filter(([, session]) => session.assistantId === assistantId && session.ownerId === userId)
    .map(([runId]) => runId);
  await Promise.all(runIds.map(closeSession));
}

/** 管理员全局关闭 AI 时同步终止浏览器运行，避免已打开页面继续占用资源。 */
export async function closeAllAiAssistantBrowserSessions(): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE ai_assistant_browser_steps step
          SET status = 'CANCELLED', completed_at = NOW(),
              error_message = '管理员关闭了 AI 功能'
         FROM ai_assistant_browser_runs run
        WHERE step.run_id = run.id
          AND run.status IN ('AWAITING_CONFIRMATION', 'ACTIVE')
          AND step.status IN ('AWAITING_CONFIRMATION', 'RUNNING')`,
    );
    await client.query(
      `UPDATE ai_assistant_browser_runs
          SET status = 'CANCELLED', completed_at = NOW(), updated_at = NOW(),
              error_message = '管理员关闭了 AI 功能'
        WHERE status IN ('AWAITING_CONFIRMATION', 'ACTIVE')`,
    );
  });
  await Promise.all([...sessions.keys()].map(closeSession));
}

export async function listAiAssistantBrowserRuns(userId: string, assistantId: string) {
  const assistant = await query(`SELECT 1 FROM ai_assistants WHERE id = $1 AND owner_id = $2`, [
    assistantId,
    userId,
  ]);
  if (!assistant.rowCount) throw new ApiError(404, "智能助理不存在");
  const runs = await query<BrowserRunRow>(
    `SELECT * FROM ai_assistant_browser_runs
      WHERE assistant_id = $1 AND owner_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [assistantId, userId, ASSISTANT_BROWSER_RUN_LIMIT],
  );
  const steps = await loadSteps(runs.rows.map((run) => run.id));
  const byRun = new Map<string, BrowserStepRow[]>();
  for (const step of steps) {
    const current = byRun.get(step.run_id) ?? [];
    current.push(step);
    byRun.set(step.run_id, current);
  }
  return runs.rows.map((run) => publicRun(run, byRun.get(run.id) ?? []));
}

export async function createAiAssistantBrowserRun(
  userId: string,
  assistantId: string,
  goal: string,
  rawUrl: string,
) {
  const startUrl = normalizeAssistantBrowserUrl(rawUrl);
  const runId = randomUUID();
  const stepId = randomUUID();
  await transaction(async (client) => {
    await assertAssistantOwner(client, userId, assistantId, true);
    requirePermission(await permissionRow(userId, assistantId, client), "OPEN");
    const count = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ai_assistant_browser_runs
        WHERE assistant_id = $1 AND owner_id = $2`,
      [assistantId, userId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_BROWSER_RUN_LIMIT) {
      throw new ApiError(400, `每个助理最多保留 ${ASSISTANT_BROWSER_RUN_LIMIT} 次浏览器执行`);
    }
    await client.query(
      `INSERT INTO ai_assistant_browser_runs
         (id, assistant_id, owner_id, goal, start_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, assistantId, userId, goal.trim(), startUrl],
    );
    await client.query(
      `INSERT INTO ai_assistant_browser_steps
         (id, run_id, sequence, action, input)
       VALUES ($1, $2, 1, 'OPEN', $3::jsonb)`,
      [stepId, runId, JSON.stringify({ url: startUrl })],
    );
    await recordAudit(
      {
        actorId: userId,
        action: "AI_ASSISTANT_BROWSER_RUN_CREATE",
        targetType: "AI_ASSISTANT_BROWSER_RUN",
        targetId: runId,
        details: { assistantId, startUrl: sanitizePersistedBrowserUrl(startUrl) },
      },
      client,
    );
  });
  return (await listAiAssistantBrowserRuns(userId, assistantId)).find((run) => run.id === runId)!;
}

export async function prepareAiAssistantBrowserStep(
  userId: string,
  assistantId: string,
  runId: string,
  input: BrowserStepInput,
) {
  const stepId = randomUUID();
  await transaction(async (client) => {
    const run = await selectRun(client, userId, assistantId, runId, true);
    if (run.status !== "ACTIVE") throw new ApiError(409, "当前浏览器执行不可继续");
    requirePermission(await permissionRow(userId, assistantId, client), input.action);
    const existing = await client.query(
      `SELECT 1 FROM ai_assistant_browser_steps
        WHERE run_id = $1 AND status IN ('AWAITING_CONFIRMATION', 'RUNNING')`,
      [runId],
    );
    if (existing.rowCount) throw new ApiError(409, "请先处理当前待确认步骤");
    const count = await client.query<{ total: string; next_sequence: number }>(
      `SELECT COUNT(*)::text AS total, COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM ai_assistant_browser_steps WHERE run_id = $1`,
      [runId],
    );
    if (Number(count.rows[0]?.total ?? 0) >= ASSISTANT_BROWSER_STEP_LIMIT) {
      throw new ApiError(400, `一次执行最多包含 ${ASSISTANT_BROWSER_STEP_LIMIT} 个步骤`);
    }
    let safeInput: Record<string, unknown> = {};
    if (input.action === "CLICK" || input.action === "FILL") {
      const ref = validateBrowserElementRef(input.elementRef ?? "");
      const element = elementForAction(run, ref, input.action);
      safeInput = { elementRef: ref, elementLabel: element.label, elementKind: element.kind };
    }
    await client.query(
      `INSERT INTO ai_assistant_browser_steps
         (id, run_id, sequence, action, input)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [stepId, runId, count.rows[0]!.next_sequence, input.action, JSON.stringify(safeInput)],
    );
    await client.query(
      `UPDATE ai_assistant_browser_runs
          SET status = 'AWAITING_CONFIRMATION', updated_at = NOW(), error_message = NULL
        WHERE id = $1`,
      [runId],
    );
  });
  const runs = await listAiAssistantBrowserRuns(userId, assistantId);
  return runs.find((run) => run.id === runId)!;
}

async function executeBrowserStep(
  run: BrowserRunRow,
  step: BrowserStepRow,
  userId: string,
  fillValue?: string,
): Promise<{
  snapshot: PageSnapshot;
  output: Record<string, unknown>;
  artifactFileId: string | null;
}> {
  let session: BrowserSession;
  if (step.action === "OPEN") {
    session = await createSession(run);
    await session.page.goto(run.start_url, { waitUntil: "domcontentloaded" });
  } else {
    session = await requireSession(run);
  }
  session.touchedAt = Date.now();
  let artifactFileId: string | null = null;
  let output: Record<string, unknown> = {};

  if (step.action === "CLICK" || step.action === "FILL") {
    const ref = validateBrowserElementRef(String(step.input.elementRef ?? ""));
    elementForAction(run, ref, step.action);
    const locator = session.page.locator(`[data-nearchat-ref="${ref}"]`).first();
    if ((await locator.count()) === 0) {
      throw new ApiError(409, "页面已经变化，请先重新读取后再操作");
    }
    if (step.action === "CLICK") {
      await locator.evaluate((node) => node.removeAttribute("target")).catch(() => undefined);
      await locator.click();
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      output = { clicked: step.input.elementLabel };
    } else {
      if (fillValue === undefined) throw new ApiError(400, "请在确认时输入要填写的文字");
      if (fillValue.length > 2000) throw new ApiError(400, "单次填写不能超过 2000 个字");
      const type = ((await locator.getAttribute("type")) ?? "text").toLowerCase();
      if (["password", "file", "hidden"].includes(type)) {
        throw new ApiError(403, "浏览器工具不支持密码或文件字段");
      }
      await locator.fill(fillValue);
      if (fillValue) session.sensitiveValues.add(fillValue);
      output = { filled: step.input.elementLabel, valueLength: fillValue.length };
    }
  } else if (step.action === "SCREENSHOT") {
    const image = await session.page.screenshot({ fullPage: true, type: "png" });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = await saveAssistantGeneratedBuffer({
      userId,
      assistantId: run.assistant_id,
      body: image,
      originalName: `浏览器截图-${timestamp}.png`,
      contentType: "image/png",
    });
    artifactFileId = file.id;
    output = { screenshot: file.attachment.originalName, sizeBytes: file.attachment.sizeBytes };
  }

  const snapshot = await capturePageSnapshot(session.page, session.sensitiveValues);
  return {
    snapshot,
    output: {
      ...output,
      page: {
        url: snapshot.url,
        title: snapshot.title,
        excerpt: snapshot.excerpt.slice(0, 4000),
        elementCount: snapshot.elements.length,
      },
    },
    artifactFileId,
  };
}

export async function confirmAiAssistantBrowserStep(
  userId: string,
  assistantId: string,
  runId: string,
  stepId: string,
  fillValue?: string,
) {
  const claimed = await transaction(async (client) => {
    const run = await selectRun(client, userId, assistantId, runId, true);
    const stepResult = await client.query<BrowserStepRow>(
      `SELECT ${STEP_COLUMNS}
         FROM ai_assistant_browser_steps step
         LEFT JOIN ai_assistant_files assistant_file ON assistant_file.id = step.artifact_file_id
         LEFT JOIN attachments attachment ON attachment.id = assistant_file.attachment_id
        WHERE step.id = $1 AND step.run_id = $2
        FOR UPDATE OF step`,
      [stepId, runId],
    );
    const step = stepResult.rows[0];
    if (!step) throw new ApiError(404, "待确认步骤不存在");
    if (step.status !== "AWAITING_CONFIRMATION") throw new ApiError(409, "该步骤已经处理");
    requirePermission(await permissionRow(userId, assistantId, client), step.action);
    if (step.action === "OPEN" && run.opened_at) throw new ApiError(409, "页面已经打开");
    if (step.action !== "OPEN" && !run.opened_at) throw new ApiError(409, "请先确认打开页面");
    const sanitizedInput =
      step.action === "FILL" ? { ...step.input, valueLength: fillValue?.length ?? 0 } : step.input;
    await client.query(
      `UPDATE ai_assistant_browser_steps
          SET status = 'RUNNING', input = $2::jsonb, confirmed_by = $3,
              confirmed_at = NOW(), started_at = NOW(), error_message = NULL
        WHERE id = $1`,
      [stepId, JSON.stringify(sanitizedInput), userId],
    );
    await client.query(
      `UPDATE ai_assistant_browser_runs
          SET status = 'ACTIVE', updated_at = NOW(), error_message = NULL
        WHERE id = $1`,
      [runId],
    );
    return { run, step: { ...step, input: sanitizedInput } };
  });

  try {
    const result = await executeBrowserStep(claimed.run, claimed.step, userId, fillValue);
    await transaction(async (client) => {
      // 浏览器执行发生在数据库事务之外。回写前必须重新锁定并核对运行状态，
      // 避免用户在操作过程中取消/禁用工具后，迟到的结果又把运行恢复为 ACTIVE。
      const currentRun = await selectRun(client, userId, assistantId, runId, true);
      if (currentRun.status !== "ACTIVE") {
        throw new ApiError(409, "浏览器执行已结束或取消");
      }
      const stepUpdate = await client.query(
        `UPDATE ai_assistant_browser_steps
            SET status = 'SUCCEEDED', output = $2::jsonb, artifact_file_id = $3,
                completed_at = NOW(), error_message = NULL
          WHERE id = $1 AND status = 'RUNNING'
          RETURNING id`,
        [stepId, JSON.stringify(result.output), result.artifactFileId],
      );
      if (stepUpdate.rowCount !== 1) {
        throw new ApiError(409, "浏览器步骤已结束或取消");
      }
      await client.query(
        `UPDATE ai_assistant_browser_runs
            SET status = 'ACTIVE', start_url = $6, current_url = $2, page_title = $3,
                page_excerpt = $4, page_elements = $5::jsonb,
                opened_at = COALESCE(opened_at, NOW()), updated_at = NOW(), error_message = NULL
          WHERE id = $1 AND status = 'ACTIVE'`,
        [
          runId,
          result.snapshot.url,
          result.snapshot.title,
          result.snapshot.excerpt,
          JSON.stringify(result.snapshot.elements),
          sanitizePersistedBrowserUrl(claimed.run.start_url),
        ],
      );
      await recordAudit(
        {
          actorId: userId,
          action: "AI_ASSISTANT_BROWSER_STEP_CONFIRM",
          targetType: "AI_ASSISTANT_BROWSER_STEP",
          targetId: stepId,
          details: { runId, action: claimed.step.action, succeeded: true },
        },
        client,
      );
    });
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : "浏览器操作失败";
    const sensitiveValues = new Set(sessions.get(runId)?.sensitiveValues ?? []);
    if (fillValue) sensitiveValues.add(fillValue);
    const message = sanitizeAssistantBrowserError(originalMessage, sensitiveValues);
    const sessionMissing =
      error instanceof ApiError && error.status === 409 && originalMessage.includes("会话已失效");
    const terminal = claimed.step.action === "OPEN" || sessionMissing;
    await transaction(async (client) => {
      await client.query(
        `UPDATE ai_assistant_browser_steps
            SET status = 'FAILED', completed_at = NOW(), error_message = $2
          WHERE id = $1 AND status = 'RUNNING'`,
        [stepId, message],
      );
      if (claimed.step.action === "OPEN") {
        await client.query(`UPDATE ai_assistant_browser_runs SET start_url = $2 WHERE id = $1`, [
          runId,
          sanitizePersistedBrowserUrl(claimed.run.start_url),
        ]);
      }
      await client.query(
        `UPDATE ai_assistant_browser_runs
            SET status = $2::varchar,
                completed_at = CASE WHEN $2::varchar IN ('FAILED', 'EXPIRED') THEN NOW() ELSE NULL END,
                updated_at = NOW(), error_message = $3
          WHERE id = $1 AND status IN ('AWAITING_CONFIRMATION', 'ACTIVE')`,
        [runId, terminal ? (sessionMissing ? "EXPIRED" : "FAILED") : "ACTIVE", message],
      );
      await recordAudit(
        {
          actorId: userId,
          action: "AI_ASSISTANT_BROWSER_STEP_CONFIRM",
          targetType: "AI_ASSISTANT_BROWSER_STEP",
          targetId: stepId,
          details: { runId, action: claimed.step.action, succeeded: false, error: message },
        },
        client,
      );
    });
    if (terminal) await closeSession(runId);
    // 不把 Playwright 附带的原始 URL、请求日志等可枚举字段交给全局错误日志。
    throw error instanceof ApiError ? new ApiError(error.status, message) : new Error(message);
  }

  const runs = await listAiAssistantBrowserRuns(userId, assistantId);
  return runs.find((run) => run.id === runId)!;
}

export async function finishAiAssistantBrowserRun(
  userId: string,
  assistantId: string,
  runId: string,
  outcome: "SUCCEEDED" | "CANCELLED",
) {
  await transaction(async (client) => {
    const run = await selectRun(client, userId, assistantId, runId, true);
    if (["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(run.status)) {
      throw new ApiError(409, "该浏览器执行已经结束");
    }
    await client.query(
      `UPDATE ai_assistant_browser_steps
          SET status = 'CANCELLED', completed_at = NOW(), error_message = '运行已结束'
        WHERE run_id = $1 AND status IN ('AWAITING_CONFIRMATION', 'RUNNING')`,
      [runId],
    );
    await client.query(
      `UPDATE ai_assistant_browser_runs
          SET status = $2, completed_at = NOW(), updated_at = NOW(), error_message = NULL
        WHERE id = $1`,
      [runId, outcome],
    );
    await recordAudit(
      {
        actorId: userId,
        action: "AI_ASSISTANT_BROWSER_RUN_FINISH",
        targetType: "AI_ASSISTANT_BROWSER_RUN",
        targetId: runId,
        details: { outcome },
      },
      client,
    );
  });
  await closeSession(runId);
  const runs = await listAiAssistantBrowserRuns(userId, assistantId);
  return runs.find((run) => run.id === runId)!;
}

export async function deleteAiAssistantBrowserRun(
  userId: string,
  assistantId: string,
  runId: string,
): Promise<void> {
  await transaction(async (client) => {
    const run = await selectRun(client, userId, assistantId, runId, true);
    if (["AWAITING_CONFIRMATION", "ACTIVE"].includes(run.status)) {
      throw new ApiError(409, "请先结束浏览器执行再删除记录");
    }
    await client.query(`DELETE FROM ai_assistant_browser_runs WHERE id = $1`, [runId]);
  });
  await closeSession(runId);
}

async function expireBrowserSession(runId: string): Promise<void> {
  await query(
    `UPDATE ai_assistant_browser_steps
        SET status = 'CANCELLED', completed_at = NOW(), error_message = '浏览器会话空闲超时'
      WHERE run_id = $1 AND status IN ('AWAITING_CONFIRMATION', 'RUNNING')`,
    [runId],
  );
  await query(
    `UPDATE ai_assistant_browser_runs
        SET status = 'EXPIRED', completed_at = NOW(), updated_at = NOW(),
            error_message = '浏览器会话空闲超时'
      WHERE id = $1 AND status IN ('AWAITING_CONFIRMATION', 'ACTIVE')`,
    [runId],
  );
  await closeSession(runId);
}

/** 清理长时间无操作的隔离浏览器，防止后台 Chromium 常驻占用内存。 */
export function startAssistantBrowserSessionCleanup(): () => void {
  const sweep = () => {
    const deadline = Date.now() - config.ai.browser.sessionTtlMinutes * 60_000;
    for (const [runId, session] of sessions) {
      if (session.touchedAt < deadline) void expireBrowserSession(runId);
    }
  };
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const runId of [...sessions.keys()]) void closeSession(runId);
  };
}
