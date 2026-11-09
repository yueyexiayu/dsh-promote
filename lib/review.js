import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { REVIEW_SCHEMA, TIMEOUT_MS } from "./constants.js";
import { buildReviewPrompt } from "./prompt.js";
import { toolSummary } from "./projection.js";

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|sql|vue|svelte|zig|lua|exs?|erl|scala|dart|pl|r|mm?)$/i;
const STRUCTURED_FILE = /\.(?:json|ya?ml|toml|html?|css)$/i;
const MATERIAL_FILE = /\.(?:md|txt|csv|tsv)$/i;
const CODE_TASK = /(?:源码|代码|编程|程序|软件|插件|函数|调用链|接口|配置|服务|构建|部署|重构|单测|测试|脚本|数据库|网站|站点|界面|功能|安装|修复|实现|开发|算法|仓库|\b(?:code|source|api|plugin|function|test|build|deploy|config|website|web|ui|implement(?:ation)?|develop(?:ment)?|program(?:ming)?|algorithm|repository|python|java|javascript|typescript|golang|rust|swift|kotlin|scala|php|ruby|perl|bash|powershell|sql|html|css|react|vue|nodejs|zig|lua|elixir|erlang|dart)\b|\bc(?:\+\+|#)(?![\w+]))/i;
const SOURCE_INTENT = /(?:源码|调用链|函数|编程|重构|单测|脚本|算法|\b(?:code|source|function|call chain|implement(?:ation)?|develop(?:ment)?|program(?:ming)?|algorithm|repository|python|java|javascript|typescript|golang|rust|swift|kotlin|scala|php|ruby|perl|bash|powershell|sql|react|vue|nodejs|zig|lua|elixir|erlang|dart)\b|\bc(?:\+\+|#)(?![\w+]))/i;
const POSITIVE_SOURCE_TASK = /(?:(?:修复|实现|开发|重构|编写|修改|添加|删除|更新|排查|调试|运行|执行)[^\n。；;]{0,24}(?:源码|代码|函数|脚本|插件|接口|调用链)|(?:源码|代码|函数|脚本|插件|接口|调用链)[^\n。；;]{0,24}(?:修复|实现|开发|重构|编写|修改|添加|删除|更新|排查|调试))/i;
const MATERIAL_TASK = /(?:材料|文稿|文档|文章|文本|报告|合同|翻译|润色|校对|摘要|总结|\b(?:document|material|article|translate|summarize|proofread)\b)/i;
const NONCODE_DECLARATION = /^(?:非代码范围[：:]\s*仅处理非代码材料|本任务仅处理非代码材料|non-code scope:\s*non-code materials only)[。.]?$/i;

function fail(code, reason) { return { failed: true, code, reason }; }

function abortResult(signal) {
  const code = signal?.reason?.code ?? "ABORTED";
  const reason = code === "TIMEOUT" ? "审核超时" : code === "WRITE_TOOL" ? "审核子代理调用了禁止写入的工具"
    : code === "STALE" ? "出现新版本，旧审核已取消" : code === "DISPOSED" ? "审核资源已销毁" : "审核已取消";
  return fail(code, reason);
}

function containsPath(contract, path, cwd) {
  const rel = relative(cwd, path);
  const candidates = [path, ...(!rel.startsWith("..") && !isAbsolute(rel) && rel ? [rel] : [])];
  return candidates.some(candidate => {
    let at = -1;
    while ((at = contract.indexOf(candidate, at + 1)) !== -1) {
      const before = contract[at - 1] ?? "";
      const after = contract[at + candidate.length] ?? "";
      if (!/[\w./\\-]/.test(before) && !/[\w./\\-]/.test(after)) return true;
    }
    return false;
  });
}

function withinWorkspace(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sourcePath(uri) {
  try { return typeof uri === "string" && uri.startsWith("file:") ? fileURLToPath(uri) : null; } catch { return null; }
}

function covers(read, line) {
  return Number.isSafeInteger(line) && line > 0 && read.lines.some(row => row?.number === line);
}

// LSP locations use zero-based UTF-16 coordinates and a half-open range.
function containsPosition(range, node) {
  const start = range?.start;
  const end = range?.end;
  if (![start?.line, start?.character, end?.line, end?.character].every(Number.isSafeInteger)
    || start.line < 0 || start.character < 0 || end.line < 0 || end.character < 0) return false;
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.character < b.character);
  const point = { line: node.line - 1, character: node.character - 1 };
  return before(start, end) && !before(point, start) && before(point, end);
}

function symbols(text) {
  return [...new Set(String(text ?? "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])];
}

function userDeclaredNonCode(text) {
  if (typeof text !== "string") return false;
  let fence = null;
  let declared = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (fence === marker[0]) fence = null;
      continue;
    }
    if (!fence && !trimmed.startsWith(">") && NONCODE_DECLARATION.test(trimmed)) declared = true;
  }
  return declared;
}

function withoutDeclarations(text) {
  return String(text ?? "").split(/\r?\n/).filter(line => !NONCODE_DECLARATION.test(line.trim())).join("\n");
}

function nonCodeTask(contract, userText) {
  const contractText = withoutDeclarations(contract);
  const userTextWithoutDeclarations = withoutDeclarations(userText);
  const namedFiles = String(contract ?? "").match(/[\w./\\-]+\.[a-z][a-z0-9]*/gi) ?? [];
  const materialTask = MATERIAL_TASK.test(contractText) || MATERIAL_TASK.test(userTextWithoutDeclarations);
  return userDeclaredNonCode(userText) && materialTask
    && !POSITIVE_SOURCE_TASK.test(contractText) && !SOURCE_INTENT.test(userTextWithoutDeclarations)
    && !namedFiles.some(path => SOURCE_FILE.test(path));
}

function structuredFileTask(contract, userText) {
  const namedFiles = String(contract ?? "").match(/[\w./\\-]+\.[a-z][a-z0-9]*/gi) ?? [];
  return namedFiles.some(path => STRUCTURED_FILE.test(path))
    && !namedFiles.some(path => SOURCE_FILE.test(path))
    && !POSITIVE_SOURCE_TASK.test(withoutDeclarations(contract))
    && !SOURCE_INTENT.test(withoutDeclarations(userText));
}

function matchesDeclaredChains(contract, cwd, chain, reads) {
  const clauses = contract.split(/[\n。；;]/).filter(part => /(?:调用链|call chain)/i.test(part) && /(?:->|→)/.test(part));
  for (const clause of clauses) {
    const parts = clause.split(/(?:->|→)/);
    const hasNamedNode = parts.some(part => symbols(part).length > 0 || /\.[a-z][a-z0-9]{0,8}\b/i.test(part));
    if (!hasNamedNode) continue;
    if (parts.length !== chain.length) return false;
    for (let i = 0; i < parts.length; i++) {
      const node = chain[i];
      const line = reads.flatMap(read => read.path === node.path ? read.lines : []).find(row => row?.number === node.line);
      const named = new Set(symbols(parts[i]));
      if (!containsPath(parts[i], node.path, cwd)
        && !(typeof line?.text === "string" && symbols(line.text).some(symbol => named.has(symbol)))) return false;
    }
  }
  return true;
}

/** Apply conservative scope and source-chain checks to Host-verified calls only. */
export function assessReviewEvidence(report, contract, cwd, claimedChain = [], userText = "") {
  if (report?.status !== "verified" || !Array.isArray(report.calls) || typeof contract !== "string" || !isAbsolute(cwd ?? "")) {
    return fail("EVIDENCE_INSUFFICIENT", "Host 未提供完整审核证据或任务根不可确认。");
  }
  const root = resolve(cwd);
  const reportedReads = report.calls.filter(call => call?.name === "read").map(call => call.value)
    .filter(value => value && typeof value.path === "string" && isAbsolute(value.path)
      && Array.isArray(value.lines) && value.lines.length > 0);
  if (reportedReads.some(value => !withinWorkspace(root, value.path))) {
    return fail("WORKSPACE_ESCAPE", "审核读取了任务根之外的文件，结果已拒绝。");
  }
  const reads = reportedReads;
  if (!reads.length) return fail("EVIDENCE_INSUFFICIENT", "未核验实际材料。");
  const mentionedFiles = contract.match(/[\w./\\-]+\.[a-z][a-z0-9]*/gi) ?? [];
  const contractWithoutDeclarations = withoutDeclarations(contract);
  const userWithoutDeclarations = withoutDeclarations(userText);
  const sourceIntent = POSITIVE_SOURCE_TASK.test(contractWithoutDeclarations) || SOURCE_INTENT.test(userWithoutDeclarations);
  const sourceNamed = mentionedFiles.some(path => SOURCE_FILE.test(path));
  const structuredNamed = mentionedFiles.some(path => STRUCTURED_FILE.test(path));
  const sourceRead = reads.some(value => SOURCE_FILE.test(value.path));
  const structuredRead = reads.some(value => STRUCTURED_FILE.test(value.path) && containsPath(contract, value.path, root));
  const nonCode = nonCodeTask(contract, userText) && !sourceIntent && !sourceRead
    && (!Array.isArray(claimedChain) || claimedChain.length === 0);
  const code = !nonCode && (CODE_TASK.test(contractWithoutDeclarations) || CODE_TASK.test(userWithoutDeclarations)
    || sourceNamed || structuredNamed || sourceRead || structuredRead
    || (Array.isArray(claimedChain) && claimedChain.length > 0));
  if (!code && (!userDeclaredNonCode(userText) || !MATERIAL_TASK.test(contractWithoutDeclarations)
    || !reads.some(value => MATERIAL_FILE.test(value.path) && containsPath(contract, value.path, cwd)))) {
    return fail("EVIDENCE_INSUFFICIENT", "缺少用户明确的非代码范围声明，或无法核验实际材料。");
  }
  if (code) {
    const sourceReads = reads.filter(value => SOURCE_FILE.test(value.path));
    const requiresChain = sourceIntent || sourceNamed || sourceReads.length > 0
      || (Array.isArray(claimedChain) && claimedChain.length > 0);
    if (!requiresChain) {
      if (!structuredRead) {
        return fail("EVIDENCE_INSUFFICIENT", "配置或结构化文件任务未实际读取契约点名的文件。");
      }
      return { pathsRead: [...new Set(reads.map(value => value.path))] };
    }
    if (!Array.isArray(claimedChain) || claimedChain.length < 2 || claimedChain.length > 128
      || claimedChain.some(node => typeof node?.path !== "string" || !node.path || !Number.isSafeInteger(node.line) || node.line < 1
        || !Number.isSafeInteger(node.character) || node.character < 1
        || (node.callSite !== undefined && (!node.callSite || !Number.isSafeInteger(node.callSite.line) || node.callSite.line < 1
          || !Number.isSafeInteger(node.callSite.character) || node.callSite.character < 1)))) {
      return fail("EVIDENCE_INSUFFICIENT", "审核未提出可核查的完整调用链。");
    }
    const chain = claimedChain.map(node => ({ path: resolve(root, node.path), line: node.line, character: node.character,
      ...(node.callSite === undefined ? {} : { callSite: { path: resolve(root, node.path), line: node.callSite.line, character: node.callSite.character } }) }));
    if (chain.some(node => !withinWorkspace(root, node.path) || !withinWorkspace(root, node.callSite?.path ?? node.path))) {
      return fail("WORKSPACE_ESCAPE", "审核调用链包含任务根之外的文件，结果已拒绝。");
    }
    if (chain.at(-1).callSite !== undefined) {
      return fail("EVIDENCE_INSUFFICIENT", "调用链末节点不能包含未核验的后续调用点。");
    }
    if (chain.slice(1, -1).some(node => !node.callSite
      || (node.line === node.callSite.line && node.character === node.callSite.character))) {
      return fail("EVIDENCE_INSUFFICIENT", "多跳调用链的中间节点必须提供独立的函数体内调用点。");
    }
    if (chain.slice(1).some((node, index) => node.path === chain[index].path
      && node.line === chain[index].line && node.character === chain[index].character)) {
      return fail("EVIDENCE_INSUFFICIENT", "调用链相邻节点不能是同一源码位置。");
    }
    if (!matchesDeclaredChains(contract, cwd, chain, sourceReads)) {
      return fail("EVIDENCE_INSUFFICIENT", "审核调用链遗漏或替换了契约明确列出的节点。");
    }
    const independentMaterials = reads.filter(read => MATERIAL_FILE.test(read.path) && containsPath(contract, read.path, cwd));
    const anchorText = [contract, ...independentMaterials.flatMap(read => read.lines.map(row => row?.text ?? ""))].join("\n");
    const anchorSymbols = new Set(symbols(anchorText));
    const anchored = node => sourceReads.some(read => read.path === node.path && covers(read, node.line)
      && (containsPath(anchorText, node.path, cwd) || read.lines.some(row => row.number === node.line && typeof row.text === "string"
        && symbols(row.text).some(symbol => anchorSymbols.has(symbol)))));
    if (!anchored(chain[0]) || !anchored(chain.at(-1))) {
      return fail("EVIDENCE_INSUFFICIENT", "无法从契约或已核验材料独立确认调用链起点与落点。");
    }
    const ownerMatches = (node, from, call) => {
      if (node.line === from.line && node.character === from.character) return true;
      const owner = call?.value?.reviewProof?.sourceOwner;
      return sourceReads.some(read => read.path === node.path && covers(read, node.line))
        && sourceReads.some(read => read.path === node.path && covers(read, from.line))
        && owner?.path === node.path && containsPosition(owner.range, node);
    };
    const locatesInCall = (call, operation, from, to, ownerNode = from) => {
      const args = call?.arguments;
      const value = call?.value;
      if (call?.name !== "lsp" || args?.operation !== operation || value?.kind !== "locations"
        || sourcePath(value.reviewSourceUri) !== from.path || from.line !== args.line || from.character !== args.character
        || !sourceReads.some(read => read.path === from.path && covers(read, args.line)) || !Array.isArray(value.locations)
        || ((operation === "goToDefinition" || operation === "goToImplementation") && value?.reviewProof?.sourceIsCall !== true)
        || !ownerMatches(ownerNode, from, call)) return false;
      return value.locations.some(location => {
        const line = location?.range?.start?.line;
        return Number.isSafeInteger(line) && sourcePath(location?.uri) === to.path
          && containsPosition(location?.range, to)
          && !(from.path === to.path && containsPosition(location?.range, from))
          && sourceReads.some(read => read.path === to.path && covers(read, to.line));
      });
    };
    const locates = (operation, from, to, ownerNode = from) => report.calls.some(call => locatesInCall(call, operation, from, to, ownerNode));
    // An inline callback is not the callee named by a normal LSP definition.
    // Only a same-query Host proof can connect its registration to a receiver
    // that directly invokes the matching parameter. This is a static edge.
    const callbackEdge = (operation, node, from, to, requireReference = false) => report.calls.some(call => {
      if (from.path !== to.path || !sourceReads.some(read => read.path === to.path && covers(read, to.line))) return false;
      const callbacks = call?.value?.reviewProof?.callbacks;
      if (!Array.isArray(callbacks)) return false;
      return callbacks.some(callback => {
        const receiver = callback?.receiver, invocation = callback?.invocation;
        const start = receiver?.range?.start, invoked = invocation?.range?.start;
        if (typeof receiver?.path !== "string" || invocation?.path !== receiver.path
          || !Number.isSafeInteger(start?.line) || !Number.isSafeInteger(start?.character)
          || !Number.isSafeInteger(invoked?.line) || !Number.isSafeInteger(invoked?.character)
          || !containsPosition(callback?.range, to)) return false;
        const target = { path: receiver.path, line: start.line + 1, character: start.character + 1 };
        const use = { path: invocation.path, line: invoked.line + 1, character: invoked.character + 1 };
        return containsPosition(receiver.range, target) && containsPosition(invocation.range, use)
          && sourceReads.some(read => read.path === target.path && covers(read, target.line))
          && sourceReads.some(read => read.path === use.path && covers(read, use.line))
          && locatesInCall(call, operation, from, target, node)
          && (!requireReference || locates("findReferences", target, from)
            || locates("findReferences", from, target, node));
      });
    });
    const edges = chain.slice(1).map((to, index) => {
      const node = chain[index];
      const from = node.callSite ?? node;
      const definition = locates("goToDefinition", from, to, node) || callbackEdge("goToDefinition", node, from, to);
      const forwardReference = locates("findReferences", from, to, node);
      const reference = locates("findReferences", to, from) || forwardReference
        || callbackEdge("goToDefinition", node, from, to, true)
        || callbackEdge("goToImplementation", node, from, to, true);
      const implementation = locates("goToImplementation", from, to, node) || callbackEdge("goToImplementation", node, from, to);
      const requiresOwner = node.line !== from.line || node.character !== from.character;
      const ownerBound = !requiresOwner || definition || implementation;
      return { definition, reference, implementation, ownerBound };
    });
    if (!edges.every(edge => edge.ownerBound && (edge.definition || edge.implementation))
      || !edges.some(edge => edge.definition) || !edges.some(edge => edge.reference)) {
      return fail("EVIDENCE_INSUFFICIENT", "无法通过定义和引用查询确认调用链的全部必要边，或相关源码未读取。");
    }
  }
  return { pathsRead: [...new Set(reads.map(value => value.path))] };
}

function normalizeStructured(value) {
  if (!value || typeof value !== "object" || typeof value.passed !== "boolean"
    || !Array.isArray(value.issues) || !Array.isArray(value.suggestions) || !Array.isArray(value.pathsRead)
    || !Array.isArray(value.reviewChain)) return null;
  return { passed: value.passed, issues: value.issues, suggestions: value.suggestions, reviewChain: value.reviewChain };
}

function blocksPass(issue) {
  const severity = typeof issue?.severity === "string" ? issue.severity.trim() : "";
  const summary = typeof issue?.summary === "string" ? issue.summary.trim() : "";
  return /^(?:blocker|critical|high|fatal|error|阻断|严重|高)$/i.test(severity)
    || /^(?:blocker|critical|fatal|阻断级?|严重问题?)[:：\s]/i.test(summary);
}

/** Start only after the Host's trusted-review capability is available. */
export async function runReviewAttempt({ controller = new AbortController(), subagents, tools, loadEvidenceApi, loadLspApi,
  parent, cwd, contract, reviewer, draft, timeoutMs = TIMEOUT_MS, onCleanupConfirmed, onCleanupFailed } = {}) {
  if (controller.signal.aborted) return abortResult(controller.signal);
  if (timeoutMs < TIMEOUT_MS) return fail("INVALID_TIMEOUT", "审核超时不得少于 1200 秒。");
  if (typeof subagents?.startLockedActivation !== "function" || typeof tools?.get !== "function" || typeof loadEvidenceApi !== "function") {
    return fail("READ_ONLY_UNAVAILABLE", "无法确认审核子代理启动前已强制只读，已阻止启动。");
  }
  let api;
  try { api = await loadEvidenceApi(); } catch { return fail("READ_ONLY_UNAVAILABLE", "Host 可信审核证据接口不可用。"); }
  if (controller.signal.aborted) return abortResult(controller.signal);
  if (typeof api?.inspectReviewEvidence !== "function") return fail("READ_ONLY_UNAVAILABLE", "Host 可信审核证据接口不可用。");
  let read;
  let lsp;
  try { read = tools.get("read", parent); lsp = tools.get("lsp", parent); }
  catch { return fail("READ_ONLY_UNAVAILABLE", "无法取得 Host 的只读工具定义。"); }
  if (!read) return fail("READ_ONLY_UNAVAILABLE", "Host 未提供可审核的只读材料工具。");
  let trustedLsp = false;
  if (lsp && typeof loadLspApi === "function") {
    try { trustedLsp = (await loadLspApi())?.isReviewLspDefinition?.(lsp) === true; } catch { /* Host will not receive an unverified tool. */ }
  }
  if (controller.signal.aborted) return abortResult(controller.signal);
  const userText = draft?.lastUserText ?? "";
  const nonCode = nonCodeTask(contract, userText);
  if (!trustedLsp && !nonCode && !structuredFileTask(contract, userText)) {
    return fail("READ_ONLY_UNAVAILABLE", "Host 未提供可信 LSP，无法审核代码或未明确声明为非代码的任务。");
  }
  const prompt = buildReviewPrompt({ contract, provider: "spawn", cwd, userText: draft?.lastUserText ?? "", tools: toolSummary(draft), reviewer });
  let activation;
  let disposal;
  let onAbort;
  let outcome;
  let error;
  try {
    activation = await subagents.startLockedActivation({ label: "promote-review", trustedReview: true,
      request: { parent, cwd, prompt: [{ type: "text", text: prompt }], outputSchema: REVIEW_SCHEMA },
      expectedRoute: { provider: reviewer.provider, model: reviewer.model, reasoningEffort: reviewer.reasoningEffort ?? null },
      signal: controller.signal, tools: trustedLsp ? [read, lsp] : [read] });
    if (!activation || typeof activation.dispose !== "function" || !activation.result || !activation.evidence) throw new Error("invalid activation");
    const dispose = () => { disposal ??= Promise.resolve().then(() => activation.dispose()); return disposal; };
    onAbort = () => { void dispose().catch(() => {}); };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    try { outcome = await activation.result; } catch (caught) { error = caught; }
    try { await dispose(); } catch {
      onCleanupFailed?.();
      return fail("CLEANUP_FAILED", "审核子任务清理失败，无法确认已结束。");
    }
    if (error?.code === "ACTIVATION_TEARDOWN_FAILED") {
      onCleanupFailed?.();
      return fail("CLEANUP_FAILED", "审核子任务清理失败，无法确认已结束。");
    }
    if (controller.signal.aborted) {
      onCleanupConfirmed?.();
      return abortResult(controller.signal);
    }
    try {
      const failure = api.inspectReviewFailure?.(activation, activation.evidence);
      if (failure?.code === "WRITE_TOOL") {
        return fail("WRITE_TOOL", "审核子代理尝试调用禁止写入的工具，本轮失败。");
      }
      if (failure?.code === "FS_WORKSPACE_ESCAPE" || error?.code === "FS_WORKSPACE_ESCAPE") {
        return fail("WORKSPACE_ESCAPE", "审核读取了任务根之外的文件（WORKSPACE_ESCAPE），结果已拒绝。");
      }
    } catch { /* Failure classification cannot establish success. */ }
    if (error) return fail(error?.code === "ACTIVATION_TEARDOWN_FAILED" ? "CLEANUP_FAILED" : "REVIEW_FAILED", "审核子任务异常结束。");
    if (outcome?.stopReason !== "completed") return fail("REVIEW_FAILED", `审核子任务异常结束：${outcome?.stopReason ?? "unknown"}`);
    let report;
    try { report = api.inspectReviewEvidence(activation, activation.evidence); }
    catch { return fail("EVIDENCE_INSUFFICIENT", "Host 无法确认完整审核证据。"); }
    const structured = normalizeStructured(outcome.structured);
    if (!structured) return fail("INVALID_OUTPUT", "审核未返回有效结构化结果。");
    if (structured.passed && structured.issues.some(blocksPass)) {
      return fail("INVALID_OUTPUT", "审核报告声称通过但仍列出阻断级问题，结果已拒绝。");
    }
    const evidenceCwd = isAbsolute(cwd ?? "") ? await realpath(cwd).catch(() => resolve(cwd)) : cwd;
    const evidence = assessReviewEvidence(report, contract, evidenceCwd, structured.reviewChain, draft?.lastUserText);
    if (evidence.failed) return evidence;
    const { reviewChain: _reviewChain, ...result } = structured;
    return { provider: "locked-spawn", ...result, pathsRead: evidence.pathsRead };
  } catch (caught) {
    if (activation) {
      try {
        if (typeof activation.dispose !== "function") throw new Error("missing disposal");
        disposal ??= Promise.resolve().then(() => activation.dispose());
        await disposal;
      } catch {
        onCleanupFailed?.();
        return fail("CLEANUP_FAILED", "审核子任务清理失败，无法确认已结束。");
      }
      if (controller.signal.aborted) onCleanupConfirmed?.();
    }
    if (controller.signal.aborted && !activation && caught?.code !== "ACTIVATION_TEARDOWN_FAILED") return abortResult(controller.signal);
    return fail(caught?.code === "ACTIVATION_TEARDOWN_FAILED" ? "CLEANUP_FAILED" : "READ_ONLY_UNAVAILABLE", "无法启动受信任的只读审核。");
  } finally {
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
