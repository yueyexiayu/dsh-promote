window.__ModuleLoader__.load({
  id: "promote",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots", "sidebarRightTabs"];
    var TAB_ID = "promote";
    var TAB_KIND = "promote";
    var API_PATH = "/api/promote";
    var STYLE_ID = "promote-style";
    var VERSION = "0.1.10";

    var cssText = [
      ".promote-root { display: flex; flex-direction: column; gap: 12px; padding: 12px; height: 100%; box-sizing: border-box; overflow: auto; font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif); font-size: 13px; color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-bg-base, #ffffff); }",
      ".promote-title { font-weight: 600; font-size: 14px; }",
      ".promote-row { display: flex; flex-direction: column; gap: 4px; }",
      ".promote-label { color: var(--dsw-alias-label-secondary, #868e96); font-size: 12px; }",
      ".promote-value { font-variant-numeric: tabular-nums; }",
      ".promote-input, .promote-select { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 10px; padding: 6px 8px; background: var(--dsw-alias-bg-base, #ffffff); color: inherit; font: inherit; }",
      ".promote-check { display: flex; align-items: center; gap: 8px; }",
      ".promote-btn { align-self: flex-start; background: transparent; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 10px; color: inherit; cursor: pointer; font-size: 12px; padding: 4px 10px; }",
      ".promote-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #eceff4); }",
      ".promote-btn:disabled { opacity: 0.45; cursor: default; }",
      ".promote-input:focus, .promote-select:focus, .promote-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #3478e5); outline-offset: 2px; }",
      ".promote-actions { display: flex; flex-wrap: wrap; gap: 8px; }",
      ".promote-warn { color: var(--dsw-alias-state-warn-secondary, #c2410c); font-size: 12px; line-height: 1.5; }",
      ".promote-error { color: var(--dsw-alias-danger-fg, #c92a2a); font-size: 12px; }",
      ".promote-status { padding: 8px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #f7f7f8); font-size: 12px; line-height: 1.5; white-space: pre-wrap; }",
      ".promote-muted { color: var(--dsw-alias-label-secondary, #868e96); }",
      ".promote-card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #f7f7f8); }",
      ".promote-card-title { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-secondary, #868e96); }",
      ".promote-reviewer { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; word-break: break-all; }",
      ".promote-rules { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; }",
    ].join(" ");

    function ensureStyle() {
      var existing = document.getElementById(STYLE_ID);
      if (existing) {
        existing.textContent = cssText;
        return;
      }
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function sessionIdOf(props, tabInfo) {
      if (props && typeof props.sessionId === "string" && props.sessionId) return props.sessionId;
      if (props && props.session && typeof props.session.id === "string") return props.session.id;
      if (tabInfo && tabInfo.tab && typeof tabInfo.tab.sessionId === "string") return tabInfo.tab.sessionId;
      return "";
    }

    function routeText(route) {
      if (!route || !route.provider || !route.model) return "";
      return route.provider + "/" + route.model;
    }

    function reviewerText(route) {
      var base = routeText(route);
      if (!base) return "";
      return route.reasoningEffort ? base + " · " + route.reasoningEffort : base;
    }

    function effortsFor(routes, modelKey) {
      if (!modelKey) return [];
      for (var i = 0; i < routes.length; i++) {
        var route = routes[i];
        if (route.provider + "/" + route.model === modelKey) return route.efforts || [];
      }
      return [];
    }

    function defaultEffort(routes, modelKey, current) {
      var list = effortsFor(routes, modelKey);
      if (current && list.some(function (item) { return item.id === current; })) return current;
      for (var i = 0; i < list.length; i++) {
        if (list[i].default) return list[i].id;
      }
      return list[0] ? list[0].id : "";
    }

    function effortOptions(routes, modelKey, current) {
      var list = effortsFor(routes, modelKey);
      var nodes = [React.createElement("option", { key: "", value: "" }, list.length ? "模型默认" : "该模型未公布推理强度，将用默认")];
      var seen = { "": true };
      list.forEach(function (item) {
        seen[item.id] = true;
        nodes.push(React.createElement("option", { key: item.id, value: item.id }, item.default ? item.id + " · " + (item.name || item.id) + "（默认）" : (item.name && item.name !== item.id ? item.id + " · " + item.name : item.id)));
      });
      if (current && !seen[current]) {
        nodes.push(React.createElement("option", { key: current, value: current }, current));
      }
      return nodes;
    }

    function PromoteGlyph(props) {
      var size = props && props.size != null ? props.size : 26;
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.7",
          className: props && props.className,
          "aria-hidden": "true",
        },
        React.createElement("path", { d: "M7 4h10v16l-5-3-5 3V4z" }),
        React.createElement("path", { d: "M9 10h6M9 13h4" }),
      );
    }

    function PromoteTitle() {
      return React.createElement("span", null, "Promote");
    }

    function PromotePane(props) {
      var tabInfo = typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
      var sessionId = sessionIdOf(props, tabInfo);
      var stateAndSet = React.useState(function () {
        return { loading: true, saving: false, dirty: false, error: "", notice: "", payload: null, modelA: "", modelB: "", effortA: "", effortB: "", maxRevisions: 3, autoReview: true };
      });
      var ui = stateAndSet[0];
      var setUi = stateAndSet[1];

      function patchForm(fields) {
        setUi(function (prev) {
          return Object.assign({}, prev, fields, { dirty: true, notice: "" });
        });
      }

      var tickState = React.useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      React.useEffect(function () {
        var cancelled = false;
        var controller = null;
        function applyPayload(payload, overwriteForm) {
          var settings = payload && payload.settings ? payload.settings : {};
          setUi(function (prev) {
            var next = Object.assign({}, prev, {
              loading: false,
              payload: payload,
            });
            if (!overwriteForm && (prev.dirty || prev.saving)) return next;
            next.saving = false;
            next.dirty = false;
            next.error = "";
            next.modelA = routeText(settings.modelA) || prev.modelA;
            next.modelB = routeText(settings.modelB) || prev.modelB;
            next.effortA = settings.modelA && settings.modelA.reasoningEffort || prev.effortA;
            next.effortB = settings.modelB && settings.modelB.reasoningEffort || prev.effortB;
            next.maxRevisions = settings.maxRevisions != null ? settings.maxRevisions : prev.maxRevisions;
            next.autoReview = settings.autoReview !== undefined ? settings.autoReview : prev.autoReview;
            return next;
          });
        }
        function load() {
          if (controller) controller.abort();
          controller = new AbortController();
          var query = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
          fetch(API_PATH + query, { signal: controller.signal })
            .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
            .then(function (result) {
              if (cancelled) return;
              if (!result.ok || !result.body || result.body.ok === false) {
                setUi(function (prev) {
                  if (prev.dirty || prev.saving) return prev;
                  return Object.assign({}, prev, { loading: false, error: (result.body && result.body.error) || "读取设置失败" });
                });
                return;
              }
              applyPayload(result.body, false);
            })
            .catch(function (error) {
              if (cancelled || error.name === "AbortError") return;
              setUi(function (prev) {
                if (prev.dirty || prev.saving) return prev;
                return Object.assign({}, prev, { loading: false, error: "读取设置失败" });
              });
            });
        }
        load();
        return function () {
          cancelled = true;
          if (controller) controller.abort();
        };
      }, [sessionId, tick]);

      React.useEffect(function () {
        if (!sessionId) return;
        var cancelled = false;
        function poll() {
          fetch(API_PATH + "?sessionId=" + encodeURIComponent(sessionId) + "&view=session")
            .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
            .then(function (result) {
              if (cancelled || !result.ok || !result.body || result.body.ok === false) return;
              setUi(function (prev) {
                if (!prev.payload) return prev;
                return Object.assign({}, prev, {
                  payload: Object.assign({}, prev.payload, { session: result.body.session }),
                });
              });
            })
            .catch(function () {});
        }
        var timer = setInterval(poll, 4000);
        return function () {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      function refresh() {
        setTick(function (n) { return n + 1; });
      }

      function save() {
        setUi(function (prev) { return Object.assign({}, prev, { saving: true, error: "", notice: "" }); });
        var query = sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "";
        fetch(API_PATH + query, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelA: ui.modelA,
            modelB: ui.modelB,
            effortA: ui.effortA,
            effortB: ui.effortB,
            maxRevisions: Number(ui.maxRevisions),
            autoReview: ui.autoReview,
          }),
        }).then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
          .then(function (result) {
            if (!result.ok || !result.body || result.body.ok === false) {
              setUi(function (prev) {
                return Object.assign({}, prev, { saving: false, error: (result.body && result.body.error) || "保存失败" });
              });
              return;
            }
            var settings = result.body.settings || {};
            setUi(function (prev) {
              return Object.assign({}, prev, {
                saving: false,
                dirty: false,
                error: "",
                notice: "已保存",
                payload: result.body,
                modelA: routeText(settings.modelA),
                modelB: routeText(settings.modelB),
                effortA: settings.modelA && settings.modelA.reasoningEffort || "",
                effortB: settings.modelB && settings.modelB.reasoningEffort || "",
                maxRevisions: settings.maxRevisions,
                autoReview: settings.autoReview,
              });
            });
          })
          .catch(function () {
            setUi(function (prev) { return Object.assign({}, prev, { saving: false, error: "保存失败" }); });
          });
      }

      var session = ui.payload && ui.payload.session;
      var unassociated = !sessionId || (session && session.unassociated);
      var routes = (ui.payload && ui.payload.routes) || [];
      var last = session && session.last;
      var rules = (ui.payload && ui.payload.rules) || {};
      var criteria = rules.criteria || [];
      var constraints = rules.constraints || ["只读审核，不是写作端", "禁止 edit / write / multi_edit / bash，禁止改配置、提交、写文件", "审核子代理切到 read-only 沙箱", "用 read/grep/glob 打开源码，并用 lsp 追调用链", "未观察到 lsp 定义/引用查询不得判通过"];
      var versionWarn = ui.payload && ui.payload.version && ui.payload.version !== VERSION
        ? ("Host v" + ui.payload.version + " 与 Client v" + VERSION + " 不一致；请 ⌘Q 完全重启后再用。")
        : "";
      var autoDisabled = unassociated || (session && session.autoDisabled);
      var autoReason = unassociated
        ? "未关联会话，不得用 Host 默认策略冒充当前主模型"
        : session && session.autoDisabledReason;
      var reviewerNote = session && session.usedSlot === "B"
        ? "A 与当前会话主模型相同，本轮审核改用 B"
        : session && session.usedSlot === "A"
          ? "本轮审核使用次模型 A"
          : "";

      function routeOptions(current) {
        var seen = {};
        var nodes = [React.createElement("option", { key: "", value: "" }, "未选择")];
        routes.forEach(function (route) {
          var value = route.provider + "/" + route.model;
          if (seen[value]) return;
          seen[value] = true;
          nodes.push(React.createElement("option", { key: value, value: value }, route.name ? value + " · " + route.name : value));
        });
        if (current && !seen[current]) {
          nodes.push(React.createElement("option", { key: current, value: current }, current));
        }
        return nodes;
      }

      function lastText() {
        if (!last) return "尚无审核记录";
        var parts = [
          "状态：" + last.status,
          last.hashShort ? "版本 " + last.hashShort : "",
          last.sessionRound != null ? "本会话第 " + last.sessionRound + " 次" : "",
          last.round != null ? "本版第 " + last.round + "/" + (last.maxRevisions || "?") + " 轮" : "",
          last.reviewer ? "次模型 " + reviewerText(last.reviewer) : "",
          last.reason ? "原因：" + last.reason : "",
        ].filter(Boolean);
        if (Array.isArray(last.issues) && last.issues.length) {
          last.issues.forEach(function (issue, index) {
            parts.push((index + 1) + ". " + ((issue && issue.summary) || "未命名问题"));
          });
        }
        return parts.join("\n");
      }

      return React.createElement(
        "div",
        { className: "promote-root" },
        React.createElement("div", { className: "promote-title" }, "契约审核"),
        React.createElement("div", { className: "promote-card" },
          React.createElement("div", { className: "promote-card-title" }, "审核模型（次模型）"),
          unassociated
            ? React.createElement("div", { className: "promote-warn" }, "未关联会话，不得用 Host 默认策略冒充当前主模型。")
            : React.createElement(React.Fragment, null,
              React.createElement("div", { className: "promote-reviewer" }, reviewerText(session && session.reviewer) || (session && session.reviewerError) || "未就绪"),
              reviewerNote ? React.createElement("div", { className: "promote-muted" }, reviewerNote) : null,
              React.createElement("div", { className: "promote-muted" }, "当前会话主模型：" + (reviewerText(session && session.mainModel) || (session && session.mainModelError) || "无法确认")),
            ),
        ),
        React.createElement("div", { className: "promote-card" },
          React.createElement("div", { className: "promote-card-title" }, "审核规则"),
          React.createElement("ol", { className: "promote-rules" },
            criteria.map(function (item, index) {
              return React.createElement("li", { key: "c" + index }, item);
            }),
          ),
          React.createElement("div", { className: "promote-card-title" }, "约束"),
          React.createElement("ul", { className: "promote-rules" },
            constraints.map(function (item, index) {
              return React.createElement("li", { key: "k" + index }, item);
            }),
          ),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("label", { className: "promote-label", htmlFor: "promote-a" }, "次模型 A"),
          routes.length
            ? React.createElement("select", {
              id: "promote-a",
              className: "promote-select",
              value: ui.modelA,
              onChange: function (event) {
                var value = event.target.value;
                patchForm({ modelA: value, effortA: defaultEffort(routes, value, "") });
              },
            }, routeOptions(ui.modelA))
            : React.createElement("input", {
              id: "promote-a",
              className: "promote-input",
              placeholder: "provider/model",
              value: ui.modelA,
              onChange: function (event) { patchForm({ modelA: event.target.value }); },
            }),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("label", { className: "promote-label", htmlFor: "promote-a-effort" }, "次模型 A 推理强度"),
          React.createElement("select", {
            id: "promote-a-effort",
            className: "promote-select",
            value: ui.effortA,
            disabled: !ui.modelA,
            onChange: function (event) { patchForm({ effortA: event.target.value }); },
          }, effortOptions(routes, ui.modelA, ui.effortA)),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("label", { className: "promote-label", htmlFor: "promote-b" }, "次模型 B"),
          routes.length
            ? React.createElement("select", {
              id: "promote-b",
              className: "promote-select",
              value: ui.modelB,
              onChange: function (event) {
                var value = event.target.value;
                patchForm({ modelB: value, effortB: defaultEffort(routes, value, "") });
              },
            }, routeOptions(ui.modelB))
            : React.createElement("input", {
              id: "promote-b",
              className: "promote-input",
              placeholder: "provider/model",
              value: ui.modelB,
              onChange: function (event) { patchForm({ modelB: event.target.value }); },
            }),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("label", { className: "promote-label", htmlFor: "promote-b-effort" }, "次模型 B 推理强度"),
          React.createElement("select", {
            id: "promote-b-effort",
            className: "promote-select",
            value: ui.effortB,
            disabled: !ui.modelB,
            onChange: function (event) { patchForm({ effortB: event.target.value }); },
          }, effortOptions(routes, ui.modelB, ui.effortB)),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("label", { className: "promote-label", htmlFor: "promote-n" }, "最大修改次数（1–5）"),
          React.createElement("input", {
            id: "promote-n",
            className: "promote-input",
            type: "number",
            min: 1,
            max: 5,
            value: ui.maxRevisions,
            onChange: function (event) { patchForm({ maxRevisions: event.target.value }); },
          }),
        ),
        React.createElement("label", { className: "promote-check" },
          React.createElement("input", {
            type: "checkbox",
            checked: Boolean(ui.autoReview),
            onChange: function (event) { patchForm({ autoReview: event.target.checked }); },
          }),
          "自动审核",
        ),
        versionWarn ? React.createElement("div", { className: "promote-warn" }, versionWarn) : null,
        autoDisabled ? React.createElement("div", { className: "promote-warn" }, "自动审核已禁用。" + (autoReason ? " " + autoReason : " 请配齐与当前主模型不同的次模型 A/B。")) : null,
        ui.dirty ? React.createElement("div", { className: "promote-warn" }, "已改未保存。审核仍用上次保存的 A/B，点「保存设置」后才会换成你选的模型。") : null,
        ui.error ? React.createElement("div", { className: "promote-error", role: "alert" }, ui.error) : null,
        ui.notice ? React.createElement("div", { className: "promote-muted" }, ui.notice) : null,
        React.createElement("div", { className: "promote-actions" },
          React.createElement("button", { type: "button", className: "promote-btn", disabled: ui.saving || ui.loading, onClick: save }, ui.saving ? "保存中…" : "保存设置"),
          React.createElement("button", { type: "button", className: "promote-btn", disabled: ui.loading, onClick: refresh }, ui.loading ? "刷新中…" : "刷新"),
        ),
        React.createElement("div", { className: "promote-row" },
          React.createElement("span", { className: "promote-label" }, "最近一次审核"),
          React.createElement("div", { className: "promote-status" }, lastText()),
        ),
      );
    }

    function apply(ctx) {
      ensureStyle();
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: "extension",
          title: function () { return "Promote"; },
          guide: [{
            id: "open",
            order: 41,
            title: function () { return "Promote"; },
            description: function () { return "次模型审核执行契约"; },
            icon: PromoteGlyph,
          }],
        });
      }, "promote.type");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, PromotePane);
        });
      }, "promote.body");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, PromoteTitle);
        });
      }, "promote.title");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
