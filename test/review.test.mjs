import test from "node:test";
import assert from "node:assert/strict";
import { interpretResult, startReviewChild } from "../lib/review.js";
import { buildReviewPrompt } from "../lib/prompt.js";

const reviewer = { provider: "openai-codex", model: "gpt-6-astra" };

test("empty pathsRead cannot pass", () => {
  const result = interpretResult({
    structured: { passed: true, issues: [], suggestions: [], pathsRead: [] },
    stopReason: "completed",
  });
  assert.equal(result.passed, false);
  assert.match(result.issues[0].summary, /未实际阅读/);
});

test("write-tool and timeout failures stay visible and do not fall back to a tool-less pass", () => {
  assert.match(interpretResult({ wrote: true }).reason, /改文件工具/);
  assert.match(interpretResult({ timedOut: true }).reason, /超时/);
  assert.match(interpretResult({ structured: null, stopReason: "completed" }).reason, /结构化结果/);
});

test("fork is preferred and spawn is used only after fork fails", async () => {
  const seen = [];
  const subagents = {
    getProvider(name) { return { name }; },
    async startActivation(spec) {
      seen.push(spec.provider);
      if (spec.provider === "fork") throw new Error("depth full");
      assert.equal(spec.delivery, "caller");
      assert.deepEqual(spec.request.agentOptions, { provider: reviewer.provider, model: reviewer.model });
      assert.ok(spec.request.outputSchema);
      assert.ok(spec.request.prompt[0].text.includes("BEGIN CONTRACT"));
      return { childId: "child", result: Promise.resolve({}), dispose() {} };
    },
  };
  const started = await startReviewChild({
    subagents,
    parent: { id: "parent" },
    cwd: "/tmp/ws",
    contract: "契约正文",
    reviewer,
    draft: { lastUserText: "用户原话", tools: [{ name: "read" }] },
    signal: new AbortController().signal,
  });
  assert.deepEqual(seen, ["fork", "spawn"]);
  assert.equal(started.provider, "spawn");
});

test("selected reasoning effort is passed through agentOptions", async () => {
  let options;
  const subagents = {
    getProvider: () => ({ name: "fork" }),
    async startActivation(spec) {
      options = spec.request.agentOptions;
      return { childId: "child", result: Promise.resolve({}), dispose() {} };
    },
  };
  await startReviewChild({
    subagents,
    parent: { id: "parent" },
    cwd: "/tmp/ws",
    contract: "契约",
    reviewer: { provider: "xai", model: "grok-4.6", reasoningEffort: "high" },
    draft: { lastUserText: "", tools: [] },
    signal: new AbortController().signal,
  });
  assert.deepEqual(options, { provider: "xai", model: "grok-4.6", reasoningEffort: "high" });
});

test("spawn prompt includes workspace, original user text and tool summary; fork still has the full contract", () => {
  const fork = buildReviewPrompt({
    contract: "FULL_CONTRACT",
    provider: "fork",
    cwd: "/ws",
    userText: "原话",
    tools: "read",
    reviewer,
  });
  const spawn = buildReviewPrompt({
    contract: "FULL_CONTRACT",
    provider: "spawn",
    cwd: "/ws",
    userText: "原话",
    tools: "read",
    reviewer,
  });
  assert.equal(fork.includes("FULL_CONTRACT"), true);
  assert.equal(fork.includes("用户原话"), false);
  assert.equal(spawn.includes("FULL_CONTRACT"), true);
  assert.equal(spawn.includes("用户原话"), true);
  assert.equal(spawn.includes("/ws"), true);
  assert.equal(fork.includes("禁止调用 edit"), true);
});
