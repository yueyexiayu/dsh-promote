import { PLUGIN_ID, API_PATH, PROJECTION_KEY, SOURCE_PREFIX, TIMEOUT_MS } from "./constants.js";
import { formatRoute, reviewerOptions, shortHash } from "./extract.js";
import { loadSettings, saveSettings, validateSettings } from "./settings.js";
import { autoReviewReady, chooseReviewer } from "./select.js";
import { createDraftState, reduceDraftState } from "./projection.js";
import {
  beginReview, completeReview, createReviewState, failVisible, shouldStartReview,
} from "./state.js";
import {
  revisionInstruction, statusExhausted, statusFailed, statusPassed, statusReviewing,
} from "./format.js";
import { runReviewAttempt } from "./review.js";
import { REVIEW_RULES } from "./prompt.js";

export const name = PLUGIN_ID;
export const inject = ["connection", "tools", "loader", "agents", "subagents", "sessionProjections"];

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
  if (!value || typeof value.provider !== "string" || !value.provider) return null;
  const selected = { provider: value.provider, model: typeof value.model === "string" ? value.model : null };
  if (typeof value.reasoningEffort === "string" && value.reasoningEffort.trim()) {
    selected.reasoningEffort = value.reasoningEffort.trim();
  }
  return selected;
}

function normalizeEfforts(model) {
  const reasoning = model?.reasoning;
  const mapped = reasoning?.efforts && !Array.isArray(reasoning.efforts) && typeof reasoning.efforts === "object"
    ? Object.entries(reasoning.efforts).map(([id, name]) => ({ id, name: String(name) }))
    : null;
  const objectMap = model?.reasoningEfforts && !Array.isArray(model.reasoningEfforts) && typeof model.reasoningEfforts === "object"
    ? Object.entries(model.reasoningEfforts).map(([id, name]) => ({ id, name: String(name) }))
    : null;
  const raw = Array.isArray(reasoning?.efforts) ? reasoning.efforts
    : Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts
    : mapped ?? objectMap ?? [];
  const defaultId = reasoning?.defaultEffort;
  return raw.map((item) => {
    const id = typeof item === "string" ? item : item?.id;
    if (!id) return null;
    return {
      id,
      name: typeof item === "object" && item?.name ? item.name : id,
      default: Boolean(item?.default) || id === defaultId,
    };
  }).filter(Boolean);
}

export function currentSessionModel(ctx, sessionId) {
  if (!sessionId) return { unassociated: true, provider: null, model: null, error: "未关联会话，无法确认主模型" };
  try {
    const session = ctx.agents?.get?.(String(sessionId))?.session ?? ctx.get?.("agents")?.get?.(String(sessionId))?.session;
    if (!session) return { provider: null, model: null, error: "当前会话不存在，无法确认模型" };
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

const effortCache = new Map();

async function effortsFor(llm, providerId, modelId, listed) {
  const fromList = normalizeEfforts(listed);
  if (fromList.length) return fromList;
  if (typeof llm.resolveModelInfo !== "function") return [];
  const key = `${providerId}/${modelId}`;
  if (effortCache.has(key)) return effortCache.get(key);
  try {
    const info = await llm.resolveModelInfo(providerId, modelId);
    const efforts = normalizeEfforts(info);
    effortCache.set(key, efforts);
    return efforts;
  } catch {
    effortCache.set(key, []);
    return [];
  }
}

export async function listRoutes(ctx) {
  const llm = ctx.get?.("llm") ?? ctx.llm;
  if (!llm?.listProviders) return [];
  const providers = llm.listProviders() ?? [];
  const routes = [];
  for (const provider of providers) {
    const id = provider.id ?? provider.provider;
    if (!id) continue;
    let models = [];
    try {
      models = typeof llm.listModels === "function" ? await llm.listModels(id) : provider.models ?? [];
    } catch {
      models = provider.models ?? [];
    }
    for (const model of models ?? []) {
      const mid = typeof model === "string" ? model : model?.id;
      if (!mid) continue;
      const listed = typeof model === "object" ? model : { id: mid };
      routes.push({
        provider: id,
        model: mid,
        name: typeof model === "object" && model?.name ? model.name : mid,
        efforts: await effortsFor(llm, id, mid, listed),
      });
    }
  }
  return routes;
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
  const file = input.settingsPath;
  const reviews = new Map();
  const controllers = new Map();
  let disposed = false;

  const stateOf = (sessionId) => {
    let state = reviews.get(sessionId);
    if (!state) {
      state = createReviewState();
      reviews.set(sessionId, state);
    }
    return state;
  };

  const draftOf = (agent) => ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);

  const deliver = (agent, kind, text, wake) => {
    const message = helpers.createUserMessage({
      source: { kind: `${SOURCE_PREFIX}:${kind}` },
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

  async function launchReview(agent, {
    hash, contract, draft, reviewer, maxRevisions, explicit,
  }) {
    const sessionId = agent.session.id;
    const state = stateOf(sessionId);
    const gate = shouldStartReview(state, {
      hash,
      explicit,
      autoReady: true,
    });
    if (!gate.ok) return gate;
    abortActive(sessionId);
    const cwd = agent.session.header?.cwd ?? agent.session.requestHeader?.()?.cwd ?? null;
    const started = beginReview(state, { hash, reviewer, maxRevisions, provider: null });
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    deliver(agent, "status", statusReviewing({
      reviewer, round: started.active.round, maxRevisions, hash, provider: null,
    }), false);
    void (async () => {
      try {
        await assertReviewerCredentials(ctx, reviewer, controller.signal);
        const outcome = await runReviewAttempt({
          subagents: ctx.subagents,
          agents: ctx.agents,
          parent: agent,
          cwd,
          contract,
          reviewer,
          draft,
          controller,
          timeoutMs: TIMEOUT_MS,
        });
        if (disposed || controller.signal.aborted) return;
        const finished = completeReview(state, {
          hash,
          generation: started.active.generation,
          result: outcome,
        });
        if (finished.kind === "stale") return;
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
        if (finished.kind === "failed") {
          deliver(agent, "status", statusFailed({
            reason: finished.last.reason,
            reviewer,
            hash,
            round: finished.last.round,
            maxRevisions,
            disableAuto: false,
          }), false);
          return;
        }
        if (finished.kind === "passed") {
          deliver(agent, "status", statusPassed(finished.last), false);
          return;
        }
        if (finished.kind === "exhausted") {
          deliver(agent, "status", statusExhausted(finished.last), false);
          return;
        }
        deliver(agent, "revision", revisionInstruction(finished.last), true);
      } catch (error) {
        if (disposed) return;
        if (started.active.generation !== state.generation) return;
        if (state.active && state.active.hash !== hash) return;
        if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
        const code = error?.code;
        const disableAuto = code === "UNCONFIGURED" || code === "BOTH_MATCH_MAIN" || /未登录|凭证|缺配/.test(String(error?.message));
        const last = failVisible(state, {
          reason: error?.message ?? String(error),
          hash,
          reviewer,
          disableAuto,
          code,
        });
        deliver(agent, "status", statusFailed(last), false);
      }
    })();
    return { ok: true, status: "started", hash, round: started.active.round, reviewer };
  }

  const snapshot = { settings: await loadSettings(file) };

  function snapshotSession(sessionId) {
    const settings = snapshot.settings;
    if (!sessionId) {
      return {
        unassociated: true,
        mainModel: null,
        reviewer: null,
        autoDisabled: true,
        autoDisabledReason: "未关联会话，不得用 Host 默认策略冒充当前主模型",
        last: null,
      };
    }
    const main = currentSessionModel(ctx, sessionId);
    const mainRoute = main.provider && main.model ? { provider: main.provider, model: main.model } : null;
    const choice = chooseReviewer(mainRoute, settings);
    const auto = autoReviewReady(settings, choice);
    const state = reviews.get(sessionId);
    return {
      unassociated: false,
      sessionId,
      mainModel: mainRoute,
      mainModelError: main.error ?? null,
      reviewer: choice.ok ? choice.reviewer : null,
      reviewerError: choice.ok ? null : choice.reason,
      usedSlot: choice.ok ? choice.used : null,
      autoDisabled: !auto.ok,
      autoDisabledReason: auto.ok ? null : auto.reason,
      last: publicLast(state?.last),
    };
  }

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        turn: { type: "number" },
        visibleText: { type: "string" },
        hasTrigger: { type: "boolean" },
        hash: { type: ["string", "null"] },
        interrupted: { type: "boolean" },
        tools: { type: "array" },
        lastUserText: { type: "string" },
      },
    },
    init: () => createDraftState(),
    apply: reduceDraftState,
  }));

  ctx.on("agent/turn-stopping", ({ agent, signal }) => {
    if (disposed || signal.aborted || !acceptsParent(agent)) return;
    const draft = draftOf(agent);
    if (!draft?.hasTrigger || !draft.hash) return;
    const settings = snapshot.settings;
    if (!settings.autoReview) return;
    const main = currentSessionModel(ctx, agent.session.id);
    const mainRoute = main.provider && main.model ? { provider: main.provider, model: main.model } : null;
    const choice = chooseReviewer(mainRoute, settings);
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
      deliver(agent, "status", statusFailed(last), false);
      return;
    }
    const gate = shouldStartReview(stateOf(agent.session.id), {
      hash: draft.hash,
      explicit: false,
      autoReady: true,
    });
    if (!gate.ok) return;
    void launchReview(agent, {
      hash: draft.hash,
      contract: draft.visibleText,
      draft,
      reviewer: choice.reviewer,
      maxRevisions: settings.maxRevisions,
      explicit: false,
    });
  });

  ctx.tools.register({
    name: "promote",
    description: "对当前对话里最新一份未引用的执行契约发起次模型只读审核。标准代码围栏内的契约也审；引用行和行内代码中的标记不审。自动审核未开启或未触发时使用。同一契约哈希不会并行重复审核。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    timeoutMs: 15_000,
    output: {
      schema: { type: "object" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent;
      if (!agent?.session) return { ok: false, error: "需要当前会话" };
      if (!acceptsParent(agent)) return { ok: false, error: "审核子代理不得发起审核" };
      const draft = draftOf(agent);
      if (!draft?.hash || !hasTriggerSafe(draft)) {
        return { ok: false, error: "当前对话没有可审核的契约（可见正文须含未引用的 [END OF EXECUTION PROMPT]，写在代码围栏内也可以）" };
      }
      const settings = snapshot.settings;
      const main = currentSessionModel(ctx, agent.session.id);
      const mainRoute = main.provider && main.model ? { provider: main.provider, model: main.model } : null;
      const choice = chooseReviewer(mainRoute, settings);
      if (!choice.ok) return { ok: false, error: choice.reason, code: choice.code };
      return launchReview(agent, {
        hash: draft.hash,
        contract: draft.visibleText,
        draft,
        reviewer: choice.reviewer,
        maxRevisions: settings.maxRevisions,
        explicit: true,
      });
    },
  });

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") || "";
      if (request.method === "GET") {
        let settings;
        try {
          settings = await loadSettings(file);
          snapshot.settings = settings;
        } catch (error) {
          return jsonResponse(500, { ok: false, error: error.message ?? "读取设置失败" });
        }
        let routes = [];
        try { routes = await listRoutes(ctx); } catch { routes = []; }
        return jsonResponse(200, {
          ok: true,
          settings,
          routes,
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
      try {
        const saved = await saveSettings(body, file);
        if (!saved.ok) return jsonResponse(400, { ok: false, error: saved.error });
        snapshot.settings = saved.settings;
        let routes = [];
        try { routes = await listRoutes(ctx); } catch { routes = []; }
        return jsonResponse(200, {
          ok: true,
          settings: saved.settings,
          routes,
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
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });
}

function hasTriggerSafe(draft) {
  return Boolean(draft?.hasTrigger);
}

export { validateSettings, chooseReviewer, shouldStartReview };
