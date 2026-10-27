import test from "node:test";
import assert from "node:assert/strict";
import {
  beginReview, completeReview, createReviewState, failVisible, shouldStartReview,
} from "../lib/state.js";

const reviewer = { provider: "openai-codex", model: "gpt-6-astra" };

test("the same hash cannot start two reviews", () => {
  const state = createReviewState();
  const first = shouldStartReview(state, { hash: "aa", autoReady: true });
  assert.equal(first.ok, true);
  beginReview(state, { hash: "aa", reviewer, maxRevisions: 3 });
  const second = shouldStartReview(state, { hash: "aa", autoReady: true });
  assert.equal(second.ok, false);
  assert.equal(second.code, "ALREADY_RUNNING");
});

test("stale results from a cancelled hash are discarded", () => {
  const state = createReviewState();
  const first = beginReview(state, { hash: "old", reviewer, maxRevisions: 3 });
  const second = beginReview(state, { hash: "new", reviewer, maxRevisions: 3 });
  assert.equal(first.cancelled, null);
  assert.equal(second.cancelled.hash, "old");
  const stale = completeReview(state, {
    hash: "old",
    generation: first.active.generation,
    result: { passed: true, issues: [], suggestions: [], pathsRead: ["a.js"] },
  });
  assert.equal(stale.kind, "stale");
  assert.equal(state.phase, "reviewing");
  const live = completeReview(state, {
    hash: "new",
    generation: second.active.generation,
    result: { passed: false, issues: [{ summary: "缺漏" }], suggestions: [], pathsRead: ["b.js"] },
  });
  assert.equal(live.kind, "needs-revision");
});

test("passing stops; exhausting N failed reviews marks 未通过", () => {
  const state = createReviewState();
  const started = beginReview(state, { hash: "h1", reviewer, maxRevisions: 1 });
  const done = completeReview(state, {
    hash: "h1",
    generation: started.active.generation,
    result: { passed: false, issues: [{ summary: "仍有问题" }], suggestions: [], pathsRead: ["x"] },
  });
  assert.equal(done.kind, "exhausted");
  assert.equal(state.phase, "exhausted");
  const again = shouldStartReview(state, { hash: "h1", autoReady: true });
  assert.equal(again.ok, false);

  const fresh = createReviewState();
  const passStart = beginReview(fresh, { hash: "ok", reviewer, maxRevisions: 3 });
  const passed = completeReview(fresh, {
    hash: "ok",
    generation: passStart.active.generation,
    result: { passed: true, issues: [], suggestions: [], pathsRead: ["lib/index.js"] },
  });
  assert.equal(passed.kind, "passed");
  assert.equal(shouldStartReview(fresh, { hash: "ok" }).code, "ALREADY_PASSED");
});

test("explicit and auto must not both be considered startable while one hash is active", () => {
  const state = createReviewState();
  beginReview(state, { hash: "same", reviewer, maxRevisions: 3 });
  assert.equal(shouldStartReview(state, { hash: "same", explicit: true }).ok, false);
  assert.equal(shouldStartReview(state, { hash: "same", explicit: false, autoReady: true }).ok, false);
});

test("visible failures record disableAuto without inventing a pass", () => {
  const state = createReviewState();
  const last = failVisible(state, { reason: "未配置", hash: "h", disableAuto: true, code: "UNCONFIGURED" });
  assert.equal(last.passed, false);
  assert.equal(last.disableAuto, true);
  assert.equal(state.phase, "failed");
});
