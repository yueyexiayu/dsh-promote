import { isPromoteSource, visibleText, hasUnquotedMarker, contractHash } from "./extract.js";

export function createDraftState(turn = 0) {
  return {
    turn,
    visibleText: "",
    hasTrigger: false,
    hash: null,
    interrupted: false,
    tools: [],
    lastUserText: "",
  };
}

export function reduceDraftState(state, event) {
  const data = event?.data;
  if (event?.type === "turn/start") return createDraftState(data?.turn ?? 0);
  if (event?.type === "user/message") {
    if (isPromoteSource(data?.source)) return state;
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
  return {
    ...state,
    visibleText: visible,
    interrupted,
    hasTrigger: !interrupted && hasUnquotedMarker(visible),
    hash: visible ? contractHash(visible) : null,
  };
}

export function toolSummary(state, limit = 40) {
  const names = (state?.tools ?? []).map((row) => row.name).filter(Boolean);
  if (names.length === 0) return "(本轮无工具调用)";
  const sliced = names.slice(0, limit);
  const extra = names.length > limit ? ` 等 ${names.length} 次` : "";
  return sliced.join(", ") + extra;
}
