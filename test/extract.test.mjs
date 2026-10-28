import test from "node:test";
import assert from "node:assert/strict";
import {
  contractHash, hasUnquotedMarker, isPromoteSource, stripQuotedAndFenced, visibleText,
} from "../lib/extract.js";
import { MARKER } from "../lib/constants.js";

test("plain and fenced markers trigger; quoted and inline markers do not", () => {
  assert.equal(hasUnquotedMarker(`正文\n${MARKER}\n`), true);
  assert.equal(hasUnquotedMarker(`> ${MARKER}`), false);
  assert.equal(hasUnquotedMarker("```\n" + MARKER + "\n```"), true);
  assert.equal(hasUnquotedMarker("```text\n结果：示例\n" + MARKER + "\n```"), true);
  assert.equal(hasUnquotedMarker("`" + MARKER + "`"), false);
  assert.equal(hasUnquotedMarker("前言\n> " + MARKER + "\n" + MARKER), true);
});

test("plugin sources are recognized and do not count as user drafts", () => {
  assert.equal(isPromoteSource({ kind: "plugin:promote:status" }), true);
  assert.equal(isPromoteSource({ kind: "plugin:promote:revision" }), true);
  assert.equal(isPromoteSource({ kind: "user" }), false);
  assert.equal(isPromoteSource({ kind: "plugin:xuxie" }), false);
});

test("visible text ignores reasoning and hashes the contract bytes", () => {
  const text = `hello\n${MARKER}`;
  assert.equal(visibleText([
    { type: "reasoning", text: "secret" },
    { type: "text", text: "hello" },
    { type: "text", text: MARKER },
  ]), text);
  assert.equal(contractHash(text), contractHash(Buffer.from(text, "utf8").toString("utf8")));
  assert.notEqual(contractHash(text), contractHash(text + " "));
});

test("stripQuotedAndFenced unwraps fences and keeps inner markers", () => {
  const stripped = stripQuotedAndFenced("keep\n~~~\n" + MARKER + "\n~~~\nok");
  assert.equal(stripped.includes(MARKER), true);
  assert.equal(stripped.includes("keep"), true);
  assert.equal(stripped.includes("~~~"), false);
});
