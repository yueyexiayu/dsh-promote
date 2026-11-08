import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apply, createSettingsQueue, inject } from "../lib/index.js";
import { MARKER, TIMEOUT_MS, TOOL_TIMEOUT_MS } from "../lib/constants.js";
import { contractHash } from "../lib/extract.js";
import { createDraftState, reduceDraftState } from "../lib/projection.js";

function draftWith(text) {
  return {
    turn: 1,
    visibleText: text,
    hasTrigger: text.includes(MARKER) && !text.trim().startsWith(">"),
    hash: contractHash(text),
    interrupted: false,
    tools: [],
    lastUserText: "用户原话",
  };
}

async function waitUntil(predicate, ms = 500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for host test condition");
}

async function host(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "promote-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const listeners = new Map();
  const tools = [];
  let fetchHandler;
  const delivered = [];
  const activations = [];
  const drafts = new Map();
  const agents = new Map();
  const settingsNs = [];
  const resolvedConfigs = [];
  const ctx = {
    inject,
    effect(callback) { settingsNs.push(callback()); },
    on(name, fn) { listeners.set(name, fn); },
    loader: { import: async () => ({ createUserMessage: (value) => ({ role: "user", ...value }) }) },
    connection: { fetch: { register(value) { fetchHandler = value; } } },
    tools: { register(def) { tools.push(def); } },
    agents: { get(id) { return agents.get(id); } },
    subagents: {
      getProvider(name) { return options.providers?.[name] ?? { name }; },
      async startActivation(spec) {
        activations.push(spec);
        if (options.startActivation) return options.startActivation(spec);
        return {
          childId: "child-" + activations.length,
          result: options.result ?? Promise.resolve({
            stopReason: "completed",
            structured: { passed: true, issues: [], suggestions: [], pathsRead: ["lib/index.js"] },
          }),
          dispose() {},
        };
      },
    },
    sessionProjections: {
      register() {
        const dispose = () => {};
        dispose.then = (onFulfilled) => {
          onFulfilled({ stateOf: (session) => drafts.get(session.id) ?? createDraftState() });
          return Promise.resolve();
        };
        return dispose;
      },
      snapshot(session) {
        return { values: { modelSelection: { next: options.main ?? { provider: "xai", model: "grok-4.6" } } } };
      },
    },
    get(name) {
      if (name === "llm") {
        return {
          listProviders: () => [{ id: "xai", name: "xai" }, { id: "openai-codex", name: "codex" }],
          listModels: async (id) => id === "xai"
            ? [{ id: "grok-4.6", name: "Grok 4.6", reasoning: { defaultEffort: "high", efforts: [{ id: "low", name: "low" }, { id: "high", name: "high" }, { id: "xhigh", name: "xhigh" }] } }, { id: "grok-4.5", name: "Grok 4.5" }]
            : [{ id: "gpt-6-astra", name: "Astra", reasoning: { efforts: [{ id: "medium" }, { id: "high" }] } }],
          resolveCallConfig: async (config, signal) => {
            resolvedConfigs.push(config);
            return options.resolveCallConfig?.(config, signal);
          },
        };
      }
    },
  };
  if (options.invalidSettings) await writeFile(join(home, "settings.json"), options.invalidSettings);
  await apply(ctx, { settingsPath: join(home, "settings.json") });
  function addAgent(id = "session-a") {
    const session = {
      id,
      header: { cwd: "/tmp/ws", origin: "user", delegationDepth: 0 },
      append(_type, message) { delivered.push({ wake: false, message }); return { seq: delivered.length }; },
    };
    const agent = {
      session,
      steer(message) { delivered.push({ wake: true, message }); },
    };
    agents.set(id, agent);
    return agent;
  }
  async function call(method, sessionId, body, view) {
    const params = [];
    if (sessionId) params.push("sessionId=" + encodeURIComponent(sessionId));
    if (view) params.push("view=" + encodeURIComponent(view));
    const url = "http://local/api/promote" + (params.length ? "?" + params.join("&") : "");
    const request = new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await fetchHandler.fetch(request)).json();
  }
  return { ctx, listeners, tools, activations, delivered, drafts, addAgent, call, home, resolvedConfigs, dispose: () => settingsNs.forEach((fn) => fn?.()) };
}

test("Host inject matches the services apply reads directly", () => {
  assert.deepEqual(inject, ["connection", "tools", "loader", "agents", "subagents", "sessionProjections"]);
});

test("API refuses A=B and unassociated GET does not impersonate a default main model", async (t) => {
  const h = await host(t);
  const rejected = await h.call("POST", "", {
    modelA: "xai/grok-4.5",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  assert.equal(rejected.ok, false);
  const open = await h.call("GET", "");
  assert.equal(open.ok, true);
  assert.equal(open.session.unassociated, true);
  assert.equal(open.session.mainModel, null);
  assert.ok(Array.isArray(open.rules.criteria) && open.rules.criteria.some((item) => item.includes("现场对得上")));
  assert.ok(Array.isArray(open.rules.constraints) && open.rules.constraints.some((item) => item.includes("只读")));
  assert.ok(open.rules.criteria.some((item) => item.includes("lsp")));
  assert.ok(open.rules.constraints.some((item) => item.includes("lsp")));
  assert.equal(open.version, "0.1.17");
  assert.equal(open.session.reviewing, false);
  const sessionOnly = await h.call("GET", "session-a", undefined, "session");
  assert.equal(sessionOnly.ok, true);
  assert.equal(sessionOnly.version, "0.1.17");
  assert.equal(sessionOnly.settings, undefined);
  assert.equal(sessionOnly.routes, undefined);
  assert.equal(sessionOnly.session.unassociated, false);
});

test("skill-style fenced contract from the real projection auto-starts review", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  const text = [
    "**档位：standard 执行契约。**",
    "",
    "```text",
    "结果：监测工作台加查看详情",
    "任务根：/tmp/ws",
    MARKER,
    "```",
  ].join("\n");
  const draft = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, interrupted: false, message: { content: [{ type: "text", text }] } } },
  ].reduce(reduceDraftState, createDraftState());
  assert.equal(draft.hasTrigger, true);
  h.drafts.set("session-a", draft);
  await h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  assert.equal(h.activations.length, 0);
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);
  assert.match(h.delivered.at(-1).message.content[0].text, /只读/);
});

test("unquoted marker starts one review; quotes do not; same hash does not double-start", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  const text = `契约\n${MARKER}`;
  h.drafts.set("session-a", draftWith(text));
  await Promise.all([
    h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } }),
    h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } }),
  ]);
  assert.equal(h.resolvedConfigs.length, 1);
  assert.equal(h.activations.length, 0);
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);

  const quoted = h.addAgent("session-b");
  h.drafts.set("session-b", draftWith(`> ${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent: quoted, turn: 1, signal: { aborted: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.activations.length, 0);
});

test("a newer contract discards the stale review result", async (t) => {
  let resolveOld;
  let calls = 0;
  const oldResult = new Promise((resolve) => { resolveOld = resolve; });
  const h = await host(t, { resolveCallConfig: () => ++calls === 1 ? oldResult : undefined });
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`旧稿\n${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => calls === 1);
  h.drafts.set("session-a", draftWith(`新稿\n${MARKER}`));
  await h.listeners.get("agent/turn-stopping")({ agent, turn: 2, signal: { aborted: false } });
  resolveOld();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(h.activations.length, 0);
  const texts = h.delivered.map((row) => row.message.content[0].text);
  assert.equal(texts.some((text) => text.startsWith("[promote 终稿]")), false);
  assert.equal(texts.filter((text) => text.includes("审核失败")).length, 1);
});

test("plugin-injected status never registers as a reviewable assistant draft", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", createDraftState(1));
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  assert.equal(h.activations.length, 0);
});

test("collision with the current session model is visible and does not self-review", async (t) => {
  const h = await host(t, { main: { provider: "xai", model: "grok-4.6" } });
  await h.call("POST", "session-a", {
    modelA: "xai/grok-4.6",
    modelB: "xai/grok-4.6",
    autoReview: true,
  });
  const saved = await h.call("GET", "session-a");
  assert.equal(saved.settings.modelA, null);
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.delivered.length > 0);
  assert.equal(h.activations.length, 0);
  assert.match(h.delivered[0].message.content[0].text, /审核失败|未配置/);
});

test("A matching the current session model uses B and never the main model", async (t) => {
  const h = await host(t, { main: { provider: "xai", model: "grok-4.6" } });
  await h.call("POST", "session-a", {
    modelA: "xai/grok-4.6",
    modelB: "openai-codex/gpt-6-astra",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  await h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  assert.deepEqual(h.resolvedConfigs.at(-1), { provider: "openai-codex", model: "gpt-6-astra" });
  assert.equal(h.activations.length, 0);
});

test("saved reasoning effort is resolved before fail-closed review", async (t) => {
  const h = await host(t, { main: { provider: "xai", model: "grok-4.6" } });
  const listed = await h.call("GET", "session-a");
  assert.ok(listed.routes.some((route) => route.model === "grok-4.6" && route.efforts.some((item) => item.id === "high")));
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    effortA: "high",
    modelB: "xai/grok-4.5",
    effortB: "low",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  await h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  assert.equal(h.activations.length, 0);
  assert.deepEqual(h.resolvedConfigs.at(-1), {
    provider: "openai-codex",
    model: "gpt-6-astra",
    reasoningEffort: "high",
  });
});

test("explicit promote tool is registered as a fallback", async (t) => {
  const h = await host(t);
  assert.equal(h.tools.some((tool) => tool.name === "promote"), true);
});

test("promote tool reports unavailable read-only review", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  assert.ok(TIMEOUT_MS >= 1_200_000);
  assert.ok(TOOL_TIMEOUT_MS > TIMEOUT_MS);
  assert.equal(tool.timeoutMs, TOOL_TIMEOUT_MS);
  const result = await tool.execute({}, { agent });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "READ_ONLY_UNAVAILABLE");
  assert.equal(result.retryable, false);
  // Host requires lossless JSON, not merely a value that JSON.stringify can omit fields from.
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  assert.equal(Object.hasOwn(result, "issues"), false);
  assert.equal(h.delivered.at(-1).wake, false);
  assert.equal(h.delivered.at(-1).message.source.promoteRetryable, false);
  assert.equal(h.activations.length, 0);
});

test("uncoded credential failures return a lossless JSON result without an undefined code", async (t) => {
  const h = await host(t, { resolveCallConfig: () => { throw new Error("temporary failure"); } });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const result = await h.tools.find((item) => item.name === "promote").execute({}, { agent });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "temporary failure");
  assert.equal(Object.hasOwn(result, "code"), false);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
});

test("turn cancellation ends a pending credential check", async (t) => {
  let calls = 0;
  const h = await host(t, { resolveCallConfig: () => { calls++; return new Promise(() => {}); } });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const ac = new AbortController();
  const stopping = h.listeners.get("agent/turn-stopping")({ agent, signal: ac.signal });
  assert.equal(calls, 1);
  ac.abort();
  await stopping;
  const view = await h.call("GET", "session-a", undefined, "session");
  assert.equal(view.session.reviewing, false);
  assert.equal(view.session.last.code, "CANCELLED");
  assert.equal(h.activations.length, 0);
});

test("cancelling one waiter leaves the shared review for another", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = await host(t, { resolveCallConfig: () => blocked });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  const ac = new AbortController();
  const first = tool.execute({}, { agent, signal: ac.signal });
  const second = tool.execute({}, { agent });
  ac.abort();
  assert.equal((await first).status, "cancelled");
  release();
  assert.equal((await second).code, "READ_ONLY_UNAVAILABLE");
});

test("cancelling the only waiter releases the quota for retry", async (t) => {
  let calls = 0;
  const h = await host(t, { resolveCallConfig: () => ++calls === 1 ? new Promise(() => {}) : undefined });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", maxRevisions: 1, autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  const ac = new AbortController();
  const first = tool.execute({}, { agent, signal: ac.signal });
  ac.abort();
  assert.equal((await first).status, "cancelled");
  const retry = await tool.execute({}, { agent });
  assert.equal(retry.code, "READ_ONLY_UNAVAILABLE");
  assert.equal(retry.round, 1);
});

test("same hash joins the in-flight credential check", async (t) => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = await host(t, { resolveCallConfig: () => { calls++; return blocked; } });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  const first = tool.execute({}, { agent });
  const second = tool.execute({}, { agent });
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, "READ_ONLY_UNAVAILABLE");
  assert.deepEqual(a, b);
  assert.equal(h.activations.length, 0);
});

test("corrupt settings remain visible and can be explicitly replaced", async (t) => {
  const h = await host(t, { invalidSettings: "{broken" });
  const response = await h.call("GET", "session-a");
  assert.equal(response.ok, false);
  assert.match(response.error, /文件未改动.*保存设置将覆盖/);
  assert.equal(await readFile(join(h.home, "settings.json"), "utf8"), "{broken");
  const session = await h.call("GET", "session-a", undefined, "session");
  assert.equal(session.ok, true);
  assert.match(session.session.autoDisabledReason, /读取设置失败/);
  const saved = await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  assert.equal(saved.ok, true);
  assert.equal((await h.call("GET", "session-a")).ok, true);
});

test("write violation errors remain distinguishable and retryable", async (t) => {
  const h = await host(t, { resolveCallConfig: () => { throw Object.assign(new Error("禁止写入"), { code: "WRITE_TOOL" }); } });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const result = await h.tools.find((item) => item.name === "promote").execute({}, { agent });
  assert.equal(result.code, "WRITE_TOOL");
  assert.equal(result.error, "禁止写入");
  assert.equal(result.retryable, true);
  assert.equal((await h.call("GET", "session-a", undefined, "session")).session.last.code, "WRITE_TOOL");
});

test("unloading aborts pending review with a distinct reason", async (t) => {
  const h = await host(t, { resolveCallConfig: () => new Promise(() => {}) });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const pending = h.tools.find((item) => item.name === "promote").execute({}, { agent });
  h.dispose();
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(result.code, "DISPOSED");
  assert.match(result.error, /插件已卸载/);
});

test("credential timeout settles, is retryable and does not consume quota", async (t) => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = await host(t, { resolveCallConfig: () => ++calls === 1 ? blocked : undefined });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", maxRevisions: 1, autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = tool.execute({}, { agent }).then((value) => { settled = true; return value; });
  t.mock.timers.tick(TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const first = await pending;
  assert.equal(first.status, "failed");
  assert.equal(first.code, "TIMEOUT");
  assert.match(first.error, /1200s/);
  assert.equal(first.retryable, true);
  const next = await tool.execute({}, { agent });
  assert.equal(next.status, "failed");
  assert.equal(next.code, "READ_ONLY_UNAVAILABLE");
  assert.equal(next.round, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.activations.length, 0);
});

test("explicit tool switches to newer hash instead of joining stale work", async (t) => {
  const never = new Promise(() => {});
  let calls = 0;
  const h = await host(t, { resolveCallConfig: () => ++calls === 1 ? never : undefined });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", maxRevisions: 1, autoReview: true });
  const agent = h.addAgent();
  const tool = h.tools.find((item) => item.name === "promote");
  h.drafts.set("session-a", draftWith(`旧稿\n${MARKER}`));
  const old = tool.execute({}, { agent });
  await waitUntil(() => calls === 1);
  const draft = draftWith(`新稿\n${MARKER}`);
  h.drafts.set("session-a", draft);
  const result = await tool.execute({}, { agent });
  assert.equal(result.hash, draft.hash);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "READ_ONLY_UNAVAILABLE");
  assert.equal(result.round, 1);
  const stale = await old;
  assert.equal(stale.status, "stale");
  assert.equal(stale.code, "STALE");
  assert.equal(calls, 2);
  assert.equal(h.activations.length, 0);
});

test("explicit retry after a later ordinary message uses the failed contract, isolated by session", async (t) => {
  let calls = 0;
  const h = await host(t, { resolveCallConfig: () => { calls++; throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent("session-a");
  const other = h.addAgent("session-b");
  const tool = h.tools.find((item) => item.name === "promote");
  const text = `原契约\n${MARKER}`;
  let draft = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } },
  ].reduce(reduceDraftState, createDraftState());
  h.drafts.set("session-a", draft);
  assert.equal((await tool.execute({}, { agent })).code, "TIMEOUT");
  draft = reduceDraftState(draft, { type: "turn/start", data: { turn: 2 } });
  draft = reduceDraftState(draft, { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "再次尝试" }] } } });
  h.drafts.set("session-a", draft);
  const retried = await tool.execute({}, { agent });
  assert.equal(retried.hash, contractHash(text));
  assert.equal(retried.code, "TIMEOUT");
  assert.equal(calls, 2);
  assert.match((await tool.execute({}, { agent: other })).error, /没有可审核/);
  assert.equal(calls, 2);
  // The same retained draft alone is not evidence of failure in another Host instance.
  h.drafts.set("session-b", draft);
  assert.match((await tool.execute({}, { agent: other })).error, /没有可审核/);
  assert.equal(calls, 2);
});

test("serialized producer failure permits restart retry; completed, old and untrusted records do not", async (t) => {
  const firstHost = await host(t, { resolveCallConfig: () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } });
  await firstHost.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = firstHost.addAgent();
  const text = `原契约\n${MARKER}`;
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } },
  ];
  firstHost.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
  const result = await firstHost.tools[0].execute({}, { agent });
  assert.equal(result.code, "TIMEOUT");
  for (const item of firstHost.delivered) events.push({ type: "user/message", data: item.message });
  events.push({ type: "turn/start", data: { turn: 2 } });
  const replay = (list) => JSON.parse(JSON.stringify(list)).reduce(reduceDraftState, createDraftState());
  const secondHost = await host(t);
  await secondHost.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const resumed = secondHost.addAgent();
  const tool = secondHost.tools[0];
  const restored = replay(events);
  assert.equal(restored.reviewOutcome.status, "failed");
  secondHost.drafts.set("session-a", restored);
  assert.equal((await tool.execute({}, { agent: resumed })).hash, contractHash(text));
  const checkHost = await host(t);
  await checkHost.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const checkAgent = checkHost.addAgent();
  const checkTool = checkHost.tools[0];
  for (const outcome of [
    { kind: "plugin:promote:status", promoteHash: contractHash(text), promoteStatus: "passed", promoteRetryable: false },
    { kind: "plugin:promote:status", promoteHash: contractHash(text), promoteStatus: "failed", promoteRetryable: false },
    { kind: "plugin:promote:status" },
    { kind: "user", promoteHash: contractHash(text), promoteStatus: "failed", promoteRetryable: true },
    { kind: "plugin:promote:status", promoteHash: contractHash("另一个"), promoteStatus: "failed", promoteRetryable: true },
  ]) {
    const base = events.slice(0, 2);
    base.push({ type: "user/message", data: { source: outcome, content: [{ type: "text", text: "[promote 审核失败]" }] } });
    base.push({ type: "turn/start", data: { turn: 2 } });
    checkHost.drafts.set("session-a", replay(base));
    assert.match((await checkTool.execute({}, { agent: checkAgent })).error, /没有可审核|匹配的可重试|不可重试/);
  }
});

test("needs-revision is persisted for both explicit waiters and automatic runs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "promote-revision-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true }));
  const script = `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    mock.module(pathToFileURL(process.cwd() + '/lib/review.js').href, { namedExports: { runReviewAttempt: async () => ({ passed: false, issues: [{summary:'问题'}], suggestions: [], pathsRead: [] }) } });
    const { apply } = await import('./lib/index.js');
    const { contractHash } = await import('./lib/extract.js');
    const events = [], handlers = new Map(), tools = [], agents = new Map();
    const text = '契约\\n[END OF EXECUTION PROMPT]';
    const draft = { turn:1, visibleText:text, hasTrigger:true, hash:contractHash(text), interrupted:false, tools:[], lastUserText:'' };
    const ctx = { loader:{ import:async()=>({createUserMessage:v=>v}) }, effect:f=>f(), on:(n,f)=>handlers.set(n,f),
      tools:{register:v=>tools.push(v)}, connection:{fetch:{register(){}}}, agents:{get:id=>agents.get(id)}, subagents:{},
      sessionProjections:{register(){const d=Object.assign(()=>{},{then:f=>{f({stateOf:()=>draft});return Promise.resolve()}});return d}, snapshot:()=>({values:{modelSelection:{next:{provider:'xai',model:'grok-4.6'}}}})},
      get:n=>n==='llm'?{resolveCallConfig:async()=>{}}:undefined };
    await apply(ctx,{settingsPath:process.argv[1]});
    const makeAgent=id=>{ const session={id,header:{origin:'user',delegationDepth:0,cwd:'/tmp'},append:(_t,m)=>events.push(m)};
      const a={session,steer:m=>events.push(m)}; agents.set(id,a); return a; };
    const explicit=makeAgent('explicit');
    const result=await tools[0].execute({}, {agent:explicit});
    assert.equal(result.status,'needs-revision');
    assert.ok(events.some(m=>m.source.promoteStatus==='needs-revision' && m.source.promoteHash===draft.hash && m.source.promoteRetryable===false));
    events.length=0;
    await handlers.get('agent/turn-stopping')({agent:makeAgent('automatic'),signal:new AbortController().signal});
    assert.ok(events.some(m=>m.source.promoteStatus==='needs-revision' && m.source.promoteHash===draft.hash));
  `;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script, join(home, "settings.json")], { cwd: new URL("..", import.meta.url).pathname });
});

test("settings queue serializes delayed reads and writes and survives errors", async () => {
  const lock = createSettingsQueue();
  const seen = [];
  let finishRead;
  const readBlocked = new Promise((resolve) => { finishRead = resolve; });
  let finishWrite;
  const writeBlocked = new Promise((resolve) => { finishWrite = resolve; });
  const read = lock(async () => { seen.push("read-start"); await readBlocked; seen.push("read-end"); });
  const firstWrite = lock(async () => { seen.push("write1-start"); await writeBlocked; seen.push("write1-end"); });
  const secondWrite = lock(async () => { seen.push("write2"); throw new Error("write failed"); });
  const lastRead = lock(async () => { seen.push("read2"); });
  await Promise.resolve();
  assert.deepEqual(seen, ["read-start"]);
  finishRead();
  await read;
  await Promise.resolve();
  assert.deepEqual(seen, ["read-start", "read-end", "write1-start"]);
  finishWrite();
  await firstWrite;
  await assert.rejects(secondWrite, /write failed/);
  await lastRead;
  assert.deepEqual(seen, ["read-start", "read-end", "write1-start", "write1-end", "write2", "read2"]);
});

test("overlapping settings reads and writes leave session and disk consistent", async (t) => {
  const h = await host(t);
  h.addAgent();
  const a = { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true };
  const b = { modelA: "xai/grok-4.5", modelB: "openai-codex/gpt-6-astra", autoReview: true };
  const requests = [];
  for (let i = 0; i < 8; i++) {
    requests.push(h.call("POST", "session-a", i % 2 ? b : a));
    requests.push(h.call("GET", "session-a"));
  }
  assert.ok((await Promise.all(requests)).every((result) => result.ok));
  const disk = JSON.parse(await readFile(join(h.home, "settings.json"), "utf8"));
  const session = (await h.call("GET", "session-a", undefined, "session")).session;
  assert.deepEqual(session.reviewer, disk.modelA);
});

test("nonretryable readonly failure does not wake or repeat the same hash", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const hook = h.listeners.get("agent/turn-stopping");
  await hook({ agent, signal: { aborted: false } });
  assert.equal(h.delivered.at(-1).wake, false);
  assert.equal(h.delivered.at(-1).message.source.promoteRetryable, false);
  await hook({ agent, signal: { aborted: false } });
  assert.equal(h.resolvedConfigs.length, 1);
  const result = await h.tools[0].execute({}, { agent });
  assert.equal(result.code, "NOT_RETRYABLE");
  assert.equal(h.resolvedConfigs.length, 1);
});

test("orphaned reviewing is unknown after restart and never duplicates an in-flight job", async (t) => {
  let release;
  const first = await host(t, { resolveCallConfig: () => new Promise((resolve) => { release = resolve; }) });
  await first.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = first.addAgent();
  const text = `原稿\n${MARKER}`;
  const events = [{ type: "turn/start", data: { turn: 1 } }, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } }];
  first.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
  const pending = first.tools[0].execute({}, { agent });
  const reviewing = { type: "user/message", data: first.delivered[0].message };
  const live = [...events, reviewing].reduce(reduceDraftState, createDraftState());
  first.drafts.set("session-a", live);
  const joined = first.tools[0].execute({}, { agent });
  assert.equal(first.resolvedConfigs.length, 1);
  const second = await host(t);
  await second.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const resumed = second.addAgent();
  const replay = JSON.parse(JSON.stringify([...events, reviewing, { type: "turn/start", data: { turn: 2 } }])).reduce(reduceDraftState, createDraftState());
  second.drafts.set("session-a", replay);
  const view = await second.call("GET", "session-a", undefined, "session");
  assert.equal(view.session.last.status, "unknown");
  assert.equal(view.session.last.code, "ORPHANED");
  assert.equal((await second.tools[0].execute({}, { agent: resumed })).code, "ORPHANED");
  assert.equal(second.resolvedConfigs.length, 0);
  second.drafts.set("session-a", draftWith(`新稿\n${MARKER}`));
  assert.equal((await second.tools[0].execute({}, { agent: resumed })).code, "READ_ONLY_UNAVAILABLE");
  release();
  assert.equal((await pending).code, "READ_ONLY_UNAVAILABLE");
  assert.equal((await joined).code, "READ_ONLY_UNAVAILABLE");
});

test("a started unresolved attempt is not retired when its outer race aborts", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "promote-uncertain-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true }));
  const script = `
    import { mock } from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
    let release, attempts=0; const pending=new Promise(r=>release=r);
    mock.module(pathToFileURL(process.cwd()+'/lib/review.js').href,{namedExports:{runReviewAttempt:()=>++attempts===1?pending:Promise.resolve({failed:true,code:'READ_ONLY_UNAVAILABLE',reason:'只读不可用'})}});
    const {apply}=await import('./lib/index.js'); const {contractHash}=await import('./lib/extract.js');
    const {createDraftState,reduceDraftState}=await import('./lib/projection.js');
    let draft; const events=[],handlers=new Map(),tools=[]; const text=x=>x+'\\n[END OF EXECUTION PROMPT]';
    const make=x=>({turn:1,visibleText:text(x),hasTrigger:true,hash:contractHash(text(x)),interrupted:false,tools:[],lastUserText:''});
    const session={id:'s',header:{origin:'user',delegationDepth:0,cwd:'/tmp'},append:(_t,m)=>events.push(m)}; const agent={session,steer:m=>events.push(m)};
    const ctx={loader:{import:async()=>({createUserMessage:v=>v})},effect:f=>f(),on:(n,f)=>handlers.set(n,f),tools:{register:v=>tools.push(v)},connection:{fetch:{register(){}}},agents:{get:()=>agent},subagents:{},sessionProjections:{register(){const d=Object.assign(()=>{},{then:f=>{f({stateOf:()=>draft});return Promise.resolve()}});return d},snapshot:()=>({values:{modelSelection:{next:{provider:'xai',model:'grok-4.6'}}}})},get:n=>n==='llm'?{resolveCallConfig:async()=>{}}:undefined};
    await apply(ctx,{settingsPath:process.argv[1]}); draft=make('A'); const a=tools[0].execute({}, {agent});
    while(attempts===0) await Promise.resolve(); draft=make('B'); const b=await tools[0].execute({}, {agent});
    assert.equal(b.code,'READ_ONLY_UNAVAILABLE'); assert.equal((await a).code,'STALE');
    assert.equal(events.some(e=>e.source.kind==='plugin:promote:retired' && e.source.promoteHash===make('A').hash),false);
    const replay=events.map(data=>({type:'user/message',data})).reduce(reduceDraftState,createDraftState());
    draft={...make('A'),orphanReviewing:replay.orphanReviewing,orphanOverflow:replay.orphanOverflow,reviewOutcome:replay.reviewOutcome};
    assert.equal((await tools[0].execute({}, {agent})).code,'ORPHANED');
    release({passed:true,issues:[],suggestions:[],pathsRead:[]}); await new Promise(r=>setImmediate(r));
    assert.equal(events.some(e=>e.source.kind==='plugin:promote:retired' && e.source.promoteHash===make('A').hash),false);
  `;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script, join(home, "settings.json")], { cwd: new URL("..", import.meta.url).pathname });
});

test("timeout during a started attempt remains unknown until cleanup is confirmed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "promote-timeout-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true }));
  const script = `
    import { mock } from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
    let started=0;
    mock.module(pathToFileURL(process.cwd()+'/lib/review.js').href,{namedExports:{runReviewAttempt:({controller})=>{
      started++; controller.abort(Object.assign(new Error('timeout'),{code:'TIMEOUT'})); return new Promise(()=>{});
    }}});
    const {apply}=await import('./lib/index.js'); const {contractHash}=await import('./lib/extract.js');
    const text='contract\\n[END OF EXECUTION PROMPT]'; const draft={turn:1,visibleText:text,hasTrigger:true,hash:contractHash(text),interrupted:false,tools:[],lastUserText:''};
    const events=[],handlers=new Map(),tools=[];
    const session={id:'s',header:{origin:'user',delegationDepth:0,cwd:'/tmp'},append:(_t,m)=>events.push(m)}; const agent={session,steer:m=>events.push(m)};
    const ctx={loader:{import:async()=>({createUserMessage:v=>v})},effect:f=>f(),on:(n,f)=>handlers.set(n,f),tools:{register:v=>tools.push(v)},connection:{fetch:{register(){}}},agents:{get:()=>agent},subagents:{},sessionProjections:{register(){const d=Object.assign(()=>{},{then:f=>{f({stateOf:()=>draft});return Promise.resolve()}});return d},snapshot:()=>({values:{modelSelection:{next:{provider:'xai',model:'grok-4.6'}}}})},get:n=>n==='llm'?{resolveCallConfig:async()=>{}}:undefined};
    await apply(ctx,{settingsPath:process.argv[1]});
    const result=await tools[0].execute({}, {agent});
    assert.equal(started,1); assert.equal(result.code,'ORPHANED'); assert.equal(result.status,'unknown');
    assert.match(result.error,/超时后无法确认/); assert.equal((await tools[0].execute({}, {agent})).code,'ORPHANED');
    assert.equal(events.some(e=>e.source.kind==='plugin:promote:retired'),false);
  `;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script, join(home, "settings.json")], { cwd: new URL("..", import.meta.url).pathname });
});

test("unloading a started attempt reports unknown cleanup rather than an aborted child", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "promote-dispose-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true }));
  const script = `
    import { mock } from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
    let started=0;
    mock.module(pathToFileURL(process.cwd()+'/lib/review.js').href,{namedExports:{runReviewAttempt:()=>{started++;return new Promise(()=>{})}}});
    const {apply}=await import('./lib/index.js'); const {contractHash}=await import('./lib/extract.js');
    const text='contract\\n[END OF EXECUTION PROMPT]'; const draft={turn:1,visibleText:text,hasTrigger:true,hash:contractHash(text),interrupted:false,tools:[],lastUserText:''};
    const effects=[],handlers=new Map(),tools=[];
    const session={id:'s',header:{origin:'user',delegationDepth:0,cwd:'/tmp'},append:()=>{}}; const agent={session,steer:()=>{}};
    const ctx={loader:{import:async()=>({createUserMessage:v=>v})},effect:f=>effects.push(f()),on:(n,f)=>handlers.set(n,f),tools:{register:v=>tools.push(v)},connection:{fetch:{register(){}}},agents:{get:()=>agent},subagents:{},sessionProjections:{register(){const d=Object.assign(()=>{},{then:f=>{f({stateOf:()=>draft});return Promise.resolve()}});return d},snapshot:()=>({values:{modelSelection:{next:{provider:'xai',model:'grok-4.6'}}}})},get:n=>n==='llm'?{resolveCallConfig:async()=>{}}:undefined};
    await apply(ctx,{settingsPath:process.argv[1]}); const pending=tools[0].execute({}, {agent});
    while(!started) await Promise.resolve(); effects.forEach(fn=>fn?.());
    const result=await pending; assert.equal(result.status,'unknown'); assert.equal(result.code,'ORPHANED');
    assert.equal(result.causeCode,'DISPOSED'); assert.match(result.error,/无法确认/);
  `;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script, join(home, "settings.json")], { cwd: new URL("..", import.meta.url).pathname });
});

test("cleanup failure leaves a persistent orphan and blocks a repeat", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "promote-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true }));
  const script = `
    import { mock } from 'node:test'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
    mock.module(pathToFileURL(process.cwd()+'/lib/review.js').href,{namedExports:{runReviewAttempt:({onCleanupFailed})=>{
      onCleanupFailed(); return Promise.resolve({failed:true,code:'CLEANUP_FAILED',reason:'清理失败'});
    }}});
    const {apply}=await import('./lib/index.js'); const {contractHash}=await import('./lib/extract.js');
    const {reduceDraftState,createDraftState}=await import('./lib/projection.js');
    const text='contract\\n[END OF EXECUTION PROMPT]'; const draft={turn:1,visibleText:text,hasTrigger:true,hash:contractHash(text),interrupted:false,tools:[],lastUserText:''};
    const events=[],tools=[]; const session={id:'s',header:{origin:'user',delegationDepth:0,cwd:'/tmp'},append:(_t,m)=>events.push(m)}; const agent={session,steer:m=>events.push(m)};
    const ctx={loader:{import:async()=>({createUserMessage:v=>v})},effect:f=>f(),on:()=>{},tools:{register:v=>tools.push(v)},connection:{fetch:{register(){}}},agents:{get:()=>agent},subagents:{},sessionProjections:{register(){const d=Object.assign(()=>{},{then:f=>{f({stateOf:()=>draft});return Promise.resolve()}});return d},snapshot:()=>({values:{modelSelection:{next:{provider:'xai',model:'grok-4.6'}}}})},get:n=>n==='llm'?{resolveCallConfig:async()=>{}}:undefined};
    await apply(ctx,{settingsPath:process.argv[1]}); const result=await tools[0].execute({}, {agent});
    assert.equal(result.code,'ORPHANED'); assert.equal(result.causeCode,'CLEANUP_FAILED');
    assert.equal((await tools[0].execute({}, {agent})).code,'ORPHANED');
    const replay=events.map(data=>({type:'user/message',data})).reduce(reduceDraftState,createDraftState());
    assert.ok(replay.orphanReviewing.includes(draft.hash));
  `;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script, join(home, "settings.json")], { cwd: new URL("..", import.meta.url).pathname });
});

test("superseded pre-activation attempts retire without changing the newer outcome", async (t) => {
  let calls = 0;
  const h = await host(t, { resolveCallConfig: () => ++calls % 2 ? new Promise(() => {}) : undefined });
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  const tool = h.tools[0];
  for (let i = 0; i < 8; i++) {
    h.drafts.set("session-a", draftWith(`A${i}\n${MARKER}`));
    const old = tool.execute({}, { agent });
    h.drafts.set("session-a", draftWith(`B${i}\n${MARKER}`));
    const current = await tool.execute({}, { agent });
    assert.equal(current.code, "READ_ONLY_UNAVAILABLE");
    assert.equal((await old).code, "STALE");
  }
  const events = h.delivered.map(({ message }) => ({ type: "user/message", data: message }));
  const replay = JSON.parse(JSON.stringify(events)).reduce(reduceDraftState, createDraftState());
  assert.deepEqual(replay.orphanReviewing, []);
  assert.equal(replay.orphanOverflow, false);
  assert.equal(replay.reviewOutcome.hash, contractHash(`B7\n${MARKER}`));
  assert.equal(replay.reviewOutcome.code, "READ_ONLY_UNAVAILABLE");
  const aAgain = `A0\n${MARKER}`;
  const freshEvents = [...events, { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: aAgain }] } } }];
  const restored = freshEvents.reduce(reduceDraftState, createDraftState());
  assert.equal(restored.orphanReviewing.includes(contractHash(aAgain)), false);
  const resumed = await host(t);
  await resumed.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const resumedAgent = resumed.addAgent();
  resumed.drafts.set("session-a", restored);
  assert.equal((await resumed.tools[0].execute({}, { agent: resumedAgent })).code, "READ_ONLY_UNAVAILABLE");
});

test("blocked orphan invalidates a different in-flight review for both entry points", async (t) => {
  for (const mode of ["tool", "hook"]) {
    const h = await host(t, { resolveCallConfig: () => new Promise(() => {}) });
    await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
    const agent = h.addAgent();
    const a = `孤儿 A\n${MARKER}`, b = `当前 B\n${MARKER}`;
    const events = [{ type: "turn/start", data: { turn: 1 } }, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: a }] } } },
      { type: "user/message", data: { source: { kind: "plugin:promote:status", promoteHash: contractHash(a), promoteStatus: "reviewing", promoteRetryable: false }, content: [] } }];
    h.drafts.set("session-a", draftWith(b));
    const old = h.tools[0].execute({}, { agent });
    h.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
    if (mode === "tool") assert.equal((await h.tools[0].execute({}, { agent })).code, "ORPHANED");
    else await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
    assert.equal((await old).code, "STALE");
    assert.equal(h.delivered.some(({ message }) => message.source.promoteHash === contractHash(b) && message.source.promoteStatus === "failed"), false);
    assert.equal(h.resolvedConfigs.length, 1);
  }
});

test("orphan ledger prevents A→B→A restart and overflow blocks new reviews", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  const a = `契约 A\n${MARKER}`, b = `契约 B\n${MARKER}`;
  const reviewStatus = (text, status) => ({ type: "user/message", data: { source: {
    kind: "plugin:promote:status", promoteHash: contractHash(text), promoteStatus: status, promoteRetryable: false,
  }, content: [] } });
  const msg = (turn, text) => ({ type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } });
  const events = [ { type: "turn/start", data: { turn: 1 } }, msg(1, a), reviewStatus(a, "reviewing"),
    { type: "turn/start", data: { turn: 2 } }, msg(2, b), reviewStatus(b, "failed"),
    { type: "turn/start", data: { turn: 3 } }, msg(3, a) ];
  const restored = JSON.parse(JSON.stringify(events)).reduce(reduceDraftState, createDraftState());
  assert.ok(restored.orphanReviewing.includes(contractHash(a)));
  h.drafts.set("session-a", restored);
  await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
  assert.equal(h.resolvedConfigs.length, 0);
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].message.content[0].text, /状态未知/);
  assert.equal((await h.tools[0].execute({}, { agent })).code, "ORPHANED");
  assert.equal(h.resolvedConfigs.length, 0);
  let overflowing = restored;
  for (let i = 0; i < 129; i++) overflowing = reduceDraftState(overflowing, reviewStatus(`old-${i}`, "reviewing"));
  assert.equal(overflowing.orphanOverflow, true);
  const fresh = `全新契约\n${MARKER}`;
  overflowing = reduceDraftState(overflowing, { type: "turn/start", data: { turn: 4 } });
  overflowing = reduceDraftState(overflowing, msg(4, fresh));
  h.drafts.set("session-a", overflowing);
  const denied = await h.tools[0].execute({}, { agent });
  assert.equal(denied.code, "ORPHANED");
  assert.match(denied.error, /溢出/);
  assert.equal(h.resolvedConfigs.length, 0);
});

test("credential login recovery permits explicit retry in session and after replay", async (t) => {
  let loggedIn = false;
  const resolveCallConfig = () => { if (!loggedIn) throw new Error("次模型未登录，缺少凭证"); };
  const h = await host(t, { resolveCallConfig });
  const config = { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true };
  await h.call("POST", "session-a", config);
  const agent = h.addAgent();
  const text = `契约\n${MARKER}`;
  const events = [{ type: "turn/start", data: { turn: 1 } }, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } }];
  h.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
  await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
  const failure = h.delivered.at(-1).message;
  assert.equal(failure.source.promoteCode, "AUTH_UNAVAILABLE");
  assert.equal(failure.source.promoteRetryable, false);
  events.push({ type: "user/message", data: failure }, { type: "turn/start", data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "再次尝试" }] } } });
  const replay = JSON.parse(JSON.stringify(events)).reduce(reduceDraftState, createDraftState());
  assert.equal(replay.reviewOutcome.code, "AUTH_UNAVAILABLE");
  h.drafts.set("session-a", replay);
  assert.equal((await h.tools[0].execute({}, { agent })).code, "AUTH_UNAVAILABLE");
  loggedIn = true;
  const resumed = await host(t, { resolveCallConfig });
  await resumed.call("POST", "session-a", config);
  const resumedAgent = resumed.addAgent();
  resumed.drafts.set("session-a", replay);
  await resumed.listeners.get("agent/turn-stopping")({ agent: resumedAgent, signal: { aborted: false } });
  assert.equal(resumed.resolvedConfigs.length, 0);
  assert.equal((await resumed.tools[0].execute({}, { agent: resumedAgent })).code, "READ_ONLY_UNAVAILABLE");
  assert.equal((await h.tools[0].execute({}, { agent })).code, "READ_ONLY_UNAVAILABLE");
  assert.equal((await h.tools[0].execute({}, { agent })).code, "NOT_RETRYABLE");
});

test("repairing configuration allows explicit retry after ordinary reply and restart", async (t) => {
  for (const [invalidSettings, expected] of [["{broken", "SETTINGS_INVALID"], [null, "UNCONFIGURED"]]) {
    const h = await host(t, { invalidSettings });
    const agent = h.addAgent();
    const text = `原稿\n${MARKER}`;
    const events = [{ type: "turn/start", data: { turn: 1 } }, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } }];
    h.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
    await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
    assert.equal(h.delivered[0].message.source.promoteCode, expected);
    events.push({ type: "user/message", data: h.delivered[0].message }, { type: "turn/start", data: { turn: 2 } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "稍后再试" }] } } });
    const restored = JSON.parse(JSON.stringify(events)).reduce(reduceDraftState, createDraftState());
    assert.equal(restored.reviewOutcome.code, expected);
    h.drafts.set("session-a", restored);
    assert.equal((await h.tools[0].execute({}, { agent })).code, expected);
    const config = { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true };
    assert.equal((await h.call("POST", "session-a", config)).ok, true);
    const resumed = await host(t);
    await resumed.call("POST", "session-a", config);
    const resumedAgent = resumed.addAgent();
    resumed.drafts.set("session-a", restored);
    await resumed.listeners.get("agent/turn-stopping")({ agent: resumedAgent, signal: { aborted: false } });
    assert.equal(resumed.resolvedConfigs.length, 0);
    assert.equal((await resumed.tools[0].execute({}, { agent: resumedAgent })).code, "READ_ONLY_UNAVAILABLE");
    assert.equal((await h.tools[0].execute({}, { agent })).code, "READ_ONLY_UNAVAILABLE");
    assert.equal((await h.tools[0].execute({}, { agent })).code, "NOT_RETRYABLE");
  }
});

test("setup failures persist and suppress duplicate failure on replay", async (t) => {
  for (const invalidSettings of ["{broken", null]) {
    const h = await host(t, { invalidSettings });
    const agent = h.addAgent();
    const text = `契约\n${MARKER}`;
    const events = [{ type: "turn/start", data: { turn: 1 } }, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text }] } } }];
    h.drafts.set("session-a", events.reduce(reduceDraftState, createDraftState()));
    await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].message.source.promoteStatus, "failed");
    assert.equal(h.delivered[0].message.source.promoteRetryable, false);
    events.push({ type: "user/message", data: h.delivered[0].message });
    const resumed = await host(t, { invalidSettings });
    const secondAgent = resumed.addAgent();
    resumed.drafts.set("session-a", JSON.parse(JSON.stringify(events)).reduce(reduceDraftState, createDraftState()));
    await resumed.listeners.get("agent/turn-stopping")({ agent: secondAgent, signal: { aborted: false } });
    assert.equal(resumed.delivered.length, 0);
  }
});

test("restored review status suppresses auto-repeat only for the recorded hash", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", { modelA: "openai-codex/gpt-6-astra", modelB: "xai/grok-4.5", autoReview: true });
  const agent = h.addAgent();
  const old = `旧稿\n${MARKER}`;
  const base = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: old }] } } },
  ];
  for (const [status, retryable] of [["passed", false], ["failed", false], ["failed", true], ["reviewing", false]]) {
    const recorded = { type: "user/message", data: { source: { kind: "plugin:promote:status", promoteHash: contractHash(old), promoteStatus: status, promoteRetryable: retryable }, content: [] } };
    const draft = [...base, recorded].reduce(reduceDraftState, createDraftState());
    h.drafts.set("session-a", draft);
    await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
    assert.equal(h.resolvedConfigs.length, 0, status);
  }
  const fresh = `新稿\n${MARKER}`;
  const draft = [...base,
    { type: "user/message", data: { source: { kind: "plugin:promote:status", promoteHash: contractHash(old), promoteStatus: "passed", promoteRetryable: false }, content: [] } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: fresh }] } } },
  ].reduce(reduceDraftState, createDraftState());
  h.drafts.set("session-a", draft);
  await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
  assert.equal(h.resolvedConfigs.length, 1);
});

test("session API and automatic failure preserve the model read reason", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "deepseek-official/deepseek-flash",
    modelB: "openai-codex/gpt-6.1-terra",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  agent.model = { current: () => undefined };
  const response = await h.call("GET", "session-a", undefined, "session");
  assert.equal(response.session.mainModel, null);
  assert.equal(response.session.mainModelError, "当前会话 Agent 尚未确定模型");
  assert.match(response.session.autoDisabledReason, /当前会话 Agent 尚未确定模型/);
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  await h.listeners.get("agent/turn-stopping")({ agent, signal: { aborted: false } });
  assert.match(h.delivered.at(-1).message.content[0].text, /当前会话 Agent 尚未确定模型/);
  assert.equal(h.resolvedConfigs.length, 0);
});

test("turn-stopping waits for review before the hook returns", async (t) => {
  let resolveChild;
  const child = new Promise((resolve) => { resolveChild = resolve; });
  const h = await host(t, { resolveCallConfig: () => child });
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  let stoppingDone = false;
  const stopping = Promise.resolve(
    h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } }),
  ).then(() => { stoppingDone = true; });
  assert.equal(stoppingDone, false);
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);
  resolveChild();
  await stopping;
  assert.equal(stoppingDone, true);
  assert.equal(h.activations.length, 0);
  assert.equal(h.delivered.some((row) => /只读/.test(row.message.content[0].text)), true);
});
