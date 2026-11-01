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
    ...(["goToDefinition", "goToImplementation"].includes(operation) ? { reviewProof: { sourceIsCall: true } } : {}),
    locations: [{ uri: pathToFileURL(target).href, range: { start: { line: targetLine - 1, character: targetCharacter - 1 },
      end: { line: targetLine - 1, character: targetCharacter } } }] } });
const edge = (from, to) => [lsp(from, to), lsp(to, from, 1, "findReferences")];

test("code evidence needs declared actual source reads and a linked nonempty LSP result", () => {
  const contract = "修复代码 /tmp/ws/start.js 和 /tmp/ws/end.js";
  const calls = [read("/tmp/ws/start.js"), read("/tmp/ws/end.js"), ...edge("/tmp/ws/start.js", "/tmp/ws/end.js")];
  const chain = [{ path: "/tmp/ws/start.js", line: 1, character: 1 }, { path: "/tmp/ws/end.js", line: 1, character: 1 }];
  assert.deepEqual(assessReviewEvidence({ status: "verified", calls }, contract, "/tmp/ws", chain).pathsRead, ["/tmp/ws/start.js", "/tmp/ws/end.js"]);
  for (const sourceIsCall of [undefined, false]) {
    const notCall = structuredClone(calls);
    notCall[2].value.reviewProof.sourceIsCall = sourceIsCall;
    assert.equal(assessReviewEvidence({ status: "verified", calls: notCall }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  }
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
  // A middle declaration alone does not identify the call it makes to the next function.
  assert.equal(assessReviewEvidence({ status: "verified", calls: multiCalls }, multi, "/tmp/ws", multiChain).code, "EVIDENCE_INSUFFICIENT");
  const mixedEdges = [read("/tmp/ws/start.js"), read("/tmp/ws/end.js"), read("/tmp/ws/final.js"),
    lsp("/tmp/ws/start.js", "/tmp/ws/end.js"), lsp("/tmp/ws/final.js", "/tmp/ws/end.js", 1, "findReferences")];
  assert.equal(assessReviewEvidence({ status: "verified", calls: mixedEdges }, multi, "/tmp/ws", multiChain).code, "EVIDENCE_INSUFFICIENT");
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

test("multi-hop call sites require a Host-verified enclosing declaration", () => {
  const a = "/tmp/ws/a.ts", b = "/tmp/ws/b.ts", c = "/tmp/ws/c.ts";
  const contract = `调用链 ${a} -> ${b} -> ${c}`;
  const chain = [{ path: a, line: 3, character: 3 },
    { path: b, line: 1, character: 17, callSite: { line: 2, character: 3 } },
    { path: c, line: 1, character: 17 }];
  const reads = [read(a, 3), read(b, 1), read(b, 2), read(c, 1)];
  const first = lsp(a, b, 3, "goToDefinition", 1, 3, 17);
  const firstRef = lsp(b, a, 1, "findReferences", 3, 17, 3);
  const second = lsp(b, c, 2, "goToDefinition", 1, 3, 17);
  second.value.reviewProof = { sourceIsCall: true, sourceOwner: { path: b, range: {
    start: { line: 0, character: 16 }, end: { line: 0, character: 20 },
  } } };
  const secondRef = lsp(c, b, 1, "findReferences", 2, 17, 3);
  const report = { status: "verified", calls: [...reads, first, firstRef, second, secondRef] };
  assert.deepEqual(assessReviewEvidence(report, contract, "/tmp/ws", chain).pathsRead, [a, b, c]);

  // Both a.ts and c.ts referencing b.ts does not mean b.ts calls c.ts.
  const commonReference = structuredClone(firstRef);
  commonReference.value.locations.push(lsp(b, c, 1, "findReferences", 1, 17, 17).value.locations[0]);
  const falseChain = [chain[0], { path: b, line: 1, character: 17 }, chain[2]];
  assert.equal(assessReviewEvidence({ status: "verified", calls: [...reads, first, commonReference] }, contract, "/tmp/ws", falseChain).code, "EVIDENCE_INSUFFICIENT");
  // Even a reference query with ownership evidence cannot establish a directed call edge.
  const forwardReferenceOnly = structuredClone(report);
  forwardReferenceOnly.calls[6].arguments.operation = "findReferences";
  assert.equal(assessReviewEvidence(forwardReferenceOnly, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");

  const withoutOwner = structuredClone(report);
  delete withoutOwner.calls[6].value.reviewProof;
  assert.equal(assessReviewEvidence(withoutOwner, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  // Ownership on a separate query cannot be combined with an unowned edge result.
  const separateOwner = structuredClone(withoutOwner);
  const unrelated = structuredClone(second);
  unrelated.value.locations[0].range = { start: { line: 0, character: 29 }, end: { line: 0, character: 30 } };
  separateOwner.calls.push(unrelated);
  assert.equal(assessReviewEvidence(separateOwner, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  const wrongOwner = structuredClone(report);
  wrongOwner.calls[6].value.reviewProof.sourceOwner.range.start.line = 3;
  wrongOwner.calls[6].value.reviewProof.sourceOwner.range.end.line = 3;
  assert.equal(assessReviewEvidence(wrongOwner, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  const wrongFile = structuredClone(report);
  wrongFile.calls[6].value.reviewProof.sourceOwner.path = a;
  assert.equal(assessReviewEvidence(wrongFile, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence({ ...report, calls: report.calls.filter((_, i) => i !== 2) }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  const changedCallSite = structuredClone(chain);
  changedCallSite[1].callSite.character = 4;
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", changedCallSite).code, "EVIDENCE_INSUFFICIENT");
  const invalidCallSite = structuredClone(chain);
  invalidCallSite[1].callSite = { line: 0, character: 3 };
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", invalidCallSite).code, "EVIDENCE_INSUFFICIENT");
  const lastCallSite = structuredClone(chain);
  lastCallSite[2].callSite = { line: 2, character: 3 };
  assert.equal(assessReviewEvidence(report, contract, "/tmp/ws", lastCallSite).code, "EVIDENCE_INSUFFICIENT");
  const nestedOwner = structuredClone(report);
  nestedOwner.calls[6].value.reviewProof.sourceOwner.range = {
    start: { line: 1, character: 0 }, end: { line: 1, character: 4 },
  };
  assert.equal(assessReviewEvidence(nestedOwner, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
  assert.equal(assessReviewEvidence({ ...report, status: "partial" }, contract, "/tmp/ws", chain).code, "EVIDENCE_INSUFFICIENT");
});

test("inline callback edges require same-query receiver and invocation proof", () => {
  const a = "/tmp/ws/app.ts", r = "/tmp/ws/receiver.ts", c = "/tmp/ws/finish.ts";
  const contract = `调用链 ${a} -> ${a} -> ${c}`;
  const chain = [{ path: a, line: 1, character: 1 },
    { path: a, line: 2, character: 3, callSite: { line: 3, character: 3 } },
    { path: c, line: 1, character: 1 }];
  const reads = [read(a, 1), read(a, 2), read(a, 3), read(r, 1), read(r, 2), read(c, 1)];
  const register = lsp(a, r);
  register.value.reviewProof.callbacks = [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
    receiver: { path: r, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    invocation: { path: r, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } } } }];
  const reference = lsp(r, a, 1, "findReferences");
  const finish = lsp(a, c, 3, "goToDefinition", 1, 3);
  finish.value.reviewProof.sourceOwner = { path: a, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } } };
  const calls = [...reads, register, reference, finish];
  const assess = (records, claimed = chain) => assessReviewEvidence({ status: "verified", calls: records }, contract, "/tmp/ws", claimed);
  assert.deepEqual(assess(calls).pathsRead, [a, r, c]);
  for (const mutate of [
    x => { delete x[6].value.reviewProof.callbacks; },
    x => { x[6].value.reviewProof.callbacks[0].receiver.path = c; },
    x => { x[6].value.reviewProof.callbacks[0].invocation.path = c; },
    x => { x[6].value.reviewProof.callbacks[0].range.start.line = 4; },
    x => { x[6].value.reviewProof.callbacks[0].range.start.character = 5; x[6].value.reviewProof.callbacks[0].range.end.character = 7; }, // adjacent callback
    x => { x[6].value.locations[0].range.start.character = 2; },
    x => { x[6].value.reviewProof.sourceIsCall = false; },
    x => { x.splice(4, 1); }, // receiver invocation line not actually read
    x => { delete x[8].value.reviewProof.sourceOwner; },
    x => { x.splice(7, 1); }, // no definition/reference corroboration
  ]) {
    const bad = structuredClone(calls);
    mutate(bad);
    assert.equal(assess(bad).code, "EVIDENCE_INSUFFICIENT");
  }
  const otherCall = structuredClone(calls);
  const proof = otherCall[6].value.reviewProof.callbacks;
  delete otherCall[6].value.reviewProof.callbacks;
  otherCall.push({ ...structuredClone(otherCall[6]), arguments: { ...otherCall[6].arguments, line: 9 },
    value: { ...otherCall[6].value, reviewProof: { sourceIsCall: true, callbacks: proof } } });
  assert.equal(assess(otherCall).code, "EVIDENCE_INSUFFICIENT");
});

test("constructor chains bind the new target and class-owned body call", () => {
  const a = "/tmp/ws/start.ts", b = "/tmp/ws/service.ts", c = "/tmp/ws/done.ts";
  const chain = [{ path: a, line: 1, character: 5 },
    { path: b, line: 1, character: 14, callSite: { line: 3, character: 5 } },
    { path: c, line: 1, character: 1 }];
  const create = lsp(a, b, 1, "goToDefinition", 1, 5, 14);
  const refs = lsp(b, a, 1, "findReferences", 1, 14, 5);
  const invoke = lsp(b, c, 3, "goToDefinition", 1, 5, 1);
  invoke.value.reviewProof.sourceOwner = { path: b, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } } };
  const records = [read(a), read(b), read(b, 3), read(c), create, refs, invoke];
  const assess = calls => assessReviewEvidence({ status: "verified", calls }, `调用链 ${a} -> ${b} -> ${c}`, "/tmp/ws", chain);
  assert.deepEqual(assess(records).pathsRead, [a, b, c]);
  const wrongConstructor = structuredClone(records);
  wrongConstructor[6].value.reviewProof.sourceOwner.range.start.character = 21;
  wrongConstructor[6].value.reviewProof.sourceOwner.range.end.character = 28;
  assert.equal(assess(wrongConstructor).code, "EVIDENCE_INSUFFICIENT");
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
