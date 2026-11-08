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
    useRef(value) { return { current: value }; },
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
  assert.match(source, /view=reconcile/);
  assert.match(source, /解除未知审核/);
  assert.match(source, /setInterval\(poll, 4000\)/);
  assert.match(source, /Host v/);
  assert.match(source, /session-policy/);
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

test("slow save preserves later edits and polling reports disconnect and recovery", async () => {
  let component, state, cursor, effects = [], poll, resolveSave, resolveOldPoll;
  const requests = [];
  const settings = { modelA: null, modelB: null, maxRevisions: 3, autoReview: true };
  const payload = { ok: true, settings, routes: [], session: { last: null } };
  const React = {
    Fragment: "fragment",
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(seed) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof seed === "function" ? seed() : seed;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useRef(value) { const index = cursor++; if (!(index in state)) state[index] = { current: value }; return state[index]; },
    useEffect(fn) { if (effects.length < 2) effects.push(fn); },
  };
  const response = (body) => ({ ok: true, json: async () => body });
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(module) {
      const client = module.factory(() => React);
      client.apply({ effect(fn) { fn(); }, sidebarRightTabs: { register() {} }, slots: {
        inject(_name, fn) { fn(); }, register(meta, body) { if (meta.name === "sidebar.right.pane.tab") component = body; },
      } });
    } } },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
    AbortController,
    setInterval(fn) { poll = fn; return 1; }, clearInterval() {},
    fetch(url, options = {}) {
      requests.push({ url, options });
      if (options.method === "POST") return new Promise((resolve) => { resolveSave = resolve; });
      if (url.includes("view=session")) {
        const count = requests.filter((r) => r.url.includes("view=session")).length;
        if (count === 1) return new Promise((resolve) => { resolveOldPoll = resolve; });
        if (count === 2) return Promise.reject(new Error("offline"));
        return Promise.resolve(response({ ok: true, session: { last: { status: "passed" } } }));
      }
      return Promise.resolve(response(payload));
    },
  });
  state = [];
  function render() { cursor = 0; return component({ sessionId: "session-1" }); }
  function find(node, predicate) {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      for (const item of Array.isArray(child) ? child : [child]) {
        const found = find(item, predicate); if (found) return found;
      }
    }
    return null;
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  render(); effects.forEach((fn) => fn()); await flush();
  let tree = render();
  poll();
  find(tree, (n) => n.props.id === "promote-a").props.onChange({ target: { value: "xai/first" } });
  tree = render();
  find(tree, (n) => n.type === "button" && n.children[0] === "保存设置").props.onClick();
  tree = render();
  find(tree, (n) => n.props.id === "promote-a").props.onChange({ target: { value: "xai/later" } });
  resolveSave(response({ ...payload, settings: { ...settings, modelA: { provider: "xai", model: "first" } } }));
  await flush(); tree = render();
  assert.equal(find(tree, (n) => n.props.id === "promote-a").props.value, "xai/later");
  assert.ok(find(tree, (n) => n.children[0]?.includes?.("后续修改尚未保存")));
  assert.ok(find(tree, (n) => n.props.role === "alert" && n.children[0].includes("可能已过期")));
  resolveOldPoll(response({ ok: true, session: { last: { status: "stale-poll" } } }));
  await flush(); tree = render();
  assert.equal(find(tree, (n) => typeof n.children[0] === "string" && n.children[0].includes("stale-poll")), null);
  assert.ok(find(tree, (n) => n.props.role === "alert" && n.children[0].includes("可能已过期")));
  poll(); await flush(); tree = render();
  assert.ok(find(tree, (n) => n.props.role === "alert" && n.children[0].includes("连接失败")));
  assert.equal(find(tree, (n) => n.props.id === "promote-a").props.value, "xai/later");
  poll(); await flush(); tree = render();
  assert.equal(find(tree, (n) => n.props.role === "alert"), null);
  assert.ok(find(tree, (n) => typeof n.children[0] === "string" && n.children[0].includes("passed")));
});

test("switching sessions hides stale state and late save cannot restore it", async () => {
  let component, cursor = 0, state = [], effectState = [], pendingEffects = [], saveResolve;
  let sessionId = "A";
  const settings = { modelA: null, modelB: null, maxRevisions: 3, autoReview: true };
  const response = (body) => ({ ok: true, json: async () => body });
  const data = (id) => ({ ok: true, settings, routes: [], session: { last: { status: `status-${id}` } } });
  const React = {
    Fragment: "fragment",
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(seed) { const i = cursor++; if (!(i in state)) state[i] = typeof seed === "function" ? seed() : seed;
      return [state[i], (v) => { state[i] = typeof v === "function" ? v(state[i]) : v; }]; },
    useRef(value) { const i = cursor++; if (!(i in state)) state[i] = { current: value }; return state[i]; },
    useEffect(fn, deps) { const i = cursor++; const old = effectState[i];
      if (!old || deps.some((v, n) => v !== old.deps[n])) pendingEffects.push(() => {
        if (old?.cleanup) old.cleanup(); effectState[i] = { deps, cleanup: fn() };
      }); },
  };
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(module) { module.factory(() => React).apply({
      effect(fn) { fn(); }, sidebarRightTabs: { register() {} }, slots: { inject(_n, fn) { fn(); },
        register(meta, body) { if (meta.name === "sidebar.right.pane.tab") component = body; } },
    }); } } },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
    AbortController, setInterval() { return 1; }, clearInterval() {},
    fetch(url, options = {}) { if (options.method === "POST") return new Promise((resolve) => { saveResolve = resolve; });
      return Promise.resolve(response(data(new URL(url, "http://localhost").searchParams.get("sessionId")))); },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  function render() { cursor = 0; return component({ sessionId }); }
  function runEffects() { const effects = pendingEffects; pendingEffects = []; effects.forEach((fn) => fn()); }
  function find(node, pred) { if (!node || typeof node !== "object") return null; if (pred(node)) return node;
    for (const child of (node.children || []).flat()) { const found = find(child, pred); if (found) return found; } return null; }
  const has = (tree, value) => !!find(tree, (n) => typeof n.children[0] === "string" && n.children[0].includes(value));
  render(); runEffects(); await flush(); let tree = render();
  assert.ok(has(tree, "status-A"));
  find(tree, (n) => n.type === "button" && n.children[0] === "保存设置").props.onClick();
  sessionId = "B"; tree = render(); assert.equal(has(tree, "status-A"), false);
  runEffects(); await flush(); tree = render(); assert.ok(has(tree, "status-B"));
  saveResolve(response(data("A"))); await flush(); tree = render();
  assert.ok(has(tree, "status-B")); assert.equal(has(tree, "status-A"), false);
  sessionId = "A"; tree = render(); assert.equal(has(tree, "status-B"), false);
  assert.equal(has(tree, "status-A"), false);
});

test("late refresh cannot overwrite a successful save, including errors and session switches", async (t) => {
  for (const scenario of ["stale-success", "stale-http-error", "stale-network-error", "switch-session", "failed-save"]) {
    await t.test(scenario, async () => {
      let component, cursor = 0, state = [], effects = [], pending = [], sessionId = "A";
      const requests = [];
      const settings = (model) => ({ modelA: { provider: "xai", model }, modelB: null, maxRevisions: 3, autoReview: true });
      const data = (id, model, status) => ({ ok: true, settings: settings(model), routes: [], session: { last: { status: `${id}-${status}` } } });
      const response = (body, ok = true) => ({ ok, json: async () => body });
      const React = {
        Fragment: "fragment", createElement(type, props, ...children) { return { type, props: props || {}, children }; },
        useState(seed) { const i = cursor++; if (!(i in state)) state[i] = typeof seed === "function" ? seed() : seed;
          return [state[i], (v) => { state[i] = typeof v === "function" ? v(state[i]) : v; }]; },
        useRef(value) { const i = cursor++; if (!(i in state)) state[i] = { current: value }; return state[i]; },
        useEffect(fn, deps) { const i = cursor++, old = effects[i];
          if (!old || deps.some((v, n) => v !== old.deps[n])) pending.push(() => {
            if (old?.cleanup) old.cleanup(); effects[i] = { deps, cleanup: fn() };
          }); },
      };
      vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
        window: { __ModuleLoader__: { load(module) { module.factory(() => React).apply({
          effect(fn) { fn(); }, sidebarRightTabs: { register() {} }, slots: { inject(_n, fn) { fn(); },
            register(meta, body) { if (meta.name === "sidebar.right.pane.tab") component = body; } },
        }); } } },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        AbortController, setInterval() { return 1; }, clearInterval() {},
        fetch(url, options = {}) { return new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); }); },
      });
      const flush = () => new Promise((resolve) => setImmediate(resolve));
      function render() { cursor = 0; return component({ sessionId }); }
      function runEffects() { const batch = pending; pending = []; batch.forEach((fn) => fn()); }
      function find(node, pred) { if (!node || typeof node !== "object") return null; if (pred(node)) return node;
        for (const child of (node.children || []).flat()) { const found = find(child, pred); if (found) return found; } return null; }
      const has = (tree, text) => !!find(tree, (n) => typeof n.children[0] === "string" && n.children[0].includes(text));
      const button = (tree, text) => find(tree, (n) => n.type === "button" && n.children[0] === text);
      render(); runEffects(); requests[0].resolve(response(data("A", "old", "old"))); await flush();
      let tree = render(); button(tree, "刷新").props.onClick(); tree = render(); runEffects();
      let stale = requests[1];
      find(tree, (n) => n.props.id === "promote-a").props.onChange({ target: { value: "xai/new" } });
      tree = render(); button(tree, "保存设置").props.onClick(); const save = requests[2];
      if (scenario === "switch-session") { sessionId = "B"; render(); runEffects(); stale = requests[3]; }
      if (scenario === "failed-save") save.resolve(response({ ok: false, error: "save failed" }, false));
      else save.resolve(response(data("A", "new", "saved")));
      await flush(); tree = render(); runEffects();
      if (scenario === "stale-network-error") stale.reject(new Error("offline"));
      else if (scenario === "stale-http-error") stale.resolve(response({ ok: false, error: "stale error" }, false));
      else stale.resolve(response(data(scenario === "switch-session" ? "B" : "A", "old", "old")));
      await flush(); tree = render();
      assert.equal(find(tree, (n) => n.props.id === "promote-a").props.value, "xai/new");
      if (scenario === "failed-save") assert.ok(has(tree, "save failed"));
      else {
        assert.equal(has(tree, "stale error"), false);
        assert.equal(has(tree, "读取设置失败"), false);
        if (scenario !== "switch-session") { assert.ok(has(tree, "A-saved")); assert.equal(has(tree, "A-old"), false); }
        else {
          const newest = requests[requests.length - 1];
          assert.match(newest.url, /sessionId=B/);
          newest.resolve(response(data("B", "new", "current"))); await flush(); tree = render();
          assert.ok(has(tree, "B-current")); assert.equal(has(tree, "A-saved"), false);
        }
      }
    });
  }
});

test("package.json client inject includes the right-sidebar slot host", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dsh.client.inject, ["@deepseek-ai/dsh-client-ui-sidebar-right"]);
  assert.equal(pkg.main, "lib/index.js");
});
