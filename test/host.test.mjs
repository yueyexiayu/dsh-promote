import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, inject } from "../lib/index.js";
import { MARKER } from "../lib/constants.js";
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
      register() {},
      stateOf(session) { return drafts.get(session.id) ?? createDraftState(); },
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
          resolveCallConfig: async (config) => { resolvedConfigs.push(config); },
        };
      }
    },
  };
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
  return { ctx, listeners, tools, activations, delivered, drafts, addAgent, call, home, resolvedConfigs };
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
  assert.equal(open.version, "0.1.6");
  assert.equal(open.session.reviewing, false);
  const sessionOnly = await h.call("GET", "session-a", undefined, "session");
  assert.equal(sessionOnly.ok, true);
  assert.equal(sessionOnly.version, "0.1.6");
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
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 1);
  assert.equal(h.activations.length, 1);
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);
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
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 1);
  assert.equal(h.activations.length, 1);
  assert.equal(h.activations[0].provider, "fork");
  assert.equal(h.activations[0].delivery, "caller");
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);

  const quoted = h.addAgent("session-b");
  h.drafts.set("session-b", draftWith(`> ${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent: quoted, turn: 1, signal: { aborted: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.activations.length, 1);
});

test("a newer contract discards the stale review result", async (t) => {
  let resolveOld;
  const oldResult = new Promise((resolve) => { resolveOld = resolve; });
  const h = await host(t, {
    async startActivation(spec) {
      const prompt = spec.request.prompt[0].text;
      if (prompt.includes("旧稿")) {
        return { childId: "old", result: oldResult, dispose() {} };
      }
      return {
        childId: "new",
        result: Promise.resolve({
          stopReason: "completed",
          structured: { passed: false, issues: [{ summary: "新稿问题" }], suggestions: ["改这里"], pathsRead: ["a.js"] },
        }),
        dispose() {},
      };
    },
  });
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`旧稿\n${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 1);
  h.drafts.set("session-a", draftWith(`新稿\n${MARKER}`));
  h.listeners.get("agent/turn-stopping")({ agent, turn: 2, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 2);
  resolveOld({
    stopReason: "completed",
    structured: { passed: true, issues: [], suggestions: [], pathsRead: ["stale.js"] },
  });
  await waitUntil(() => h.delivered.some((row) => /请改稿|新稿问题/.test(row.message.content[0].text)));
  const texts = h.delivered.map((row) => row.message.content[0].text);
  assert.equal(texts.some((text) => text.startsWith("[promote 终稿]")), false);
  assert.equal(texts.some((text) => text.includes("新稿问题") || text.includes("请改稿")), true);
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
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 1);
  assert.deepEqual(h.activations[0].request.agentOptions, { provider: "openai-codex", model: "gpt-6-astra" });
});

test("saved reasoning effort is resolved and passed into the real child call", async (t) => {
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
  h.listeners.get("agent/turn-stopping")({ agent, turn: 1, signal: { aborted: false } });
  await waitUntil(() => h.activations.length === 1);
  assert.deepEqual(h.activations[0].request.agentOptions, {
    provider: "openai-codex",
    model: "gpt-6-astra",
    reasoningEffort: "high",
  });
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

test("promote tool waits for the child and returns the outcome", async (t) => {
  const h = await host(t);
  await h.call("POST", "session-a", {
    modelA: "openai-codex/gpt-6-astra",
    modelB: "xai/grok-4.5",
    autoReview: true,
  });
  const agent = h.addAgent("session-a");
  h.drafts.set("session-a", draftWith(`契约\n${MARKER}`));
  const tool = h.tools.find((item) => item.name === "promote");
  assert.ok(tool.timeoutMs > 120_000);
  const result = await tool.execute({}, { agent });
  assert.equal(result.ok, true);
  assert.equal(result.status, "passed");
  assert.equal(h.activations.length, 1);
});

test("turn-stopping waits for review before the hook returns", async (t) => {
  let resolveChild;
  const child = new Promise((resolve) => { resolveChild = resolve; });
  const h = await host(t, {
    async startActivation() {
      return { childId: "child", result: child, dispose() {} };
    },
  });
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
  await waitUntil(() => h.activations.length === 1);
  assert.equal(stoppingDone, false);
  assert.equal(h.delivered[0].wake, false);
  assert.match(h.delivered[0].message.content[0].text, /审核中/);
  resolveChild({
    stopReason: "completed",
    structured: { passed: true, issues: [], suggestions: [], pathsRead: ["a.js"] },
  });
  await stopping;
  assert.equal(stoppingDone, true);
  assert.equal(h.delivered.some((row) => row.message.content[0].text.startsWith("[promote 终稿]")), true);
});
