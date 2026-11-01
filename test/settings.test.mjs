import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

test("maxRevisions must be an integer in 1–5", () => {
  assert.equal(validateSettings({ maxRevisions: 0 }).ok, false);
  assert.equal(validateSettings({ maxRevisions: 6 }).ok, false);
  assert.equal(validateSettings({ maxRevisions: true }).ok, false);
  assert.equal(validateSettings({ maxRevisions: null }).ok, false);
  assert.equal(validateSettings({ maxRevisions: "" }).ok, false);
  assert.equal(validateSettings(null).ok, false);
  assert.equal(validateSettings([]).ok, false);
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

test("concurrent saves never expose truncated settings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "promote-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  await saveSettings({ maxRevisions: 1 }, path);
  let running = true;
  let reads = 0;
  const reader = (async () => {
    while (running) {
      const settings = JSON.parse(await readFile(path, "utf8"));
      assert.ok(Number.isInteger(settings.maxRevisions));
      assert.ok(settings.maxRevisions >= 1 && settings.maxRevisions <= 5);
      reads++;
    }
  })();
  try {
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      saveSettings({ maxRevisions: i % 5 + 1 }, path)));
  } finally {
    running = false;
    await reader;
  }
  assert.ok(reads > 0);
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("a partial write failure preserves the original and removes its temporary file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "promote-write-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  const original = '{"maxRevisions": 2}\n';
  await writeFile(path, original);
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const realOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const file = await realOpen(...args);
      file.writeFile = async () => {
        await file.write("partial");
        throw Object.assign(new Error("simulated write failure"), { code: "EIO" });
      };
      return file;
    };
    syncBuiltinESMExports();
    const { saveSettings } = await import(${JSON.stringify(new URL("../lib/settings.js", import.meta.url).href)});
    try {
      await saveSettings({ maxRevisions: 3 }, process.argv[1]);
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== "EIO") throw error;
    }
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, path]);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("invalid persisted settings are reported and not overwritten", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "promote-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  for (const raw of ['{"maxRevisions": 99}', '{"maxRevisions": null}', '{"maxRevisions": ""}', 'null', '{broken']) {
    await writeFile(path, raw);
    await assert.rejects(loadSettings(path));
    assert.equal(await readFile(path, "utf8"), raw);
  }
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
