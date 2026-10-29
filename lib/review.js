import { LSP_CHAIN_OPS, LSP_TOOL, READ_TOOLS, REVIEW_SCHEMA, TIMEOUT_MS, WRITE_TOOLS } from "./constants.js";
import { reviewerOptions } from "./extract.js";
import { buildReviewPrompt } from "./prompt.js";
import { toolSummary } from "./projection.js";

export function normalizeStructured(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.passed !== "boolean") return null;
  return {
    passed: value.passed,
    issues: Array.isArray(value.issues) ? value.issues : [],
    suggestions: Array.isArray(value.suggestions) ? value.suggestions : [],
    pathsRead: Array.isArray(value.pathsRead) ? value.pathsRead.map(String) : [],
  };
}

export function uniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    const path = String(value ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export function toolCallArgs(data) {
  let args = data?.arguments ?? data?.args ?? data?.input;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args;
}

export function toolCallPath(data) {
  const args = toolCallArgs(data);
  if (!args) return null;
  for (const key of ["file_path", "path", "target", "pattern"]) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
  }
  return null;
}

export function lspChainOp(data) {
  const args = toolCallArgs(data);
  const op = typeof args?.operation === "string" ? args.operation : "";
  return LSP_CHAIN_OPS.includes(op) ? op : null;
}

export function interpretResult({ structured, stopReason, wrote, timedOut, aborted, observedPaths, observedLsp }) {
  if (timedOut) return { failed: true, reason: "审核超时（120s）" };
  if (wrote) {
    return {
      failed: true,
      reason: "审核子代理调用了改文件工具，本轮失败。只读沙箱或工具限制未能拦住这次调用。",
    };
  }
  if (aborted) return { failed: true, reason: "审核已取消（出现新版本或会话结束）" };
  if (stopReason && stopReason !== "completed") {
    return { failed: true, reason: `审核子代理异常结束：${stopReason}` };
  }
  const parsed = normalizeStructured(structured);
  if (!parsed) return { failed: true, reason: "审核未返回结构化结果，禁止改无工具审" };
  const pathsRead = uniquePaths([...(observedPaths ?? []), ...parsed.pathsRead]);
  if (parsed.passed && pathsRead.length === 0) {
    return {
      passed: false,
      issues: [{ summary: "未实际阅读工作区源码", detail: "未观察到 read/grep/glob，且 pathsRead 为空，不得只凭契约正文判合格" }],
      suggestions: ["使用 read/grep/glob 打开当前会话工作区相关源码后再审"],
      pathsRead: [],
    };
  }
  const lspOps = Array.isArray(observedLsp) ? observedLsp.filter((op) => LSP_CHAIN_OPS.includes(op)) : null;
  if (parsed.passed && lspOps && lspOps.length === 0) {
    return {
      passed: false,
      issues: [{
        summary: "未用 lsp 核对调用链",
        detail: "未观察到 goToDefinition / findReferences / goToImplementation。grep 命中不能代替调用链。",
      }],
      suggestions: ["对契约中的关键符号调用 lsp（findReferences 或 goToDefinition）后再下结论"],
      pathsRead,
    };
  }
  return { ...parsed, pathsRead };
}

export function pinReviewChild(child) {
  const result = { sandbox: false, restricted: false };
  if (!child) return result;
  if (typeof child.session?.append === "function") {
    try {
      child.session.append("sandbox/mode", { mode: "read-only", source: "delegation" });
      result.sandbox = true;
    } catch {
      // watchChildTools still fails the round if a write tool is called
    }
  }
  const tools = child.ctx?.tools;
  if (typeof tools?.restrict === "function") {
    try {
      const view = typeof tools.view === "function" ? tools.view(child) : null;
      const known = view?.restrictableNames;
      const deny = WRITE_TOOLS.filter((name) => (known && typeof known.has === "function" ? known.has(name) : true));
      if (deny.length) {
        tools.restrict({ deny });
        result.restricted = true;
      }
    } catch {
      // unknown names or unscoped ctx: keep the write-tool watcher
    }
  }
  return result;
}

export async function startReviewChild({
  subagents,
  parent,
  cwd,
  contract,
  reviewer,
  draft,
  signal,
}) {
  if (!subagents?.startActivation || typeof subagents.getProvider !== "function") {
    throw Object.assign(new Error("无法再 spawn/fork：subagents 服务不可用"), { code: "NO_SUBAGENTS" });
  }
  const errors = [];
  // spawn first: fork seeds the parent's request/header, so the child's live
  // LLM call keeps the parent model even when agentOptions name a reviewer.
  for (const provider of ["spawn", "fork"]) {
    if (!subagents.getProvider(provider)) {
      errors.push(`${provider} 未注册`);
      continue;
    }
    const prompt = buildReviewPrompt({
      contract,
      provider,
      cwd,
      userText: draft?.lastUserText ?? "",
      tools: toolSummary(draft),
      reviewer,
    });
    try {
      return {
        provider,
        receipt: await subagents.startActivation({
          provider,
          label: "promote-review",
          request: {
            parent,
            ...(cwd ? { cwd } : {}),
            prompt: [{ type: "text", text: prompt }],
            agentOptions: reviewerOptions(reviewer),
            outputSchema: REVIEW_SCHEMA,
          },
          signal,
          delivery: "caller",
        }),
      };
    } catch (error) {
      errors.push(`${provider}: ${error?.message ?? error}`);
    }
  }
  throw Object.assign(new Error(`无法再 spawn/fork：${errors.join("；")}`), { code: "SPAWN_FORK_FAILED" });
}

export function watchChildTools(child, { onWrite, onRead, onLsp }) {
  if (!child?.ctx?.on || !child.session) return () => {};
  return child.ctx.on("session/event", (session, event) => {
    if (session !== child.session) return;
    if (event?.type !== "tool/call") return;
    const name = event.data?.name;
    if (typeof name !== "string") return;
    if (WRITE_TOOLS.includes(name)) onWrite(name);
    if (name === LSP_TOOL) {
      const op = lspChainOp(event.data);
      if (op) onLsp?.(op);
      return;
    }
    if (!READ_TOOLS.includes(name)) return;
    onRead(toolCallPath(event.data) || name);
  });
}

export function watchWrites(child, onWrite) {
  return watchChildTools(child, { onWrite, onRead() {} });
}

export function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("审核超时"), { code: "TIMEOUT" });
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runReviewAttempt(deps) {
  const controller = deps.controller ?? new AbortController();
  const started = await startReviewChild({
    subagents: deps.subagents,
    parent: deps.parent,
    cwd: deps.cwd,
    contract: deps.contract,
    reviewer: deps.reviewer,
    draft: deps.draft,
    signal: controller.signal,
  });
  let wrote = false;
  const observedPaths = [];
  const observedLsp = [];
  const child = deps.agents?.get?.(started.receipt.childId);
  const watched = Boolean(child?.ctx?.on && child.session);
  const pin = pinReviewChild(child);
  const stopWatch = watchChildTools(child, {
    onWrite() {
      wrote = true;
      controller.abort(Object.assign(new Error("审核子代理改文件"), { code: "WRITE_TOOL" }));
    },
    onRead(path) {
      if (path && !observedPaths.includes(path)) observedPaths.push(path);
    },
    onLsp(op) {
      if (op && !observedLsp.includes(op)) observedLsp.push(op);
    },
  });
  try {
    const settled = await withTimeout(started.receipt.result, deps.timeoutMs ?? TIMEOUT_MS, controller);
    if (controller.signal.aborted) {
      return interpretResult({
        wrote, timedOut: false, aborted: true, observedPaths,
        observedLsp: watched ? observedLsp : undefined,
        provider: started.provider,
      });
    }
    return {
      provider: started.provider,
      sandboxPinned: pin.sandbox,
      toolsRestricted: pin.restricted,
      ...interpretResult({
        structured: settled?.structured,
        stopReason: settled?.stopReason,
        wrote,
        timedOut: false,
        aborted: false,
        observedPaths,
        observedLsp: watched ? observedLsp : undefined,
      }),
    };
  } catch (error) {
    const timedOut = error?.code === "TIMEOUT";
    try { await started.receipt.dispose?.(); } catch { /* still report the original failure */ }
    if (timedOut) return { provider: started.provider, failed: true, reason: "审核超时（120s）" };
    if (controller.signal.aborted && wrote) {
      return {
        provider: started.provider,
        failed: true,
        reason: "审核子代理调用了改文件工具，本轮失败。只读沙箱或工具限制未能拦住这次调用。",
      };
    }
    if (controller.signal.aborted) return { provider: started.provider, failed: true, reason: "审核已取消（出现新版本或会话结束）" };
    throw error;
  } finally {
    stopWatch?.();
  }
}
