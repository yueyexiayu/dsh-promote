import { REVIEW_SCHEMA, TIMEOUT_MS, WRITE_TOOLS } from "./constants.js";
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

export function interpretResult({ structured, stopReason, wrote, timedOut, aborted }) {
  if (timedOut) return { failed: true, reason: "审核超时（120s）" };
  if (aborted) return { failed: true, reason: "审核已取消（出现新版本或会话结束）" };
  if (wrote) return { failed: true, reason: "审核子代理调用了改文件工具，本轮失败。只读约束被打破，未切换只读沙箱。" };
  if (stopReason && stopReason !== "completed") {
    return { failed: true, reason: `审核子代理异常结束：${stopReason}` };
  }
  const parsed = normalizeStructured(structured);
  if (!parsed) return { failed: true, reason: "审核未返回结构化结果，禁止改无工具审" };
  if (parsed.passed && parsed.pathsRead.length === 0) {
    return {
      passed: false,
      issues: [{ summary: "未实际阅读工作区源码", detail: "pathsRead 为空，不得只凭契约正文判合格" }],
      suggestions: ["使用 read/grep/glob 打开当前会话工作区相关源码后再审"],
      pathsRead: [],
    };
  }
  return parsed;
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
  for (const provider of ["fork", "spawn"]) {
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

export function watchWrites(child, onWrite) {
  if (!child?.ctx?.on || !child.session) return () => {};
  return child.ctx.on("session/event", (session, event) => {
    if (session !== child.session) return;
    if (event?.type === "tool/call" && WRITE_TOOLS.includes(event.data?.name)) onWrite(event.data.name);
  });
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
  const child = deps.agents?.get?.(started.receipt.childId);
  const stopWatch = watchWrites(child, () => {
    wrote = true;
    controller.abort(Object.assign(new Error("审核子代理改文件"), { code: "WRITE_TOOL" }));
  });
  try {
    const settled = await withTimeout(started.receipt.result, deps.timeoutMs ?? TIMEOUT_MS, controller);
    if (controller.signal.aborted) {
      return interpretResult({ wrote, timedOut: false, aborted: true, provider: started.provider });
    }
    return {
      provider: started.provider,
      ...interpretResult({
        structured: settled?.structured,
        stopReason: settled?.stopReason,
        wrote,
        timedOut: false,
        aborted: false,
      }),
    };
  } catch (error) {
    const timedOut = error?.code === "TIMEOUT";
    try { await started.receipt.dispose?.(); } catch { /* still report the original failure */ }
    if (timedOut) return { provider: started.provider, failed: true, reason: "审核超时（120s）" };
    if (controller.signal.aborted && wrote) {
      return { provider: started.provider, failed: true, reason: "审核子代理调用了改文件工具，本轮失败。只读约束被打破，未切换只读沙箱。" };
    }
    if (controller.signal.aborted) return { provider: started.provider, failed: true, reason: "审核已取消（出现新版本或会话结束）" };
    throw error;
  } finally {
    stopWatch?.();
  }
}
