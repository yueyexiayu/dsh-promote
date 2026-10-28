import test from "node:test";
import assert from "node:assert/strict";
import { MARKER } from "../lib/constants.js";
import { createDraftState, reduceDraftState } from "../lib/projection.js";
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

test("interrupted assistant output is not a complete contract", () => {
  const state = fold([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, interrupted: true, message: { content: [{ type: "text", text: MARKER }] } } },
  ]);
  assert.equal(state.hasTrigger, false);
});
