import { createHash } from "node:crypto";
import { MARKER, SOURCE_PREFIX } from "./constants.js";

export function isPromoteSource(source) {
  return typeof source?.kind === "string" && source.kind.startsWith(SOURCE_PREFIX);
}

export function visibleText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

const FENCE = /```[\w+-]*[ \t]*\r?\n?([\s\S]*?)```/g;
const TILDE_FENCE = /~~~[\w+-]*[ \t]*\r?\n?([\s\S]*?)~~~/g;
const INLINE_CODE = /`[^`\n]*`/g;

export function stripQuotedAndFenced(text) {
  let source = String(text ?? "");
  source = source.replace(FENCE, "\n$1\n");
  source = source.replace(TILDE_FENCE, "\n$1\n");
  source = source.replace(INLINE_CODE, " ");
  return source
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

export function hasUnquotedMarker(text) {
  return stripQuotedAndFenced(text).includes(MARKER);
}

export function contractHash(text) {
  return createHash("sha256").update(Buffer.from(String(text ?? ""), "utf8")).digest("hex");
}

export function shortHash(hash) {
  return String(hash ?? "").slice(0, 8);
}

export function parseEffort(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const effort = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(effort)) return undefined;
  return effort;
}

export function formatRoute(route) {
  if (!route || typeof route.provider !== "string" || typeof route.model !== "string") return "";
  return `${route.provider}/${route.model}`;
}

export function formatReviewer(route) {
  const base = formatRoute(route);
  if (!base) return "";
  return route.reasoningEffort ? `${base} · ${route.reasoningEffort}` : base;
}

export function reviewerOptions(reviewer) {
  if (!reviewer?.provider || !reviewer?.model) return null;
  return {
    provider: reviewer.provider,
    model: reviewer.model,
    ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
  };
}

function routeFromParts(provider, model, effortRaw) {
  if (!provider || !model) return null;
  const effort = parseEffort(effortRaw);
  if (effort === undefined) return null;
  return effort ? { provider, model, reasoningEffort: effort } : { provider, model };
}

export function parseRoute(value, effortValue) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const provider = typeof value.provider === "string" ? value.provider.trim() : "";
    const model = typeof value.model === "string" ? value.model.trim() : "";
    return routeFromParts(provider, model, effortValue !== undefined ? effortValue : value.reasoningEffort ?? value.effort);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return routeFromParts(trimmed.slice(0, slash).trim(), trimmed.slice(slash + 1).trim(), effortValue);
}

export function sameRoute(a, b) {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model);
}
