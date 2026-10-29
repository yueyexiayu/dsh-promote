import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadClient() {
  let exports;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: "fragment",
    useState(seed) { const value = typeof seed === "function" ? seed() : seed; return [value, () => {}]; },
    useEffect() {},
  };
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(module) { exports = module.factory(() => React); } } },
    document: { getElementById: () => null, createElement: () => ({ textContent: "" }), head: { appendChild() {} } },
  });
  return { exports, React };
}

test("client inject lists every ctx service read in apply, and registers unique promote kind", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(source, /var inject = \["slots", "sidebarRightTabs"\]/);
  assert.match(source, /promote-a-effort/);
  assert.match(source, /promote-b-effort/);
  assert.match(source, /推理强度/);
  assert.match(source, /审核模型（次模型）/);
  assert.match(source, /审核规则/);
  assert.match(source, /dirty: true/);
  assert.match(source, /prev.dirty \|\| prev.saving/);
  assert.match(source, /已改未保存/);
  assert.match(source, /刷新/);
  assert.match(source, /promote-actions/);
  assert.match(source, /view=session/);
  assert.match(source, /setInterval\(poll, 4000\)/);
  assert.match(source, /Host v/);
  assert.doesNotMatch(source, /ctx\.uiConversation/);
  const { exports } = loadClient();
  assert.equal(JSON.stringify(exports.inject), JSON.stringify(["slots", "sidebarRightTabs"]));
  const registered = {};
  const slots = [];
  exports.apply({
    effect(callback) { callback(); },
    sidebarRightTabs: {
      register(options) { registered.tab = options; return () => {}; },
    },
    slots: {
      inject(name, factory) { factory(); },
      register(meta) { slots.push(meta); return meta; },
    },
  });
  assert.equal(registered.tab.id, "promote");
  assert.equal(registered.tab.kind, "promote");
  assert.deepEqual(slots.map((row) => row.key || row.name), ["promote", "promote"]);
});

test("package.json client inject includes the right-sidebar slot host", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dsh.client.inject, ["@deepseek-ai/dsh-client-ui-sidebar-right"]);
  assert.equal(pkg.main, "lib/index.js");
});
