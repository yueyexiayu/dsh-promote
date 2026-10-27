import { sameRoute } from "./extract.js";

export function chooseReviewer(main, settings) {
  const modelA = settings?.modelA ?? null;
  const modelB = settings?.modelB ?? null;
  if (!modelA || !modelB) {
    return {
      ok: false,
      code: "UNCONFIGURED",
      reason: "未配置次模型 A 和 B，自动审核已禁用",
      reviewer: null,
    };
  }
  if (!main) {
    return {
      ok: false,
      code: "NO_MAIN",
      reason: "无法读取当前会话主模型，本轮不审",
      reviewer: null,
    };
  }
  if (sameRoute(modelA, main) && sameRoute(modelB, main)) {
    return {
      ok: false,
      code: "BOTH_MATCH_MAIN",
      reason: "次模型 A、B 都与当前会话主模型相同，禁止主模型自审，自动审核已禁用",
      reviewer: null,
    };
  }
  if (sameRoute(modelA, modelB)) {
    return {
      ok: false,
      code: "A_EQUALS_B",
      reason: "次模型 A 与 B 相同，拒绝使用，自动审核已禁用",
      reviewer: null,
    };
  }
  if (sameRoute(modelA, main)) {
    return { ok: true, reviewer: modelB, used: "B", fallback: true };
  }
  return { ok: true, reviewer: modelA, used: "A", fallback: false };
}

export function autoReviewReady(settings, choice) {
  if (!settings?.autoReview) {
    return { ok: false, reason: "自动审核已关闭" };
  }
  if (!choice?.ok) {
    return { ok: false, reason: choice?.reason ?? "次模型未就绪，自动审核已禁用" };
  }
  return { ok: true };
}
