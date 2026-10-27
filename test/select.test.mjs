import test from "node:test";
import assert from "node:assert/strict";
import { autoReviewReady, chooseReviewer } from "../lib/select.js";

const main = { provider: "xai", model: "grok-4.6" };
const other = { provider: "openai-codex", model: "gpt-6-astra" };
const third = { provider: "lefei", model: "deepseek-flash" };

test("unconfigured A/B disables review", () => {
  const choice = chooseReviewer(main, { modelA: null, modelB: other, autoReview: true });
  assert.equal(choice.ok, false);
  assert.equal(choice.code, "UNCONFIGURED");
});

test("A matching the current session model falls back to B", () => {
  const choice = chooseReviewer(main, { modelA: main, modelB: other });
  assert.equal(choice.ok, true);
  assert.deepEqual(choice.reviewer, other);
  assert.equal(choice.used, "B");
});

test("A and B both matching the current session model is a visible collision", () => {
  const choice = chooseReviewer(main, { modelA: main, modelB: main });
  assert.equal(choice.ok, false);
  assert.equal(choice.code, "BOTH_MATCH_MAIN");
});

test("A equals B is rejected even when different from main", () => {
  const choice = chooseReviewer(main, { modelA: other, modelB: other });
  assert.equal(choice.ok, false);
  assert.equal(choice.code, "A_EQUALS_B");
});

test("missing current session model does not invent a Host default reviewer", () => {
  const choice = chooseReviewer(null, { modelA: other, modelB: third });
  assert.equal(choice.ok, false);
  assert.equal(choice.code, "NO_MAIN");
});

test("auto review is disabled when the switch is off or the choice failed", () => {
  assert.equal(autoReviewReady({ autoReview: false }, { ok: true }).ok, false);
  assert.equal(autoReviewReady({ autoReview: true }, { ok: false, reason: "x" }).ok, false);
  assert.equal(autoReviewReady({ autoReview: true }, { ok: true }).ok, true);
});
