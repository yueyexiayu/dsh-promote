import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_RULES, buildReviewPrompt } from "../lib/prompt.js";

test("review rules distinguish code evidence from non-source material", () => {
  const rules = [...REVIEW_RULES.criteria, ...REVIEW_RULES.constraints].join("\n");
  assert.match(rules, /代码类.*源码/);
  assert.match(rules, /代码类.*lsp/);
  assert.match(rules, /非源码.*实际材料/);
  assert.match(rules, /成功工具结果/);
  const prompt = buildReviewPrompt({ contract: "契约", provider: "spawn", reviewer: { provider: "p", model: "m" } });
  assert.match(prompt, /激活前确认只读限制/);
  assert.match(prompt, /模型自报本身不能作为读取证据/);
});
