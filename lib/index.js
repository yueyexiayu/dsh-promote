import { PLUGIN_ID, PLUGIN_VERSION, API_PATH, PROJECTION_KEY, SOURCE_PREFIX, TIMEOUT_MS, TOOL_TIMEOUT_MS, ROUTES_TTL_MS } from "./constants.js";
import { formatRoute, reviewerOptions, shortHash } from "./extract.js";
import { loadSettings, saveSettings, validateSettings } from "./settings.js";
import { autoReviewReady, chooseReviewer } from "./select.js";
import { createDraftState, reduceDraftState, draftStateSchema } from "./projection.js";
import {
  beginReview, completeReview, createReviewState, failVisible, isRecoverableConfigFailure, shouldStartReview,
} from "./state.js";
import {
  revisionInstruction, statusExhausted, statusFailed, statusPassed, statusReviewing,
} from "./format.js";
import { runReviewAttempt } from "./review.js";
import { REVIEW_RULES } from "./prompt.js";

export const name = PLUGIN_ID;
export const inject = ["connection", "tools", "loader", "agents", "subagents", "sessionProjections", "sessionController"];

export function createSettingsQueue() {
  let queue = Promise.resolve();
  return (fn) => {
    const pending = queue.then(fn);
    queue = pending.then(() => {}, () => {});
    return pending;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function modelSelection(value) {
  if (!value || typeof value.provider !== "string" || !value.provider.trim()
    || typeof value.model !== "string" || !value.model.trim()) return null;
  const selected = { provider: value.provider, model: value.model };
  if (typeof value.reasoningEffort === "string" && value.reasoningEffort.trim()) {
    selected.reasoningEffort = value.reasoningEffort.trim();
  }
  return selected;
}

function normalizeEfforts(model) {
  const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [];
  return efforts.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id) return null;
    return {
      id: item.id,
      name: typeof item.name === "string" && item.name ? item.name : item.id,
      default: item.id === model.reasoning.defaultEffort,
    };
  }).filter(Boolean);
}

export function currentSessionModel(ctx, sessionId) {
  if (!sessionId) return { unassociated: true, provider: null, model: null, error: "未关联会话，无法确认主模型" };
  try {
    const agent = ctx.agents?.get?.(String(sessionId)) ?? ctx.get?.("agents")?.get?.(String(sessionId));
    const session = agent?.session;
    if (!session) return { provider: null, model: null, error: "当前会话未处于活跃状态，无法确认模型" };
    // The Agent owns the next-step choice, including its live options fallback.
    // Never fall back to an older route if this authoritative read fails.
    if (typeof agent.model?.current === "function") {
      let current;
      try { current = agent.model.current(); } catch {
        return { provider: null, model: null, error: "读取当前会话 Agent 模型选择时发生异常" };
      }
      if (current == null) return { provider: null, model: null, error: "当前会话 Agent 尚未确定模型" };
      return modelSelection(current) ?? { provider: null, model: null, error: "当前会话 Agent 模型选择无效（缺少 provider 或 model）" };
    }
    const projections = ctx.sessionProjections ?? ctx.get?.("sessionProjections");
    if (!projections) return { provider: null, model: null, error: "当前会话模型投影服务不可用" };
    const projection = projections.snapshot(session, ["modelSelection"]).values.modelSelection;
    if (!projection) return { provider: null, model: null, error: "当前会话模型投影未注册" };
    if (projection.next != null) {
      return modelSelection(projection.next) ?? { provider: null, model: null, error: "当前会话模型选择无效" };
    }
    const header = session.requestHeader();
    if (header !== undefined) {
      return modelSelection(header?.config) ?? { provider: null, model: null, error: "当前会话请求模型无效" };
    }
    return { provider: null, model: null, error: "当前会话尚未选择模型" };
  } catch {
    return { provider: null, model: null, error: "读取当前会话模型失败" };
  }
}

function sessionReviewer(ctx, agent, settings) {
  const main = agent?.session
    ? currentSessionModel(ctx, agent.session.id)
    : { provider: null, model: null, error: "当前会话未处于活跃状态，无法确认模型" };
  const mainRoute = main.provider && main.model ? { provider: main.provider, model: main.model } : null;
  return { main, mainRoute, choice: chooseReviewer(mainRoute, settings, main.error) };
}

export async function listRoutes(ctx) {
  const controller = ctx.get?.("sessionController") ?? ctx.sessionController;
  if (!controller?.modelCatalog) throw new Error("DSH 会话模型目录不可用");
  const catalog = await controller.modelCatalog();
  if (!catalog || !Array.isArray(catalog.groups)) throw new Error("DSH 会话模型目录返回无效数据");
  return catalog.groups.flatMap((group) => {
    if (!group || typeof group.id !== "string" || !group.id || !Array.isArray(group.models)) return [];
    return group.models.filter((model) => typeof model?.id === "string" && model.id).map((model) => ({
      provider: group.id,
      model: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      efforts: normalizeEfforts(model),
    }));
  });
}

export async function assertReviewerCredentials(ctx, reviewer, signal) {
  const llm = ctx.get?.("llm") ?? ctx.llm;
  if (typeof llm?.resolveCallConfig === "function") {
    await llm.resolveCallConfig(reviewerOptions(reviewer), signal);
    return;
  }
  const credentials = ctx.get?.("credentials") ?? ctx.credentials;
  if (!credentials) throw new Error("无法校验次模型登录/凭证");
  if (reviewer.provider === "xai" || reviewer.provider === "openai-codex") {
    const key = reviewer.provider === "xai" ? "llm-pi-ai/xai" : "llm-pi-ai/openai-codex";
    const record = await credentials.readRecord?.(key);
    if (!record) throw new Error(`次模型 ${formatRoute(reviewer)} 未登录`);
    return;
  }
  throw new Error(`次模型 ${formatRoute(reviewer)} 缺登录/凭证`);
}

function acceptsParent(agent) {
  const header = agent?.session?.header;
  if (!header) return false;
  if (header.origin === "subagent" || header.delegationDepth > 0) return false;
  return true;
}

function publicLast(last) {
  if (!last) return null;
  return {
    status: last.status,
    hash: last.hash,
    hashShort: last.hashShort ?? (last.hash ? shortHash(last.hash) : null),
    round: last.round,
    sessionRound: last.sessionRound ?? null,
    versionRound: last.versionRound ?? last.round,
    maxRevisions: last.maxRevisions,
    reviewer: last.reviewer,
    provider: last.provider,
    reason: last.reason ?? null,
    passed: last.passed ?? null,
    issues: last.issues ?? null,
    code: last.code ?? null,
    disableAuto: Boolean(last.disableAuto),
  };
}

export async function apply(ctx, input = {}) {
  const helpers = await ctx.loader.import("@deepseek-ai/dsh-llm");
  let reviewApi;
  try { reviewApi = await ctx.loader.import("@deepseek-ai/dsh-subagent"); } catch { reviewApi = null; }
  const file = input.settingsPath;
  const reviews = new Map();
  const controllers = new Map();
  const inFlight = new Map();
  const uncertain = new Set();
  const orphanNotices = new Set();
  let disposed = false;

  const stateOf = (sessionId) => {
    let state = reviews.get(sessionId);
    if (!state) {
      state = createReviewState();
      reviews.set(sessionId, state);
    }
    return state;
  };

  // The awaited registration handle owns this projection's reads; the
  // registry-level stateOf(session, key) read is deprecated.
  let draftHandle = null;
  const draftOf = (agent) => draftHandle?.stateOf(agent.session);

  const deliver = (agent, kind, text, wake, outcome) => {
    const message = helpers.createUserMessage({
      source: { kind: `${SOURCE_PREFIX}:${kind}`, ...(outcome ? {
        promoteHash: outcome.hash, promoteStatus: outcome.status, promoteRetryable: Boolean(outcome.retryable),
        ...(typeof outcome.code === "string" && /^[A-Z_]+$/.test(outcome.code) ? { promoteCode: outcome.code } : {}),
      } : {}) },
      content: [{ type: "text", text }],
    });
    if (wake) agent.steer(message);
    else agent.session.append("user/message", message, { surfaceOp: "append" });
  };

  const abortActive = (sessionId) => {
    const running = controllers.get(sessionId);
    if (!running) return;
    running.abort(Object.assign(new Error("出现新版本，丢弃旧审核"), { code: "STALE" }));
    controllers.delete(sessionId);
  };

  const invalidateActive = (sessionId) => {
    abortActive(sessionId);
    const state = reviews.get(sessionId);
    if (state?.active) {
      state.generation += 1;
      state.active = null;
      state.phase = "unknown";
      state.last = { ...state.last, status: "unknown", code: "STALE", reason: "旧审核已取消，结果未知" };
    }
  };

  function launchReview(agent, {
    hash, contract, draft, reviewer, maxRevisions, explicit, signal,
  }) {
    const sessionId = agent.session.id;
    const existing = inFlight.get(sessionId);
    if (existing && existing.hash === hash) return existing.promise;
    const state = stateOf(sessionId);
    const gate = shouldStartReview(state, {
      hash,
      explicit,
      autoReady: true,
    });
    if (!gate.ok) return Promise.resolve(gate);
    abortActive(sessionId);
    const cwd = agent.session.header?.cwd ?? agent.session.requestHeader?.()?.cwd ?? null;
    const started = beginReview(state, { hash, reviewer, maxRevisions, provider: null });
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    const job = { hash, waiters: 0, auto: !explicit, controller };
    deliver(agent, "status", statusReviewing(state.last), false, { hash, status: "reviewing" });
    job.promise = (async () => {
      let timer;
      let onAbort;
      let onExternalAbort;
      let activationStarted = false;
      let retired = false;
      const uncertaintyKey = `${sessionId}:${hash}`;
      const retire = () => {
        if (retired || disposed) return;
        retired = true;
        uncertain.delete(uncertaintyKey);
        deliver(agent, "retired", `[promote] 旧版 ${shortHash(hash)} 已确认结束。`, false, { hash });
      };
      try {
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason ?? Object.assign(new Error("审核已取消"), { code: "ABORTED" }));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        onExternalAbort = () => controller.abort(Object.assign(new Error("审核已取消"), { code: "CANCELLED" }));
        if (signal?.aborted) onExternalAbort();
        else signal?.addEventListener?.("abort", onExternalAbort, { once: true });
        timer = setTimeout(() => controller.abort(Object.assign(new Error(`审核超时（${TIMEOUT_MS / 1000}s）`), { code: "TIMEOUT" })), TIMEOUT_MS);
        const work = (async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          try {
            await assertReviewerCredentials(ctx, reviewer, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted && /未登录|凭证|缺配/.test(String(error?.message))) {
              throw Object.assign(new Error(error.message, { cause: error }), { code: "AUTH_UNAVAILABLE" });
            }
            throw error;
          }
          if (controller.signal.aborted) throw controller.signal.reason;
          activationStarted = true;
          const result = await runReviewAttempt({
            subagents: ctx.subagents,
            tools: ctx.tools,
            loadEvidenceApi: async () => reviewApi,
            loadLspApi: async () => ctx.loader.import("@deepseek-ai/dsh-tool-lsp"),
            agents: ctx.agents,
            parent: agent,
            cwd,
            contract,
            reviewer,
            draft,
            controller,
            timeoutMs: TIMEOUT_MS,
            onCleanupConfirmed: retire,
            onCleanupFailed: () => {
              uncertain.add(uncertaintyKey);
              if (!disposed) deliver(agent, "notice", `[promote 审核状态未知] 版本 ${shortHash(hash)} 的子任务清理失败。`, false);
            },
          });
          if (controller.signal.aborted && result?.code === "READ_ONLY_UNAVAILABLE") retire();
          return result;
        })();
        const outcome = await Promise.race([work, cancelled]);
        if (outcome?.code === "CLEANUP_FAILED") {
          uncertain.add(uncertaintyKey);
          if (started.active.generation !== state.generation || (state.active && state.active.hash !== hash)) {
            return { ok: false, status: "stale", code: "STALE", retryable: false,
              error: "旧审核清理失败，结果不能确认", hash };
          }
          if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
          const last = failVisible(state, { reason: outcome.reason, hash, reviewer, code: "ORPHANED" });
          last.status = "unknown";
          last.retryable = false;
          // Keep the persisted reviewing marker: cleanup failure must remain an
          // unresolved orphan even after this plugin is reloaded.
          return { ok: false, status: "unknown", code: "ORPHANED", causeCode: "CLEANUP_FAILED",
            retryable: false, error: outcome.reason, hash };
        }
        const finished = completeReview(state, {
          hash,
          generation: started.active.generation,
          result: { ...outcome, retryable: !["READ_ONLY_UNAVAILABLE", "WORKSPACE_ESCAPE"].includes(outcome.code) },
        });
        if (finished.kind === "stale") {
          if (outcome?.code === "READ_ONLY_UNAVAILABLE") retire();
          return { ok: false, status: "stale", code: "STALE", retryable: true, error: "出现新版本，丢弃旧审核", hash };
        }
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
        const waited = job.waiters > 0;
        if (finished.kind === "failed") {
          const retryable = finished.last.retryable;
          deliver(agent, "status", statusFailed({
            reason: finished.last.reason,
            reviewer,
            hash,
            round: finished.last.round,
            maxRevisions,
            disableAuto: false,
            retryable,
          }), retryable && !waited, { hash, status: "failed", retryable, code: finished.last.code });
          return {
            ok: false, status: "failed", retryable, error: finished.last.reason,
            ...(typeof finished.last.code === "string" ? { code: finished.last.code } : {}),
            hash, round: finished.last.round, reviewer,
            ...(Array.isArray(finished.last.issues) ? { issues: finished.last.issues } : {}),
          };
        }
        if (finished.kind === "passed") {
          deliver(agent, "status", statusPassed(finished.last), false, { hash, status: "passed" });
          return {
            ok: true, status: "passed", hash, round: finished.last.round, reviewer,
            pathsRead: finished.last.pathsRead, issues: finished.last.issues,
          };
        }
        if (finished.kind === "exhausted") {
          deliver(agent, "status", statusExhausted(finished.last), false, { hash, status: "exhausted" });
          return {
            ok: false, status: "exhausted", hash, round: finished.last.round, reviewer,
            issues: finished.last.issues,
          };
        }
        deliver(agent, "status", `[promote 审核意见] 版本 ${shortHash(hash)} 需要改稿。`, false,
          { hash, status: "needs-revision", retryable: false });
        if (!waited) deliver(agent, "revision", revisionInstruction(finished.last), true);
        return {
          ok: false, status: "needs-revision", hash, round: finished.last.round, reviewer,
          issues: finished.last.issues, suggestions: finished.last.suggestions,
          pathsRead: finished.last.pathsRead,
        };
      } catch (error) {
        if (disposed) {
          const reason = controller.signal.reason;
          if (activationStarted && !retired) {
            return { ok: false, status: "unknown", code: "ORPHANED", causeCode: reason?.code ?? "DISPOSED",
              retryable: false, error: "插件卸载后无法确认审核子任务已结束", hash };
          }
          return { ok: false, status: "aborted", code: reason?.code ?? "DISPOSED", retryable: true, error: reason?.message ?? "插件已卸载", hash };
        }
        if (controller.signal.aborted && !activationStarted) retire();
        if (controller.signal.aborted && activationStarted && !retired) uncertain.add(uncertaintyKey);
        if (started.active.generation !== state.generation || (state.active && state.active.hash !== hash)) {
          return { ok: false, status: "stale", code: "STALE", retryable: true,
            error: "出现新版本，丢弃旧审核", hash };
        }
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
        if (controller.signal.aborted && activationStarted && !retired) {
          const trigger = controller.signal.reason?.code;
          const triggerLabel = trigger === "TIMEOUT" ? "审核超时" : trigger === "DISPOSED" ? "资源销毁"
            : trigger === "WRITE_TOOL" ? "禁止写入" : trigger === "STALE" ? "版本过期" : "审核取消";
          const last = failVisible(state, { reason: `${triggerLabel}后无法确认子任务已结束`, hash, reviewer, code: "ORPHANED" });
          last.status = "unknown";
          last.retryable = false;
          deliver(agent, "notice", `[promote 审核状态未知] ${last.reason}`, false);
          return { ok: false, status: "unknown", code: "ORPHANED", retryable: false, error: last.reason, hash };
        }
        const code = error?.code;
        const disableAuto = code === "UNCONFIGURED" || code === "BOTH_MATCH_MAIN" || code === "AUTH_UNAVAILABLE";
        const retryable = !disableAuto;
        const last = failVisible(state, {
          reason: error?.message ?? String(error),
          hash,
          reviewer,
          disableAuto,
          code,
        });
        deliver(agent, "status", statusFailed({ ...last, retryable }), retryable && job.waiters === 0, { hash, status: "failed", retryable, code });
        return {
          ok: false, status: "failed", retryable, error: last.reason,
          ...(typeof code === "string" ? { code } : {}), hash, reviewer,
        };
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        if (onExternalAbort) signal?.removeEventListener?.("abort", onExternalAbort);
        if (inFlight.get(sessionId) === job) inFlight.delete(sessionId);
      }
    })();
    inFlight.set(sessionId, job);
    return job.promise;
  }

  const snapshot = { settings: null, settingsError: null };
  try {
    snapshot.settings = await loadSettings(file);
  } catch (error) {
    snapshot.settingsError = error?.message ?? String(error);
  }
  const withSettingsLock = createSettingsQueue();
  let routesCache = { at: 0, value: null };

  async function routesNow() {
    if (routesCache.value && Date.now() - routesCache.at < ROUTES_TTL_MS) return routesCache.value;
    const routes = await listRoutes(ctx);
    routesCache = { at: Date.now(), value: routes };
    return routes;
  }

  function snapshotSession(sessionId) {
    const settings = snapshot.settings;
    const state = reviews.get(sessionId);
    const sessionAgent = sessionId ? ctx.agents?.get?.(String(sessionId)) : null;
    const projection = sessionAgent?.session ? draftOf(sessionAgent) : null;
    const restored = projection?.reviewOutcome;
    const targetHash = projection?.latestDraft?.hash ?? (projection?.hasTrigger ? projection.hash : null) ?? restored?.hash;
    const activeHash = inFlight.get(sessionId)?.hash ?? null;
    const orphan = targetHash && activeHash !== targetHash
      && (projection?.orphanOverflow || projection?.orphanReviewing?.includes(targetHash));
    const last = orphan ? { status: "unknown", hash: targetHash, code: "ORPHANED",
      reason: projection.orphanOverflow ? "未结审核记录溢出，无法确认旧任务状态。" : "上次审核的结果未知，不能确认旧任务是否仍在运行；请重新提供不同版本的契约。" }
      : state?.last ?? (restored ? { status: restored.status, hash: restored.hash,
        reason: "该状态从持久记录恢复，详细审核结果不可用。", retryable: restored.retryable, code: restored.code } : null);
    if (snapshot.settingsError) {
      return { unassociated: !sessionId, sessionId: sessionId || null, mainModel: null, reviewer: null,
        autoDisabled: true, autoDisabledReason: `读取设置失败：${snapshot.settingsError}`,
        last: publicLast(last), reviewing: Boolean(state?.active) };
    }
    if (!sessionId) {
      return {
        unassociated: true,
        mainModel: null,
        reviewer: null,
        autoDisabled: true,
        autoDisabledReason: "未关联会话，不得用 Host 默认策略冒充当前主模型",
        last: null,
        reviewing: false,
      };
    }
    const selected = sessionReviewer(ctx, sessionAgent, settings);
    const { main, mainRoute, choice } = selected;
    const auto = autoReviewReady(settings, choice);
    return {
      unassociated: false,
      sessionId,
      mainModel: mainRoute,
      mainModelError: main.error ?? null,
      reviewer: choice.ok ? choice.reviewer : null,
      reviewerError: choice.ok ? null : choice.reason,
      usedSlot: choice.ok ? choice.used : null,
      fallbackReason: choice.ok ? choice.fallbackReason ?? null : null,
      autoDisabled: !auto.ok || typeof reviewApi?.inspectReviewEvidence !== "function" || typeof ctx.subagents?.startLockedActivation !== "function",
      autoDisabledReason: !auto.ok ? auto.reason
        : typeof reviewApi?.inspectReviewEvidence !== "function" || typeof ctx.subagents?.startLockedActivation !== "function"
          ? "Host 可信审核能力不可用" : null,
      last: publicLast(last),
      reviewing: Boolean(state?.active),
      canResetOrphans: Boolean(projection?.orphanOverflow
        || projection?.orphanReviewing?.some((hash) => hash !== activeHash)
        || (last?.code === "ORPHANED" && last?.hash !== activeHash)
        || [...uncertain].some((key) => key.startsWith(`${sessionId}:`) && key !== `${sessionId}:${activeHash}`)),
    };
  }

  async function reconcileSession(sessionId) {
    const agent = sessionId ? ctx.agents?.get?.(String(sessionId)) : null;
    if (!agent?.session || !acceptsParent(agent)) throw Object.assign(new Error("当前会话未处于可恢复的活跃状态"), { code: "NO_SESSION" });
    const flying = inFlight.get(sessionId);
    if (flying) {
      invalidateActive(sessionId);
      await flying.promise.catch(() => {});
    }
    for (const key of [...uncertain]) if (key.startsWith(`${sessionId}:`)) uncertain.delete(key);
    for (const key of [...orphanNotices]) if (key.startsWith(`${sessionId}:`)) orphanNotices.delete(key);
    const previous = reviews.get(sessionId);
    const next = createReviewState();
    next.sessionReviews = previous?.sessionReviews ?? 0;
    reviews.set(sessionId, next);
    deliver(agent, "reconcile", "[promote] 已按用户确认解除旧审核的未知状态。旧子任务若仍存在也不会被当作本次审核结果。", false);
    return snapshotSession(sessionId);
  }

  ctx.effect(() => {
    const registration = ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 3,
      stateSchema: draftStateSchema,
      init: () => createDraftState(),
      apply: reduceDraftState,
    });
    let live = true;
    registration.then((handle) => {
      if (live) draftHandle = handle;
    }, (error) => {
      if (live) ctx.logger?.error?.(error);
    });
    return () => {
      live = false;
      draftHandle = null;
      return registration();
    };
  });

  ctx.on("agent/turn-stopping", async ({ agent, signal }) => {
    if (disposed || signal.aborted || !acceptsParent(agent)) return;
    const draft = draftOf(agent);
    const sessionId = agent.session.id;
    const flying = inFlight.get(sessionId);
    if (flying && !(draft?.hasTrigger && draft.hash && draft.hash !== flying.hash)) {
      await flying.promise;
      return;
    }
    if (!draft?.hasTrigger || !draft.hash) return;
    if (draft.orphanOverflow || draft.orphanReviewing?.includes(draft.hash) || uncertain.has(`${sessionId}:${draft.hash}`)) {
      if (flying && flying.hash !== draft.hash) invalidateActive(sessionId);
      const key = `${sessionId}:${draft.hash}`;
      if (!orphanNotices.has(key)) {
        orphanNotices.add(key);
        deliver(agent, "notice", "[promote 审核状态未知] 上次审核可能仍在运行或未结状态记录溢出，无法安全启动此审核。", false);
      }
      return;
    }
    // A persisted status is authoritative even when the in-memory review state was lost.
    // Never automatically repeat an attempt for the same version after a restart.
    if (draft.reviewOutcome?.hash === draft.hash) return;
    const settings = snapshot.settings;
    if (!settings) {
      const state = stateOf(sessionId);
      if (state.last?.hash === draft.hash && state.last?.code === "SETTINGS_INVALID") return;
      const last = failVisible(state, { reason: `读取设置失败：${snapshot.settingsError}`, hash: draft.hash, disableAuto: true, code: "SETTINGS_INVALID" });
      deliver(agent, "status", statusFailed(last), false, { hash: draft.hash, status: "failed", retryable: false, code: last.code });
      return;
    }
    if (!settings.autoReview) return;
    const { choice } = sessionReviewer(ctx, agent, settings);
    const auto = autoReviewReady(settings, choice);
    if (!auto.ok || !choice.ok) {
      const state = stateOf(agent.session.id);
      if (state.last?.hash === draft.hash && state.last?.status === "failed") return;
      const last = failVisible(state, {
        reason: choice.ok ? auto.reason : choice.reason,
        hash: draft.hash,
        reviewer: choice.reviewer,
        disableAuto: true,
        code: choice.code ?? "AUTO_DISABLED",
      });
      deliver(agent, "status", statusFailed(last), false, { hash: draft.hash, status: "failed", retryable: false, code: last.code });
      return;
    }
    const gate = shouldStartReview(stateOf(agent.session.id), {
      hash: draft.hash,
      explicit: false,
      autoReady: true,
    });
    if (!gate.ok) return;
    await launchReview(agent, {
      hash: draft.hash,
      contract: draft.visibleText,
      draft,
      reviewer: choice.reviewer,
      maxRevisions: settings.maxRevisions,
      explicit: false,
      signal,
    });
  });

  ctx.tools.register({
    name: "promote",
    description: "等待当前契约的次模型只读审核结束并返回通过/改稿/失败。主对话在审核期间必须调用本工具保持等待。标准代码围栏内的契约也审；引用行和行内代码中的标记不审。同一哈希会接入已在进行的审核，不会并行双开。超时或失败且 retryable 时可再调用重试。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    timeoutMs: TOOL_TIMEOUT_MS,
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent;
      if (exec.signal?.aborted) return { ok: false, status: "cancelled", code: "CANCELLED", retryable: true, error: "等待已取消" };
      if (!agent?.session) return { ok: false, error: "需要当前会话" };
      if (!acceptsParent(agent)) return { ok: false, error: "审核子代理不得发起审核" };
      const projected = draftOf(agent);
      const sessionId = agent.session.id;
      const flying = inFlight.get(sessionId);
      const candidate = projected?.latestDraft;
      const last = reviews.get(sessionId)?.last;
      const outcome = projected?.reviewOutcome;
      const canRetry = candidate?.hash && (flying?.hash === candidate.hash
        || (last?.status === "failed" && (last.retryable !== false || isRecoverableConfigFailure(last.code)) && last.hash === candidate.hash)
        || (!last && outcome?.status === "failed" && (outcome.retryable || isRecoverableConfigFailure(outcome.code)) && outcome.hash === candidate.hash));
      const targetHash = hasTriggerSafe(projected) && projected?.hash ? projected.hash : candidate?.hash;
      if (targetHash && flying?.hash !== targetHash && (projected?.orphanOverflow || projected?.orphanReviewing?.includes(targetHash) || uncertain.has(`${sessionId}:${targetHash}`))) {
        if (flying) invalidateActive(sessionId);
        return { ok: false, status: "unknown", code: "ORPHANED", retryable: false, hash: targetHash,
          error: projected.orphanOverflow ? "未结审核记录溢出，无法确认旧任务是否仍在运行，不能安全启动审核。"
            : "上次审核的结果未知，不能确认旧任务是否仍在运行；请重新提供不同版本的契约。" };
      }
      const draft = hasTriggerSafe(projected) && projected?.hash ? projected : canRetry ? candidate : null;
      const hash = draft?.hash;
      if (!hash) {
        const failure = last?.hash === candidate?.hash ? last : !last && outcome?.hash === candidate?.hash ? outcome : null;
        if (failure?.status === "failed" && failure.retryable === false && !isRecoverableConfigFailure(failure.code)) {
          return { ok: false, code: "NOT_RETRYABLE", retryable: false, hash: candidate.hash, error: "该失败记录不可重试" };
        }
        return { ok: false, error: "当前对话没有可审核的契约，或没有与其匹配的可重试失败记录；旧记录或重启后未持久化的状态不能作为重试依据（契约须含未引用的 [END OF EXECUTION PROMPT]）" };
      }
      if (!flying && !last && outcome?.hash === hash && outcome.status === "failed" && !outcome.retryable && !isRecoverableConfigFailure(outcome.code)) {
        return { ok: false, code: "NOT_RETRYABLE", hash, error: "该失败记录不可重试" };
      }
      if (!flying && !last && outcome?.hash === hash && ["passed", "exhausted", "needs-revision"].includes(outcome.status)) {
        return { ok: false, code: outcome.status === "passed" ? "ALREADY_PASSED" : "ALREADY_FINISHED", hash, error: "该契约版本已完成审核，请提供新稿" };
      }
      const settings = snapshot.settings;
      if (!settings) return { ok: false, status: "failed", code: "SETTINGS_INVALID", retryable: false, error: `读取设置失败：${snapshot.settingsError}` };
      const { choice } = sessionReviewer(ctx, agent, settings);
      if (!choice.ok) return { ok: false, error: choice.reason, code: choice.code };
      const promise = launchReview(agent, {
        hash,
        contract: draft.visibleText,
        draft,
        reviewer: choice.reviewer,
        maxRevisions: settings.maxRevisions,
        explicit: true,
      });
      const job = inFlight.get(sessionId);
      if (job) job.waiters += 1;
      let onCancel;
      try {
        if (!exec.signal?.addEventListener) return await promise;
        const cancelled = new Promise((resolve) => {
          onCancel = () => resolve({ ok: false, status: "cancelled", code: "CANCELLED", retryable: true, error: "等待已取消", hash });
          exec.signal.addEventListener("abort", onCancel, { once: true });
          if (exec.signal.aborted) onCancel();
        });
        return await Promise.race([promise, cancelled]);
      } finally {
        if (onCancel) exec.signal.removeEventListener("abort", onCancel);
        if (job) {
          job.waiters -= 1;
          if (exec.signal?.aborted && !job.auto && job.waiters === 0 && inFlight.get(sessionId) === job) {
            job.controller.abort(Object.assign(new Error("审核已取消"), { code: "CANCELLED" }));
            await job.promise;
          }
        }
      }
    },
  });

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") || "";
      const view = url.searchParams.get("view") || "";
      if (request.method === "GET") {
        if (view === "session") {
          return jsonResponse(200, {
            ok: true,
            version: PLUGIN_VERSION,
            session: snapshotSession(sessionId),
          });
        }
        const settings = await withSettingsLock(async () => {
          try {
            snapshot.settings = await loadSettings(file);
            snapshot.settingsError = null;
          } catch (error) {
            snapshot.settings = null;
            snapshot.settingsError = error?.message ?? String(error);
          }
          return snapshot.settings;
        });
        if (!settings) return jsonResponse(500, { ok: false, error: `读取设置失败：${snapshot.settingsError}；文件未改动，保存设置将覆盖原文件` });
        let routes = [];
        let routesError = null;
        try { routes = await routesNow(); } catch (error) { routesError = error?.message ?? String(error); }
        return jsonResponse(200, {
          ok: true,
          version: PLUGIN_VERSION,
          settings,
          routes,
          routesError,
          rules: REVIEW_RULES,
          session: snapshotSession(sessionId),
        });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { ok: false, error: "请求体不是 JSON" });
      }
      if (view === "reconcile") {
        if (body?.confirm !== true) return jsonResponse(400, { ok: false, error: "解除未知审核需要明确确认" });
        try {
          return jsonResponse(200, { ok: true, version: PLUGIN_VERSION, session: await reconcileSession(sessionId) });
        } catch (error) {
          return jsonResponse(error?.code === "NO_SESSION" ? 409 : 500, { ok: false, error: error?.message ?? "解除未知审核失败" });
        }
      }
      try {
        const saved = await withSettingsLock(async () => {
          const result = await saveSettings(body, file);
          if (result.ok) {
            snapshot.settings = result.settings;
            snapshot.settingsError = null;
          }
          return result;
        });
        if (!saved.ok) return jsonResponse(400, { ok: false, error: saved.error });
        routesCache = { at: 0, value: null };
        let routes = [];
        let routesError = null;
        try { routes = await routesNow(); } catch (error) { routesError = error?.message ?? String(error); }
        return jsonResponse(200, {
          ok: true,
          version: PLUGIN_VERSION,
          settings: saved.settings,
          ...(saved.durabilityWarning ? { warning: saved.durabilityWarning } : {}),
          routes,
          routesError,
          rules: REVIEW_RULES,
          session: snapshotSession(sessionId),
        });
      } catch (error) {
        return jsonResponse(500, { ok: false, error: error.message ?? "保存设置失败" });
      }
    },
  });

  ctx.effect(() => () => {
    disposed = true;
    for (const controller of controllers.values()) controller.abort(Object.assign(new Error("插件已卸载"), { code: "DISPOSED" }));
    controllers.clear();
  });
}

function hasTriggerSafe(draft) {
  return Boolean(draft?.hasTrigger);
}

export { validateSettings, chooseReviewer, shouldStartReview };
