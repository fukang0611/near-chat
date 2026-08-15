import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryCaptureTranscript,
  parseGeneratedMemoryCandidates,
  redactMemoryCaptureText,
  type MemoryCaptureMessage,
} from "./memory-capture-service.js";

test("解析模型候选时允许代码围栏但严格校验字段", () => {
  const candidates = parseGeneratedMemoryCandidates(`结果如下：\n\`\`\`json\n[
    {"kind":"DECISION","title":"发布时间","content":"团队决定周五下午发布。","importance":4}
  ]\n\`\`\``);
  assert.deepEqual(candidates, [
    {
      kind: "DECISION",
      title: "发布时间",
      content: "团队决定周五下午发布。",
      importance: 4,
    },
  ]);
  assert.throws(
    () => parseGeneratedMemoryCandidates('[{"kind":"UNKNOWN","title":"x"}]'),
    /字段不完整/,
  );
});

test("会话批次保留发送者、附件名并跳过已撤回消息", () => {
  const base: MemoryCaptureMessage = {
    id: "message-1",
    conversation_id: "conversation-1",
    text_content: "周五发布",
    recalled_at: null,
    created_at: new Date("2026-08-15T08:00:00.000Z"),
    sender_name: "林小满",
    conversation_title: "项目群",
    attachment_names: ["验收清单.pdf"],
  };
  const transcript = buildMemoryCaptureTranscript([
    base,
    { ...base, id: "message-2", text_content: "已撤回", recalled_at: new Date() },
  ]);
  assert.match(transcript, /林小满：周五发布/);
  assert.match(transcript, /附件：验收清单\.pdf/);
  assert.doesNotMatch(transcript, /已撤回/);
});

test("发送给模型前遮盖常见凭据但不修改普通内容", () => {
  assert.equal(
    redactMemoryCaptureText("发布地址不变，api-key: example-sensitive-value"),
    "发布地址不变，api-key: [已隐藏]",
  );
  assert.equal(redactMemoryCaptureText("周五下午发布"), "周五下午发布");
});
