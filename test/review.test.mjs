import test from "node:test";
import assert from "node:assert/strict";
import { interpretResult, pinReviewChild, startReviewChild, toolCallPath, watchChildTools } from "../lib/review.js";
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
  assert.match(interpretResult({ wrote: true, aborted: true }).reason, /改文件工具/);
  assert.match(interpretResult({ timedOut: true }).reason, /超时/);
  assert.match(interpretResult({ structured: null, stopReason: "completed" }).reason, /结构化结果/);
});

test("observed read paths can satisfy pathsRead when the model omits them", () => {
  const result = interpretResult({
    structured: { passed: true, issues: [], suggestions: [], pathsRead: [] },
    stopReason: "completed",
    observedPaths: ["lib/index.js"],
    observedLsp: ["findReferences"],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.pathsRead, ["lib/index.js"]);
});

test("reads without lsp call-chain queries cannot pass", () => {
  const result = interpretResult({
    structured: { passed: true, issues: [], suggestions: [], pathsRead: ["lib/index.js"] },
    stopReason: "completed",
    observedPaths: ["lib/index.js"],
    observedLsp: ["hover"],
  });
  assert.equal(result.passed, false);
  assert.match(result.issues[0].summary, /lsp 核对调用链/);
});

test("toolCallPath reads official argument field names", () => {
  assert.equal(toolCallPath({ arguments: { file_path: "lib/a.js" } }), "lib/a.js");
  assert.equal(toolCallPath({ arguments: "{\"file_path\":\"lib/b.js\"}" }), "lib/b.js");
  assert.equal(toolCallPath({ args: { path: "/tmp/ws" } }), "/tmp/ws");
  assert.equal(toolCallPath({ name: "read" }), null);
});

test("pinReviewChild appends read-only sandbox and restricts write tools", () => {
  const denied = [];
  const events = [];
  const child = {
    session: { append(type, data) { events.push({ type, data }); } },
    ctx: {
      tools: {
        view() { return { restrictableNames: new Set(["edit", "write", "bash"]) }; },
        restrict(filter) { denied.push(filter.deny); },
      },
    },
  };
  const pin = pinReviewChild(child);
  assert.equal(pin.sandbox, true);
  assert.equal(pin.restricted, true);
  assert.equal(events[0].type, "sandbox/mode");
  assert.equal(events[0].data.mode, "read-only");
  assert.deepEqual(denied[0], ["edit", "write", "bash"]);
});

test("watchChildTools records reads and write-tool names including bash", () => {
  let wrote = null;
  const reads = [];
  const listeners = [];
  const session = {};
  const child = {
    session,
    ctx: { on(_name, fn) { listeners.push(fn); return () => {}; } },
  };
  const lsp = [];
  watchChildTools(child, {
    onWrite(name) { wrote = name; },
    onRead(path) { reads.push(path); },
    onLsp(op) { lsp.push(op); },
  });
  listeners[0](session, { type: "tool/call", data: { name: "read", arguments: { file_path: "a.js" } } });
  listeners[0](session, { type: "tool/call", data: { name: "bash", arguments: { command: "rm -rf x" } } });
  listeners[0](session, { type: "tool/call", data: { name: "lsp", arguments: "{\"operation\":\"findReferences\",\"file_path\":\"a.js\"}" } });
  listeners[0](session, { type: "tool/call", data: { name: "lsp", arguments: { operation: "hover" } } });
  assert.deepEqual(reads, ["a.js"]);
  assert.equal(wrote, "bash");
  assert.deepEqual(lsp, ["findReferences"]);
});

test("spawn is preferred so the reviewer route is not overwritten by a forked parent header", async () => {
  const seen = [];
  const subagents = {
    getProvider(name) { return { name }; },
    async startActivation(spec) {
      seen.push(spec.provider);
      if (spec.provider === "spawn") {
        assert.equal(spec.delivery, "caller");
        assert.deepEqual(spec.request.agentOptions, { provider: reviewer.provider, model: reviewer.model });
        assert.ok(spec.request.outputSchema);
        assert.ok(spec.request.prompt[0].text.includes("BEGIN CONTRACT"));
        return { childId: "child", result: Promise.resolve({}), dispose() {} };
      }
      throw new Error("fork should not start when spawn works");
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
  assert.deepEqual(seen, ["spawn"]);
  assert.equal(started.provider, "spawn");
});

test("fork is used only after spawn fails", async () => {
  const seen = [];
  const subagents = {
    getProvider(name) { return { name }; },
    async startActivation(spec) {
      seen.push(spec.provider);
      if (spec.provider === "spawn") throw new Error("spawn unavailable");
      assert.equal(spec.provider, "fork");
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
  assert.deepEqual(seen, ["spawn", "fork"]);
  assert.equal(started.provider, "fork");
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
  assert.equal(spawn.includes("不继承父对话历史"), true);
  assert.equal(spawn.includes("/ws"), true);
  assert.equal(fork.includes("禁止调用 edit"), true);
  assert.equal(fork.includes("read-only"), true);
  assert.equal(fork.includes("bash"), true);
  assert.equal(fork.includes("findReferences"), true);
  assert.equal(spawn.includes("findReferences"), true);
});
