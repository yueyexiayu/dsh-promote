import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_REVISIONS, MAX_REVISIONS, MIN_REVISIONS } from "./constants.js";
import { parseRoute, sameRoute } from "./extract.js";

export function settingsPath(home = process.env.DSH_HOME) {
  const root = typeof home === "string" && home.trim() ? home.trim() : join(homedir(), ".dsh");
  return join(root, "storages", "promote", "settings.json");
}

export function defaultSettings() {
  return {
    modelA: null,
    modelB: null,
    maxRevisions: DEFAULT_MAX_REVISIONS,
    autoReview: true,
  };
}

export function validateSettings(input) {
  const defaults = defaultSettings();
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const modelA = parseRoute(source.modelA, source.effortA);
  const modelB = parseRoute(source.modelB, source.effortB);
  if ((source.modelA != null && source.modelA !== "" && !modelA)
    || (source.modelB != null && source.modelB !== "" && !modelB)) {
    return { ok: false, error: "次模型必须是 provider/model，推理强度须为非空标识" };
  }
  if (modelA && modelB && sameRoute(modelA, modelB)) {
    return { ok: false, error: "次模型 A 与 B 不能相同" };
  }
  let maxRevisions = defaults.maxRevisions;
  if (source.maxRevisions !== undefined && source.maxRevisions !== null && source.maxRevisions !== "") {
    const n = Number(source.maxRevisions);
    if (!Number.isSafeInteger(n) || n < MIN_REVISIONS || n > MAX_REVISIONS) {
      return { ok: false, error: `最大修改次数必须是 ${MIN_REVISIONS}–${MAX_REVISIONS} 的整数` };
    }
    maxRevisions = n;
  }
  let autoReview = defaults.autoReview;
  if (source.autoReview !== undefined) {
    if (typeof source.autoReview !== "boolean") return { ok: false, error: "自动审核开关必须是布尔值" };
    autoReview = source.autoReview;
  }
  return {
    ok: true,
    settings: { modelA, modelB, maxRevisions, autoReview },
  };
}

export async function loadSettings(path = settingsPath()) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const validated = validateSettings(parsed);
    if (!validated.ok) return defaultSettings();
    return validated.settings;
  } catch (error) {
    if (error && error.code === "ENOENT") return defaultSettings();
    throw error;
  }
}

export async function saveSettings(input, path = settingsPath()) {
  const validated = validateSettings(input);
  if (!validated.ok) return validated;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(validated.settings, null, 2)}\n`;
  await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return validated;
}
