export const PLUGIN_ID = "promote";
export const PLUGIN_VERSION = "0.1.10";
export const API_PATH = "/api/promote";
export const MARKER = "[END OF EXECUTION PROMPT]";
export const TIMEOUT_MS = 120_000;
export const TOOL_TIMEOUT_MS = TIMEOUT_MS + 20_000;
export const SOURCE_PREFIX = "plugin:promote";
export const PROJECTION_KEY = "promote/draft";
export const DEFAULT_MAX_REVISIONS = 3;
export const MIN_REVISIONS = 1;
export const MAX_REVISIONS = 5;
export const ROUTES_TTL_MS = 15_000;
export const WRITE_TOOLS = Object.freeze(["edit", "write", "multi_edit", "bash", "str_replace_editor"]);
export const READ_TOOLS = Object.freeze(["read", "grep", "glob", "read_image"]);
export const LSP_TOOL = "lsp";
export const LSP_CHAIN_OPS = Object.freeze(["goToDefinition", "findReferences", "goToImplementation"]);
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
  },
  required: ["passed", "issues", "suggestions", "pathsRead"],
});
