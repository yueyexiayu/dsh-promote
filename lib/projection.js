import { isPromoteSource, visibleText, hasUnquotedMarker, contractHash } from "./extract.js";

export const MAX_ORPHAN_REVIEWING = 128;

export function createDraftState(turn = 0) {
  return {
    turn,
    visibleText: "",
    hasTrigger: false,
    hash: null,
    interrupted: false,
    tools: [],
    lastUserText: "",
    latestDraft: null,
    reviewOutcome: null,
    orphanReviewing: [],
    orphanOverflow: false,
  };
}

export function reduceDraftState(state, event) {
  const data = event?.data;
  if (event?.type === "turn/start") {
    return { ...createDraftState(data?.turn ?? 0), latestDraft: state.latestDraft ?? null, reviewOutcome: state.reviewOutcome ?? null,
      orphanReviewing: state.orphanReviewing, orphanOverflow: state.orphanOverflow };
  }
  if (event?.type === "user/message") {
    if (isPromoteSource(data?.source)) {
      const source = data.source;
      if (source.kind === "plugin:promote:retired") {
        if (typeof source.promoteHash !== "string" || !/^[a-f0-9]{64}$/.test(source.promoteHash)) return state;
        return { ...state, orphanReviewing: state.orphanReviewing.filter((hash) => hash !== source.promoteHash) };
      }
      if (source.kind !== "plugin:promote:status") return state;
      const valid = /^[a-f0-9]{64}$/.test(source.promoteHash)
        && ["reviewing", "failed", "passed", "exhausted", "needs-revision"].includes(source.promoteStatus)
        && typeof source.promoteRetryable === "boolean"
        && (source.promoteCode === undefined || (typeof source.promoteCode === "string" && /^[A-Z_]+$/.test(source.promoteCode)));
      if (!valid) return { ...state, reviewOutcome: null };
      const hash = source.promoteHash;
      const existing = state.orphanReviewing;
      const reviewing = source.promoteStatus === "reviewing";
      const overflow = reviewing && !existing.includes(hash) && existing.length >= MAX_ORPHAN_REVIEWING;
      const orphanReviewing = reviewing
        ? existing.includes(hash) || overflow ? existing : [...existing, hash]
        : existing.filter((item) => item !== hash);
      return { ...state, orphanReviewing, orphanOverflow: state.orphanOverflow || overflow,
        reviewOutcome: { hash, status: source.promoteStatus, retryable: source.promoteRetryable,
          ...(source.promoteCode ? { code: source.promoteCode } : {}) } };
    }
    const text = visibleText(data?.content);
    if (data?.source?.kind === "user" && text.trim()) return { ...state, lastUserText: text };
    return state;
  }
  if (data?.turn !== state.turn) return state;
  if (event?.type === "tool/call" && typeof data?.name === "string") {
    return { ...state, tools: [...state.tools, { name: data.name }] };
  }
  if (event?.type !== "assistant/message") return state;
  const visible = visibleText(data?.message?.content);
  const interrupted = Boolean(data?.interrupted);
  const marker = hasUnquotedMarker(visible);
  const hasTrigger = !interrupted && marker;
  const hash = visible ? contractHash(visible) : null;
  const latestDraft = hasTrigger
    ? { turn: state.turn, visibleText: visible, hasTrigger: true, hash, interrupted: false,
        tools: state.tools, lastUserText: state.lastUserText }
    : interrupted && marker ? null : state.latestDraft ?? null;
  return { ...state, visibleText: visible, interrupted, hasTrigger, hash, latestDraft };
}

export const draftStateSchema = {
  parse(state) {
    const validDraft = (value) => value && typeof value === "object"
      && Number.isSafeInteger(value.turn) && value.turn >= 0
      && typeof value.visibleText === "string" && typeof value.hasTrigger === "boolean"
      && (value.hash === null || typeof value.hash === "string")
      && typeof value.interrupted === "boolean" && Array.isArray(value.tools)
      && value.tools.every((item) => item && typeof item.name === "string")
      && typeof value.lastUserText === "string";
    if (!validDraft(state) || !Array.isArray(state.orphanReviewing)
      || state.orphanReviewing.length > MAX_ORPHAN_REVIEWING
      || state.orphanReviewing.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      || new Set(state.orphanReviewing).size !== state.orphanReviewing.length
      || typeof state.orphanOverflow !== "boolean"
      || !(state.latestDraft === null || (validDraft(state.latestDraft)
      && state.latestDraft.hasTrigger && !state.latestDraft.interrupted
      && hasUnquotedMarker(state.latestDraft.visibleText)
      && state.latestDraft.hash === contractHash(state.latestDraft.visibleText)))
      || !(state.reviewOutcome === null || (state.reviewOutcome && /^[a-f0-9]{64}$/.test(state.reviewOutcome.hash)
        && ["reviewing", "failed", "passed", "exhausted", "needs-revision"].includes(state.reviewOutcome.status)
        && typeof state.reviewOutcome.retryable === "boolean"
        && (state.reviewOutcome.code === undefined || (typeof state.reviewOutcome.code === "string" && /^[A-Z_]+$/.test(state.reviewOutcome.code)))))) {
      throw new Error("promote: invalid draft projection checkpoint");
    }
    return state;
  },
};

export function toolSummary(state, limit = 40) {
  const names = (state?.tools ?? []).map((row) => row.name).filter(Boolean);
  if (names.length === 0) return "(本轮无工具调用)";
  const sliced = names.slice(0, limit);
  const extra = names.length > limit ? ` 等 ${names.length} 次` : "";
  return sliced.join(", ") + extra;
}
