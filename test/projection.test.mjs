import test from "node:test";
import assert from "node:assert/strict";
import { MARKER } from "../lib/constants.js";
import { createDraftState, reduceDraftState, draftStateSchema, MAX_ORPHAN_REVIEWING } from "../lib/projection.js";
import { contractHash } from "../lib/extract.js";

function fold(events) {
  return events.reduce(reduceDraftState, createDraftState());
}

test("quoted marker in assistant text does not auto-trigger", () => {
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, interrupted: false, message: { content: [{ type: "text", text: `> ${MARKER}` }] } } },
  ]);
  assert.equal(state.hasTrigger, false);
});

test("unquoted marker hashes the visible draft", () => {
  const text = `契约\n${MARKER}`;
  const state = fold([
    { type: "turn/start", data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, interrupted: false, message: { content: [{ type: "text", text }] } } },
  ]);
  assert.equal(state.hasTrigger, true);
  assert.equal(state.hash, contractHash(text));
});

test("skill-style fenced contract is a complete reviewable draft", () => {
  const text = [
    "**档位：standard 执行契约。** 说明。",
    "",
    "```text",
    "结果：监测工作台加查看详情",
    "任务根：/Users/ning/Documents/lefei-geo",
    MARKER,
    "```",
    "",
    "需要补充：核对该卡片 round 范围。",
  ].join("\n");
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, interrupted: false, message: { content: [{ type: "text", text }] } } },
  ]);
  assert.equal(state.hasTrigger, true);
  assert.equal(state.hash, contractHash(text));
});

test("plugin injected user messages do not become the original user request or a trigger", () => {
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "原始任务" }] } },
    { type: "user/message", data: { source: { kind: "plugin:promote:status" }, content: [{ type: "text", text: MARKER }] } },
  ]);
  assert.equal(state.lastUserText, "原始任务");
  assert.equal(state.hasTrigger, false);
});

test("revision messages preserve persisted outcome, invalid status clears it", () => {
  const hash = contractHash(`契约\n${MARKER}`);
  const status = { type: "user/message", data: { source: {
    kind: "plugin:promote:status", promoteHash: hash, promoteStatus: "needs-revision", promoteRetryable: false,
  }, content: [] } };
  const revision = { type: "user/message", data: { source: { kind: "plugin:promote:revision" }, content: [{ type: "text", text: "请改稿" }] } };
  const state = fold([status, revision, { type: "turn/start", data: { turn: 2 } }]);
  assert.deepEqual(state.reviewOutcome, { hash, status: "needs-revision", retryable: false });
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(state))).reviewOutcome, state.reviewOutcome);
  const invalid = reduceDraftState(state, { type: "user/message", data: { source: { kind: "plugin:promote:status", promoteHash: "invalid", promoteStatus: "failed", promoteRetryable: true }, content: [] } });
  assert.equal(invalid.reviewOutcome, null);
});

test("reviewing hashes survive other versions and clear only on their own terminal status", () => {
  const a = contractHash("A"), b = contractHash("B");
  const event = (hash, status) => ({ type: "user/message", data: { source: {
    kind: "plugin:promote:status", promoteHash: hash, promoteStatus: status, promoteRetryable: false,
  }, content: [] } });
  const state = fold([event(a, "reviewing"), event(b, "reviewing"), event(b, "passed"), { type: "turn/start", data: { turn: 3 } }]);
  assert.deepEqual(state.orphanReviewing, [a]);
  assert.equal(state.orphanOverflow, false);
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(reduceDraftState(state, event(a, "failed")).orphanReviewing, []);
});

test("retirement replay removes only the specified orphan without changing outcome or overflow", () => {
  const a = contractHash("A"), b = contractHash("B");
  const status = (hash) => ({ type: "user/message", data: { source: { kind: "plugin:promote:status", promoteHash: hash, promoteStatus: "reviewing", promoteRetryable: false }, content: [] } });
  const retired = (kind, hash) => ({ type: "user/message", data: { source: { kind, promoteHash: hash }, content: [] } });
  const events = [status(a), status(b), retired("user", a), retired("plugin:other:retired", a), retired("plugin:promote:retired", "bad")];
  const before = fold(JSON.parse(JSON.stringify(events)));
  assert.deepEqual(before.orphanReviewing, [a, b]);
  const after = reduceDraftState({ ...before, orphanOverflow: true }, retired("plugin:promote:retired", a));
  assert.deepEqual(after.orphanReviewing, [b]);
  assert.deepEqual(after.reviewOutcome, before.reviewOutcome);
  assert.equal(after.orphanOverflow, true);
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(after))), after);
  const replayed = fold(JSON.parse(JSON.stringify([...events, retired("plugin:promote:retired", a)])));
  assert.deepEqual(replayed.orphanReviewing, [b]);
  assert.deepEqual(replayed.reviewOutcome, before.reviewOutcome);
});

test("orphan tracking is bounded and overflow remains fail-closed after later completions", () => {
  const event = (hash, status) => ({ type: "user/message", data: { source: {
    kind: "plugin:promote:status", promoteHash: hash, promoteStatus: status, promoteRetryable: false,
  }, content: [] } });
  const hashes = Array.from({ length: MAX_ORPHAN_REVIEWING + 1 }, (_, i) => contractHash(String(i)));
  let state = fold(hashes.map((hash) => event(hash, "reviewing")));
  assert.equal(state.orphanReviewing.length, MAX_ORPHAN_REVIEWING);
  assert.equal(state.orphanOverflow, true);
  state = reduceDraftState(state, event(hashes[0], "passed"));
  assert.equal(state.orphanOverflow, true);
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => draftStateSchema.parse({ ...state, orphanOverflow: undefined }));
});

test("failure codes round-trip while legacy status without code stays valid", () => {
  const hash = contractHash(`契约\n${MARKER}`);
  const make = (code) => ({ type: "user/message", data: { source: {
    kind: "plugin:promote:status", promoteHash: hash, promoteStatus: "failed", promoteRetryable: false,
    ...(code === undefined ? {} : { promoteCode: code }),
  }, content: [] } });
  const current = fold([make("SETTINGS_INVALID")]);
  assert.equal(current.reviewOutcome.code, "SETTINGS_INVALID");
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(current))), current);
  assert.equal(fold([make(undefined)]).reviewOutcome.code, undefined);
  assert.equal(fold([make("invalid-code")]).reviewOutcome, null);
});

test("retry snapshot survives ordinary replies and checkpoint round-trip, but newer drafts win", () => {
  const old = `旧契约\n${MARKER}`;
  const fresh = `新契约\n${MARKER}`;
  const events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "原请求" }] } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: old }] } } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "重试中" }] } } },
  ];
  const snapshot = fold(events);
  assert.equal(snapshot.hasTrigger, false);
  assert.equal(snapshot.latestDraft.visibleText, old);
  assert.equal(snapshot.latestDraft.lastUserText, "原请求");
  assert.deepEqual(draftStateSchema.parse(JSON.parse(JSON.stringify(snapshot))), snapshot);
  const updated = reduceDraftState(snapshot, { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: fresh }] } } });
  assert.equal(updated.latestDraft.hash, contractHash(fresh));
  assert.throws(() => draftStateSchema.parse({ ...snapshot, latestDraft: { ...snapshot.latestDraft, hash: "wrong" } }));
});

test("an interrupted newer marked draft invalidates the old retry target", () => {
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: `旧稿\n${MARKER}` }] } } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, interrupted: true, message: { content: [{ type: "text", text: `新稿\n${MARKER}` }] } } },
    { type: "turn/start", data: { turn: 3 } },
  ]);
  assert.equal(state.latestDraft, null);
});

test("interrupted assistant output is not a complete contract", () => {
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, interrupted: true, message: { content: [{ type: "text", text: MARKER }] } } },
  ]);
  assert.equal(state.hasTrigger, false);
});
