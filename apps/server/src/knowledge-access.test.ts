import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeRoleAllows } from "./knowledge/knowledge-service.js";

test("knowledge access roles preserve owner, editor and viewer boundaries", () => {
  assert.equal(knowledgeRoleAllows("OWNER", "OWNER"), true);
  assert.equal(knowledgeRoleAllows("OWNER", "EDITOR"), true);
  assert.equal(knowledgeRoleAllows("EDITOR", "EDITOR"), true);
  assert.equal(knowledgeRoleAllows("EDITOR", "VIEWER"), true);
  assert.equal(knowledgeRoleAllows("EDITOR", "OWNER"), false);
  assert.equal(knowledgeRoleAllows("VIEWER", "VIEWER"), true);
  assert.equal(knowledgeRoleAllows("VIEWER", "EDITOR"), false);
  assert.equal(knowledgeRoleAllows("VIEWER", "OWNER"), false);
});
