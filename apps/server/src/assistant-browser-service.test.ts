import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAssistantBrowserUrl,
  publicAssistantBrowserPermission,
  sanitizeAssistantBrowserError,
  sanitizePersistedBrowserUrl,
  validateBrowserElementRef,
} from "./assistant/assistant-browser-service.js";

test("新助理没有授权行时返回安全的默认关闭状态", () => {
  const permission = publicAssistantBrowserPermission(
    {
      assistant_id: null,
      enabled: null,
      allow_screenshot: null,
      allow_interaction: null,
      updated_at: null,
    },
    "assistant-one",
  );

  assert.deepEqual(permission, {
    assistantId: "assistant-one",
    enabled: false,
    allowRead: true,
    allowScreenshot: false,
    allowInteraction: false,
    updatedAt: null,
  });
});

test("受控浏览器允许显式的公网与局域网 HTTP(S) 地址", () => {
  assert.equal(
    normalizeAssistantBrowserUrl("https://example.com/docs?q=near-chat"),
    "https://example.com/docs?q=near-chat",
  );
  assert.equal(
    normalizeAssistantBrowserUrl("http://192.168.10.8:8080/notice"),
    "http://192.168.10.8:8080/notice",
  );
});

test("受控浏览器拒绝脚本协议、地址内凭据和云元数据端点", () => {
  assert.throws(() => normalizeAssistantBrowserUrl("javascript:alert(1)"), /HTTP/);
  assert.throws(
    () => normalizeAssistantBrowserUrl("https://admin:secret@example.com"),
    /账号或密码/,
  );
  assert.throws(
    () => normalizeAssistantBrowserUrl("http://169.254.169.254/latest/meta-data"),
    /保留地址/,
  );
  assert.throws(
    () => normalizeAssistantBrowserUrl("http://169.254.170.2/v2/credentials"),
    /保留地址/,
  );
  assert.throws(
    () => normalizeAssistantBrowserUrl("http://100.100.100.200/latest/meta-data"),
    /保留地址/,
  );
});

test("浏览器错误在持久化和日志记录前清除地址参数与填写内容", () => {
  const message = sanitizeAssistantBrowserError(
    "page.goto failed at https://example.com/search?q=北辰&token=secret: 北辰计划不可用",
    new Set(["北辰计划"]),
  );
  assert.equal(message.includes("secret"), false);
  assert.equal(message.includes("北辰计划"), false);
  assert.match(message, /token=%5Bredacted%5D/);
  assert.match(message, /••••不可用/);
});

test("页面操作只接受服务端生成的有限元素引用", () => {
  assert.equal(validateBrowserElementRef("e1"), "e1");
  assert.equal(validateBrowserElementRef("e40"), "e40");
  assert.throws(() => validateBrowserElementRef("e0"), /引用已失效/);
  assert.throws(() => validateBrowserElementRef("e41"), /引用已失效/);
  assert.throws(() => validateBrowserElementRef('e1"] button'), /引用已失效/);
});

test("持久化页面地址保留参数名但清除查询值和片段", () => {
  assert.equal(
    sanitizePersistedBrowserUrl(
      "https://example.com/search?q=%E5%8C%97%E8%BE%B0&token=secret#result",
    ),
    "https://example.com/search?q=%5Bredacted%5D&token=%5Bredacted%5D",
  );
});
