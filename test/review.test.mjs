import test from "node:test";
import assert from "node:assert/strict";
import { assessReviewEvidence, runReviewAttempt } from "../lib/review.js";
import { pathToFileURL } from "node:url";

test("unprotected activation is never started, including fork fallback", async () => {
  let calls = 0;
  const result = await runReviewAttempt({ subagents: { startActivation() { calls++; throw new Error("must not run"); } } });
  assert.equal(calls, 0);
  assert.equal(result.failed, true);
  assert.equal(result.code, "READ_ONLY_UNAVAILABLE");
  assert.match(result.reason, /启动前已强制只读/);
});

test("already aborted operations distinguish timeout, writes, stale drafts and disposal", async () => {
  for (const [code, message] of [["TIMEOUT", /超时/], ["WRITE_TOOL", /写入/], ["STALE", /新版本/], ["DISPOSED", /销毁/], ["CANCELLED", /取消/]]) {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error(code), { code }));
    const result = await runReviewAttempt({ controller });
    assert.equal(result.failed, true);
    assert.equal(result.code, code);
    assert.match(result.reason, message);
  }
});

const read = (path, line = 1) => ({ name: "read", value: { path, lines: [{ number: line, text: "source" }] } });
const lsp = (source, target, line = 1, operation = "goToDefinition", targetLine = 1, character = 1, targetCharacter = 1) => ({ name: "lsp", arguments: { operation, file_path: source, line, character },
  value: { kind: "locations", reviewSourceUri: pathToFileURL(source).href,
    locations: [{ uri: pathToFileURL(target).href, range: { start: { line: targetLine - 1, character: targetCharacter - 1 },
      end: { line: targetLine - 1, character: targetCharacter } } }] } });
const edge = (from, to) => [lsp(from, to), lsp(to, from, 1, "findReferences")];

test("code evidence needs declared actual source reads and a linked nonempty LSP result", () => {
  const contract = "修复代码 /tmp/ws/start.js 和 /tmp/ws/end.js";
  const calls = [read("/tmp/ws/start.js"), read("/tmp/ws/end.js"), ...edge("/tmp/ws/start.js", "/tmp/ws/end.js")];
  const chain = [{ path: "/tmp/ws/start.js", line: 1, character: 1 }, { path: "/tmp/ws/end.js", line: 1, character: 1 }];
  assert.deepEqual(assessReviewEvidence({ status: "verified", calls }, contract, "/tmp/ws", chain).pathsRead, ["/tmp/ws/start.js", "/tmp/ws/end.js"]);
  // A definition alone, references alone, or a reference to another location is not a verified edge.
  for (const incomplete of [calls.slice(0, 3), [calls[0], calls[1], calls[3]],
    [...calls.slice(0, 3), lsp("/tmp/ws/end.js", "/tmp/ws/other.js", 1, "findReferences")]]) {
    assert.equal(assessReviewEvidence({ status: "verified", calls: incomplete }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  }
  // A reference query on the caller may also return the definition itself.
  const forwardReferences = [...calls.slice(0, 3), lsp("/tmp/ws/start.js", "/tmp/ws/end.js", 1, "findReferences")];
  assert.equal(assessReviewEvidence({ status: "verified", calls: forwardReferences }, contract, "/tmp/ws", chain).pathsRead.length, 2);
  // A different symbol on the same line must not satisfy either endpoint.
  for (const bad of [[...calls.slice(0, 2), lsp("/tmp/ws/start.js", "/tmp/ws/end.js", 1, "goToDefinition", 1, 2), calls[3]],
    [...calls.slice(0, 2), lsp("/tmp/ws/start.js", "/tmp/ws/end.js", 1, "goToDefinition", 1, 1, 2), calls[3]],
    [...calls.slice(0, 3), lsp("/tmp/ws/end.js", "/tmp/ws/start.js", 1, "findReferences", 1, 2)]]) {
    assert.equal(assessReviewEvidence({ status: "verified", calls: bad }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  }
  assert.equal(assessReviewEvidence({ status: "verified", calls }, contract, "/tmp/ws", [{ path: "/tmp/ws/start.js", line: 1 }, chain[1]]).code, "EVIDENCE_INSUFFICIENT");
  for (const bad of [calls.slice(0, 2), [calls[0], calls[2]], [calls[0], calls[1], lsp("/tmp/ws/start.js", "/tmp/ws/end.js", 7)]]) {
    assert.equal(assessReviewEvidence({ status: "verified", calls: bad }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  }
  assert.equal(assessReviewEvidence({ status: "partial", calls }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence({ status: "verified", calls }, "修复代码", "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  const multi = "调用链 /tmp/ws/start.js -> /tmp/ws/end.js -> /tmp/ws/final.js";
  const multiCalls = [...calls, read("/tmp/ws/final.js"), ...edge("/tmp/ws/end.js", "/tmp/ws/final.js")];
  const multiChain = [...chain, { path: "/tmp/ws/final.js", line: 1, character: 1 }];
  assert.equal(assessReviewEvidence({ status: "verified", calls: multiCalls.slice(0, -2) }, multi, "/tmp/ws", multiChain).code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence({ status: "verified", calls: multiCalls }, multi, "/tmp/ws", multiChain).pathsRead.length, 3);
  const mixedEdges = [read("/tmp/ws/start.js"), read("/tmp/ws/end.js"), read("/tmp/ws/final.js"),
    lsp("/tmp/ws/start.js", "/tmp/ws/end.js"), lsp("/tmp/ws/final.js", "/tmp/ws/end.js", 1, "findReferences")];
  assert.equal(assessReviewEvidence({ status: "verified", calls: mixedEdges }, multi, "/tmp/ws", multiChain).pathsRead.length, 3);
  const direct = [...calls, read("/tmp/ws/final.js"), ...edge("/tmp/ws/start.js", "/tmp/ws/final.js")];
  assert.equal(assessReviewEvidence({ status: "verified", calls: direct }, multi, "/tmp/ws", [chain[0], multiChain[2]]).code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence({ status: "verified", calls: [read("/tmp/ws/other.js")] }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  const namedCalls = [{ name: "read", value: { path: "/tmp/ws/start.js", lines: [{ number: 1, text: "startReview()" }] } },
    { name: "read", value: { path: "/tmp/ws/end.js", lines: [{ number: 1, text: "finishReview()" }] } }, ...edge("/tmp/ws/start.js", "/tmp/ws/end.js")];
  assert.equal(assessReviewEvidence({ status: "verified", calls: namedCalls }, "核对 startReview 到 finishReview 的问题", "/tmp/ws", chain).pathsRead.length, 2);
  const material = { name: "read", value: { path: "/tmp/ws/spec.md", lines: [{ number: 1, text: "startReview 调用 finishReview" }] } };
  assert.equal(assessReviewEvidence({ status: "verified", calls: [...namedCalls, material] }, "按 /tmp/ws/spec.md 修复代码", "/tmp/ws", chain).pathsRead.length, 3);
});

test("non-code materials must be explicitly named and actually read", () => {
  const report = { status: "verified", calls: [read("/tmp/ws/brief.txt")] };
  assert.deepEqual(assessReviewEvidence(report, "审阅材料 /tmp/ws/brief.txt", "/tmp/ws", [], "非代码范围：仅处理非代码材料").pathsRead, ["/tmp/ws/brief.txt"]);
  assert.equal(assessReviewEvidence(report, "审阅材料", "/tmp/ws").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, "审阅代码 /tmp/ws/brief.txt", "/tmp/ws").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, "做个站点 /tmp/ws/brief.txt", "/tmp/ws").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, "执行 /tmp/ws/brief.txt", "/tmp/ws").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, "审阅材料 /tmp/ws/brief.txt.bak", "/tmp/ws").code, "EVIDENCE_INSUFFICIENT");
});

test("code nodes bind one-based UTF-16 queries to half-open LSP ranges", () => {
  const from = "/tmp/ws/a.ts";
  const to = "/tmp/ws/b.ts";
  // The emoji occupies two UTF-16 units, so x begins at one-based character 3.
  const reads = [from, to].map(path => ({ name: "read", value: { path, lines: [{ number: 1, text: "😀xy" }] } }));
  const chain = [{ path: from, line: 1, character: 3 }, { path: to, line: 1, character: 3 }];
  const definition = lsp(from, to, 1, "goToDefinition", 1, 3, 3);
  const reference = lsp(to, from, 1, "findReferences", 1, 3, 3);
  const contract = `修复代码 ${from} 和 ${to}`;
  const assess = calls => assessReviewEvidence({ status: "verified", calls: [...reads, ...calls] }, contract, "/tmp/ws", chain);
  assert.equal(assess([definition, reference]).pathsRead.length, 2);
  const excludedEnd = structuredClone(definition);
  excludedEnd.value.locations[0].range = { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } };
  assert.equal(assess([excludedEnd, reference]).code, "EVIDENCE_INSUFFICIENT");
  const missingEnd = structuredClone(definition);
  delete missingEnd.value.locations[0].range.end;
  assert.equal(assess([missingEnd, reference]).code, "EVIDENCE_INSUFFICIENT");
  const emptyRange = structuredClone(definition);
  emptyRange.value.locations[0].range.end = { line: 0, character: 2 };
  assert.equal(assess([emptyRange, reference]).code, "EVIDENCE_INSUFFICIENT");
});

test("a symbol's own definition and references cannot invent a self-edge", () => {
  const source = "/tmp/ws/self.ts";
  const calls = [read(source), lsp(source, source), lsp(source, source, 1, "findReferences")];
  const node = { path: source, line: 1, character: 1 };
  const result = assessReviewEvidence({ status: "verified", calls }, `修复代码 ${source}`, "/tmp/ws", [node, { ...node }]);
  assert.equal(result.code, "EVIDENCE_INSUFFICIENT");
});

test("different columns within one symbol do not form a self-edge, while separate same-file symbols can", () => {
  const source = "/tmp/ws/same.ts";
  const from = { path: source, line: 1, character: 1 };
  const to = { path: source, line: 1, character: 2 };
  const definition = lsp(source, source, 1, "goToDefinition", 1, 1, 1);
  const reference = lsp(source, source, 1, "findReferences", 1, 2, 1);
  definition.value.locations[0].range.end.character = 3;
  reference.value.locations[0].range.end.character = 3;
  const report = { status: "verified", calls: [read(source), definition, reference] };
  const contract = `修复代码 ${source}`;
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", [from, to]).code, "EVIDENCE_INSUFFICIENT");
  definition.value.locations[0].range = { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } };
  reference.value.locations[0].range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  assert.deepEqual(assessReviewEvidence(report, contract, "/tmp/ws", [from, to]).pathsRead, [source]);
});

test("a multi-line LSP target requires the actual node line to be read", () => {
  const from = "/tmp/ws/a.ts";
  const to = "/tmp/ws/b.ts";
  const chain = [{ path: from, line: 1, character: 1 }, { path: to, line: 2, character: 2 }];
  const definition = lsp(from, to, 1, "goToDefinition");
  definition.value.locations[0].range = { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } };
  const reference = lsp(to, from, 2, "findReferences", 1, 2);
  const contract = `修复代码 ${from} 和 ${to}`;
  const calls = [read(from), read(to, 2), definition, reference];
  assert.equal(assessReviewEvidence({ status: "verified", calls }, contract, "/tmp/ws", chain).pathsRead.length, 2);
  // Reading only the range's start line does not establish a read of the target node.
  calls[1] = read(to, 1);
  assert.equal(assessReviewEvidence({ status: "verified", calls }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
});

test("a programming-language implementation in a document cannot bypass source and LSP evidence", () => {
  const report = { status: "verified", calls: [read("/tmp/ws/brief.txt")] };
  for (const task of ["审阅文档 /tmp/ws/brief.txt 中的 Python 实现", "审核材料 /tmp/ws/brief.txt 中 Java 方案",
    "审阅 /tmp/ws/brief.txt 的 Golang 实现", "review the Rust implementation in document /tmp/ws/brief.txt",
    "审阅文档 /tmp/ws/brief.txt 与 /tmp/ws/server.py", "审阅材料 /tmp/ws/brief.txt 中 Zig 方案"]) {
    assert.equal(assessReviewEvidence(report, task, "/tmp/ws", []).code, "EVIDENCE_INSUFFICIENT", task);
  }
});

test("model-authored non-code claims cannot replace an explicit user declaration", () => {
  const report = { status: "verified", calls: [read("/tmp/ws/brief.txt")] };
  const contract = "非代码范围：仅处理非代码材料\n审阅材料 /tmp/ws/brief.txt";
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", [], "请审阅材料").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, "审阅材料 /tmp/ws/brief.txt", "/tmp/ws", [], "请审阅材料").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", [], "> 非代码范围：仅处理非代码材料").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", [], "```\n非代码范围：仅处理非代码材料\n```").code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", [], "非代码范围：仅处理非代码材料\n请修复 Python 实现").code, "EVIDENCE_INSUFFICIENT");
  assert.deepEqual(assessReviewEvidence(report, contract, "/tmp/ws", [], "非代码范围：仅处理非代码材料").pathsRead, ["/tmp/ws/brief.txt"]);
});

function mockedAttempt({ report = { status: "verified", calls: [read("/tmp/ws/brief.txt")] }, dispose = async () => {}, result,
  inspect = (_activation, _evidence) => report } = {}) {
  const definition = { name: "read" };
  const controller = new AbortController();
  const activation = { evidence: {}, result: result ?? Promise.resolve({ stopReason: "completed", structured: {
    passed: true, issues: [], suggestions: [], pathsRead: ["invented"], reviewChain: [] } }), dispose };
  let spec;
  return { controller, activation, get spec() { return spec; }, options: { controller, parent: {}, cwd: "/tmp/ws", contract: "审阅材料 /tmp/ws/brief.txt",
    reviewer: { provider: "p", model: "m" }, draft: { lastUserText: "非代码范围：仅处理非代码材料" }, tools: { get: name => name === "read" ? definition : undefined },
    loadEvidenceApi: async () => ({ inspectReviewEvidence: inspect }), subagents: { startLockedActivation: async value => { spec = value; return activation; } } } };
}

test("locked review uses Host verified records, never model-reported paths", async () => {
  const run = mockedAttempt();
  const result = await runReviewAttempt(run.options);
  assert.equal(result.passed, true);
  assert.deepEqual(result.pathsRead, ["/tmp/ws/brief.txt"]);
  assert.equal(run.spec.trustedReview, true);
  assert.equal(run.spec.request.outputSchema.type, "object");
  assert.deepEqual(run.spec.expectedRoute, { provider: "p", model: "m", reasoningEffort: null });
});

test("only a recognized LSP enters locked review and missing LSP permits explicit non-code scope only", async () => {
  const legacy = { name: "lsp" };
  const nonCode = mockedAttempt();
  const getRead = nonCode.options.tools.get;
  nonCode.options.tools.get = name => name === "lsp" ? legacy : getRead(name);
  nonCode.options.loadLspApi = async () => ({});
  assert.equal((await runReviewAttempt(nonCode.options)).passed, true);
  assert.deepEqual(nonCode.spec.tools.map(tool => tool.name), ["read"]);

  const code = mockedAttempt();
  const codeRead = code.options.tools.get;
  code.options.tools.get = name => name === "lsp" ? legacy : codeRead(name);
  code.options.loadLspApi = async () => ({});
  code.options.contract = "修复代码 /tmp/ws/main.js";
  assert.equal((await runReviewAttempt(code.options)).code, "READ_ONLY_UNAVAILABLE");
  assert.equal(code.spec, undefined);

  const unknown = mockedAttempt();
  unknown.options.draft.lastUserText = "审阅材料";
  assert.equal((await runReviewAttempt(unknown.options)).code, "READ_ONLY_UNAVAILABLE");
  assert.equal(unknown.spec, undefined);

  const recognized = mockedAttempt();
  const recognizedRead = recognized.options.tools.get;
  recognized.options.tools.get = name => name === "lsp" ? legacy : recognizedRead(name);
  recognized.options.loadLspApi = async () => ({ isReviewLspDefinition: value => value === legacy });
  await runReviewAttempt(recognized.options);
  assert.deepEqual(recognized.spec.tools.map(tool => tool.name), ["read", "lsp"]);
});

test("missing, partial or rejected seals and teardown failures cannot pass", async () => {
  for (const options of [
    { report: { status: "partial", calls: [read("/tmp/ws/brief.txt")] } },
    { inspect: () => { throw new Error("bad seal"); } },
    { dispose: async () => { throw new Error("cleanup failed"); } },
  ]) {
    const run = mockedAttempt(options);
    const result = await runReviewAttempt(run.options);
    assert.equal(result.failed, true);
    assert.notEqual(result.passed, true);
  }
  const unboundLsp = mockedAttempt({ inspect: () => { throw new Error("review LSP source and target snapshots are not bound to the query"); } });
  assert.equal((await runReviewAttempt(unboundLsp.options)).code, "EVIDENCE_INSUFFICIENT");
  const noApi = mockedAttempt();
  noApi.options.loadEvidenceApi = async () => ({});
  assert.equal((await runReviewAttempt(noApi.options)).code, "READ_ONLY_UNAVAILABLE");
  assert.equal(noApi.spec, undefined);
});

test("cancellation disposes the exact activation before reporting cleanup confirmed", async () => {
  let resolveResult;
  let cleaned = false;
  let confirmed = false;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const run = mockedAttempt({ result, dispose: async () => { cleaned = true; resolveResult({ stopReason: "aborted" }); } });
  run.options.onCleanupConfirmed = () => { assert.equal(cleaned, true); confirmed = true; };
  const pending = runReviewAttempt(run.options);
  while (!run.spec) await Promise.resolve();
  run.controller.abort(Object.assign(new Error("timeout"), { code: "TIMEOUT" }));
  assert.equal((await pending).code, "TIMEOUT");
  assert.equal(confirmed, true);
});

test("Host-observed forbidden write is classified without accepting partial evidence", async () => {
  const run = mockedAttempt({ result: Promise.resolve({ stopReason: "error" }) });
  run.options.loadEvidenceApi = async () => ({ inspectReviewEvidence: () => { throw new Error("incomplete"); },
    inspectReviewFailure: () => ({ code: "WRITE_TOOL" }) });
  assert.equal((await runReviewAttempt(run.options)).code, "WRITE_TOOL");
});
