export const PLUGIN_ID = "promote";
export const PLUGIN_VERSION = "0.1.26";
export const API_PATH = "/api/promote";
export const MARKER = "[END OF EXECUTION PROMPT]";
export const TIMEOUT_MS = 1_200_000;
export const TOOL_TIMEOUT_MS = TIMEOUT_MS + 20_000;
export const SOURCE_PREFIX = "plugin:promote";
export const PROJECTION_KEY = "promote/draft";
export const DEFAULT_MAX_REVISIONS = 3;
export const MIN_REVISIONS = 1;
export const MAX_REVISIONS = 5;
export const ROUTES_TTL_MS = 15_000;
export const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    passed: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string" },
          summary: { type: "string" },
          detail: { type: "string" },
        },
        required: ["summary"],
      },
    },
    suggestions: { type: "array", items: { type: "string" } },
    pathsRead: { type: "array", items: { type: "string" } },
    reviewChain: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, line: { type: "integer" }, character: { type: "integer" },
        callSite: { type: "object", additionalProperties: false,
          properties: { line: { type: "integer" }, character: { type: "integer" } }, required: ["line", "character"] } },
      required: ["path", "line", "character"] } },
  },
  required: ["passed", "issues", "suggestions", "pathsRead", "reviewChain"],
});
