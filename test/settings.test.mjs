import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings, validateSettings } from "../lib/settings.js";

test("saving A equal to B is rejected", () => {
  const result = validateSettings({
    modelA: "xai/grok-4.5",
    modelB: "xai/grok-4.5",
    maxRevisions: 3,
    autoReview: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /不能相同/);
});

test("maxRevisions is clamped to 1–5", () => {
  assert.equal(validateSettings({ maxRevisions: 0 }).ok, false);
  assert.equal(validateSettings({ maxRevisions: 6 }).ok, false);
  assert.equal(validateSettings({ maxRevisions: 3 }).settings.maxRevisions, 3);
});

test("settings persist with 0600 and missing file yields defaults", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "promote-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  const missing = await loadSettings(path);
  assert.equal(missing.autoReview, true);
  assert.equal(missing.modelA, null);
  const saved = await saveSettings({
    modelA: { provider: "xai", model: "grok-4.5" },
    modelB: { provider: "openai-codex", model: "gpt-6-astra" },
    maxRevisions: 2,
    autoReview: false,
  }, path);
  assert.equal(saved.ok, true);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.maxRevisions, 2);
  const loaded = await loadSettings(path);
  assert.deepEqual(loaded.modelA, { provider: "xai", model: "grok-4.5" });
});

test("reasoning effort is persisted and invalid effort is rejected", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "promote-effort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  const invalid = validateSettings({
    modelA: "xai/grok-4.6",
    effortA: "not an effort",
    modelB: "openai-codex/gpt-6-astra",
    effortB: "high",
  });
  assert.equal(invalid.ok, false);
  const saved = await saveSettings({
    modelA: "xai/grok-4.6",
    effortA: "high",
    modelB: { provider: "openai-codex", model: "gpt-6-astra", reasoningEffort: "xhigh" },
  }, path);
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.modelA.reasoningEffort, "high");
  assert.equal(saved.settings.modelB.reasoningEffort, "xhigh");
  const loaded = await loadSettings(path);
  assert.equal(loaded.modelA.reasoningEffort, "high");
});
