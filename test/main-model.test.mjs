import test from "node:test";
import assert from "node:assert/strict";
import { currentSessionModel } from "../lib/index.js";
import { chooseReviewer } from "../lib/select.js";

const main = { provider: "openai-codex", model: "gpt-6.1-terra" };
const a = { provider: "deepseek-official", model: "deepseek-flash" };
const b = main;

function context({ current, projection, header } = {}) {
  const session = { requestHeader: () => header };
  const agent = { session, ...(current ? { model: { current } } : {}) };
  return {
    agents: { get: () => agent },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: projection } }) },
  };
}

test("live Agent selection works without a recorded selection or request", () => {
  const ctx = context({ current: () => main, projection: { next: null } });
  assert.deepEqual(currentSessionModel(ctx, "s"), main);
  assert.deepEqual(chooseReviewer(currentSessionModel(ctx, "s"), { modelA: a, modelB: b }).reviewer, a);
});

test("live selection wins over a stale recorded route and avoids self-review", () => {
  const ctx = context({ current: () => a, projection: { next: main }, header: { config: main } });
  const selection = currentSessionModel(ctx, "s");
  assert.deepEqual(selection, a);
  assert.deepEqual(chooseReviewer(selection, { modelA: a, modelB: b }).reviewer, b);
});

test("missing or malformed live choice never falls back to an older route", () => {
  for (const current of [() => undefined, () => ({ provider: "openai-codex" }), () => { throw new Error("private detail"); }]) {
    const result = currentSessionModel(context({ current, projection: { next: main }, header: { config: main } }), "s");
    assert.equal(result.provider, null);
    assert.ok(result.error);
    assert.doesNotMatch(result.error, /private detail/);
    const choice = chooseReviewer(null, { modelA: a, modelB: b }, result.error);
    assert.equal(choice.code, "NO_MAIN");
    assert.ok(choice.reason.includes(result.error));
  }
});

test("legacy Agent uses recorded selection and reports incomplete routes", () => {
  assert.deepEqual(currentSessionModel(context({ projection: { next: main } }), "s"), main);
  assert.deepEqual(currentSessionModel(context({ projection: { next: null }, header: { config: main } }), "s"), main);
  const invalid = currentSessionModel(context({ projection: { next: { provider: "openai-codex" } } }), "s");
  assert.equal(invalid.error, "当前会话模型选择无效");
});

test("unknown session does not use global defaults", () => {
  const ctx = { agents: { get: () => undefined }, get: () => undefined };
  assert.match(currentSessionModel(ctx, "s").error, /未处于活跃状态/);
  assert.match(currentSessionModel(ctx, "").error, /未关联会话/);
});
