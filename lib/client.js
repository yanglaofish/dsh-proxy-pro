/**
 * dsh-proxy-pro — browser face.
 *
 * Two contributions:
 * 1. A capsule proxy button in the conversation header
 *    (`conversation.session.header.utilities`): green/red status dot with a
 *    live label, one click toggles the master `enabled` switch.
 * 2. A dedicated Settings page (`settings.section`, label 代理管理): runtime
 *    facts (active / url / reason — from the host's /dsh-proxy-pro/api,
 *    NOT derived from settings), the editable config fields (mode / custom
 *    URL / NO_PROXY), and a per-URL route diagnostic.
 *
 * Both read and write the `proxy` settings namespace through the shared
 * `ctx.settingsScope` transport (same as dsh-plugin-proxy); runtime facts
 * come from the same-origin /dsh-proxy-pro/api endpoints served by the host
 * half (browser-trust fenced, see lib/index.js).
 *
 * This hand-written module mirrors the loader format the in-repo client
 * bundles emit (window.__ModuleLoader__.load with a CommonJS factory): react
 * is required through the app's module table, no JSX, no bundler, no TS.
 */
window.__ModuleLoader__.load({
  id: "dsh-proxy-pro/client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;
    var useSyncExternalStore = react.useSyncExternalStore;

    var cssId = "dsh-proxy-pro/client";
    var css = [
      ".dsxprx{display:flex;flex-direction:column;gap:14px}",
      ".dsxprx-status{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-specific-tip)}",
      ".dsxprx-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}",
      ".dsxprx-status[data-active=true] .dsxprx-dot{background:var(--dsw-alias-state-success-primary)}",
      ".dsxprx-statusbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dsxprx-statusline{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".dsxprx-subline{font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption);word-break:break-all}",
      ".dsxprx-switchwrap{flex:none;display:flex;align-items:center;gap:6px;cursor:pointer}",
      ".dsxprx-switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);transition:background .15s ease;flex:none}",
      ".dsxprx-switch[data-on=true]{background:#4d6bfe}",
      ".dsxprx-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}",
      ".dsxprx-switch[data-on=true]::after{transform:translateX(16px)}",
      ".dsxprx-switchwrap input{position:absolute;opacity:0;width:0;height:0}",
      ".dsxprx-switchwrap[data-disabled=true]{opacity:.5;cursor:not-allowed}",
      ".dsxprx-field{display:flex;flex-direction:column;gap:4px}",
      ".dsxprx-field>label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}",
      ".dsxprx-field input[type=text],.dsxprx-field select{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
      ".dsxprx-field input:disabled{opacity:.5}",
      ".dsxprx-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption)}",
      ".dsxprx-radios{display:flex;gap:6px;flex-wrap:wrap}",
      ".dsxprx-radio{flex:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:12px;line-height:16px;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
      ".dsxprx-radio[data-on=true]{background:rgba(77,107,254,.12);border-color:rgba(77,107,254,.45);color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsxprx-radio input{position:absolute;opacity:0;width:0;height:0}",
      ".dsxprx-diag{display:flex;flex-direction:column;gap:6px}",
      ".dsxprx-diagbar{display:flex;gap:8px}",
      ".dsxprx-diagbar input[type=text]{flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}",
      ".dsxprx-diagbtn{flex:none;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}",
      ".dsxprx-diagbtn:disabled{opacity:.5;cursor:not-allowed}",
      ".dsxprx-diagout{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-tip);font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}",
      ".dsxprx-hdr{display:flex;align-items:center;gap:6px;max-width:180px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden}",
      ".dsxprx-hdr:hover{background:var(--dsw-alias-state-hover)}",
      ".dsxprx-hdr .dsxprx-dot{width:8px;height:8px}",
      ".dsxprx-hdrlabel{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500}",
      ".dsxprx-hdr[data-active=false] .dsxprx-hdrlabel{color:var(--dsw-alias-label-secondary)}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-proxy-pro";
      tag.dataset.pluginCss = cssId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    var API_BASE = "/dsh-proxy-pro/api";

    /** Same-origin JSON helper toward the host API; resolves null on failure. */
    function fetchJson(path, options) {
      return fetch(API_BASE + path, options)
        .then(function (res) { return res.json().catch(function () { return {}; }); })
        .catch(function () { return null; });
    }

    // ---- reactive settings scope (the `proxy` namespace) ----
    /** @returns `{ value, writable, ready }` from a bound SettingsScope. */
    function useProxySnapshot(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange); },
        function () { return scope.getSnapshot(); }
      );
      var ready = snapshot.status === "ready" && snapshot.value !== undefined;
      return {
        value: ready ? snapshot.value : undefined,
        writable: snapshot.writable === true && ready,
        ready: snapshot.status === "unavailable" ? false : snapshot.status === "ready",
      };
    }

    // ---- runtime facts (from /dsh-proxy-pro/api/status) ----
    /** Fetch the host status snapshot ONCE on mount (no polling). The UI
     *  renders configuration-driven state by default; the host snapshot is a
     *  supplementary fact fetched when the panel is open (§17: read ≠ poll). */
    function useStatusOnce() {
      var state = useState({ loading: true, status: null, error: "" });
      var setState = state[1];
      useEffect(function () {
        var alive = true;
        fetchJson("/status").then(function (data) {
          if (!alive) return;
          if (data === null || data.ok !== true) {
            setState({ loading: false, status: null, error: (data && data.error) || "status API unavailable" });
            return;
          }
          setState({ loading: false, status: data.status, error: "" });
        });
        return function () { alive = false; };
      }, []);
      return state[0];
    }

    // A text input that drafts locally and commits on blur (external value
    // wins only when it differs from the last committed draft).
    function DraftInput(props) {
      var textState = useState(props.value || "");
      var text = textState[0];
      var setText = textState[1];
      var committed = useRef(props.value || "");
      useEffect(function () {
        var next = props.value || "";
        if (next !== committed.current) {
          committed.current = next;
          setText(next);
        }
      }, [props.value]);
      return react.createElement("input", {
        type: "text",
        value: text,
        disabled: props.disabled === true,
        placeholder: props.placeholder || "",
        onChange: function (event) { setText(event.target.value); },
        onBlur: function () {
          if (text === committed.current) return;
          committed.current = text;
          props.onCommit(text);
        },
      });
    }

    // ---- conversation header capsule button ----
    function ProxyHeaderButton(props) {
      var scope = props.scope;
      var settings = useProxySnapshot(scope);
      var busy = useState(false);
      var setBusy = busy[1];
      // Configuration-driven: the capsule mirrors the switch, resolved locally
      // with zero requests. The host applies the change instantly when the
      // settings revision lands (and follows external system-proxy changes on
      // its own 30s poll), so polling here buys nothing (§17).
      var config = settings.value || {};
      var active = config.enabled === true && config.mode !== "none";
      var enabled = config.enabled === true;
      var mode = config.mode || "system";
      var modeLabel = mode === "system" ? "system" : mode === "custom" ? "custom" : "none";
      function toggle() {
        if (!settings.writable) return;
        setBusy(true);
        var next = !enabled;
        scope.set("enabled", next).catch(function (error) {
          console.error("[dsh-proxy-pro] toggle failed:", error);
        }).finally(function () { setBusy(false); });
      }
      var title = active
        ? "代理已开启（界面开关）· 点击关闭"
        : "代理已关闭 · 点击开启";
      return react.createElement(
        "button",
        {
          type: "button",
          className: "dsxprx-hdr",
          "data-active": active ? "true" : "false",
          "data-proxy-toggle": true,
          onClick: toggle,
          disabled: !settings.writable || busy[0],
          title: title,
          "aria-pressed": active,
        },
        react.createElement("span", { className: "dsxprx-dot" }),
        react.createElement("span", { className: "dsxprx-hdrlabel" }, "代理 · " + (active ? "ON " + modeLabel : "OFF"))
      );
    }

    // ---- Settings page: 代理管理 ----
    function ProxyManagerPanel(props) {
      var scope = props.scope;
      var settings = useProxySnapshot(scope);
      // Snapshot fetched once when the panel opens; no background polling.
      var runtime = useStatusOnce();
      var diagState = useState("");
      var diagUrl = diagState[0];
      var setDiagUrl = diagState[1];
      var diagBusy = useState(false);
      var setDiagBusy = diagBusy[1];
      var diagResult = useState(null);
      var setDiagResult = diagResult[1];

      if (!settings.ready) {
        return react.createElement("div", { className: "dsxprx", "data-proxy-settings": true },
          react.createElement("p", { className: "dsxprx-hint" }, "代理设置加载中…"));
      }
      var value = settings.value || { enabled: false, mode: "system", customUrl: "", noProxy: "" };
      var writable = settings.writable;
      var status = runtime.status;
      var active = status !== null && status !== undefined ? status.active === true : value.enabled === true && value.mode !== "none";
      var statusLine = active
        ? "代理生效中 · " + (status && status.url || value.customUrl || "—")
        : status !== null && status !== undefined
          ? "代理未生效 · " + (status.reason || "直连")
          : runtime.error !== ""
            ? "状态 API 不可用（直连或未安装 host 半）"
            : "查询代理状态…";
      var subLine = active
        ? (status && status.source === "system" ? "跟随 Windows 系统代理（自动刷新）" : "自定义地址") + (status && status.noProxy ? " · 直连名单: " + status.noProxy : "")
        : status !== null && status !== undefined
          ? "流量当前直连。" + (status.noProxy ? " 直连名单: " + status.noProxy : "")
          : "";

      function setField(field) {
        return function (next) {
          scope.set(field, next).catch(function (error) {
            console.error("[dsh-proxy-pro] save failed:", error);
          });
        };
      }
      function runDiag() {
        var target = diagUrl.trim();
        if (!target) return;
        setDiagBusy(true);
        setDiagResult(null);
        fetchJson("/route?url=" + encodeURIComponent(target)).then(function (data) {
          setDiagResult(data === null ? { error: "诊断接口不可用" } : data);
        }).finally(function () { setDiagBusy(false); });
      }
      var diag = diagResult[0];

      return react.createElement("div", { className: "dsxprx", "data-proxy-settings": true },

        // --- status card ---
        react.createElement("div", { className: "dsxprx-status", "data-active": active ? "true" : "false" },
          react.createElement("span", { className: "dsxprx-dot" }),
          react.createElement("div", { className: "dsxprx-statusbody" },
            react.createElement("span", { className: "dsxprx-statusline" }, statusLine),
            subLine ? react.createElement("span", { className: "dsxprx-subline" }, subLine) : null),
          react.createElement("label", { className: "dsxprx-switchwrap", "data-disabled": writable ? undefined : "true" },
            react.createElement("span", { className: "dsxprx-switch", "data-on": value.enabled === true ? "true" : "false" }),
            react.createElement("input", {
              type: "checkbox",
              checked: value.enabled === true,
              disabled: !writable,
              onChange: function (event) { setField("enabled")(event.target.checked); },
            }))
        ),

        // --- mode ---
        react.createElement("div", { className: "dsxprx-field" },
          react.createElement("label", { htmlFor: "dsxprx-mode" }, "代理地址来源"),
          react.createElement("div", { className: "dsxprx-radios" },
            [["system", "系统代理（Windows）"], ["custom", "自定义地址"], ["none", "不使用代理"]].map(function (entry) {
              var modeValue = entry[0];
              var modeLabel = entry[1];
              var on = (value.mode || "system") === modeValue;
              return react.createElement("label", { key: modeValue, className: "dsxprx-radio", "data-on": on ? "true" : "false", title: modeValue === "system" ? "读取 Windows ·Internet 设置· 中的代理" : modeValue === "custom" ? "使用下方自定义地址" : "即使开关开启也不走代理" },
                react.createElement("input", {
                  type: "radio",
                  name: "dsxprx-mode",
                  checked: on,
                  disabled: !writable,
                  onChange: function () { setField("mode")(modeValue); },
                }),
                modeLabel);
            })
          ),
          react.createElement("span", { className: "dsxprx-hint" }, "模式为「不使用代理」时即使开关开启也直连。")
        ),

        // --- custom url ---
        (value.mode || "system") === "custom"
          ? react.createElement("div", { className: "dsxprx-field" },
            react.createElement("label", { htmlFor: "dsxprx-url" }, "自定义代理地址"),
            react.createElement(DraftInput, {
              value: value.customUrl || "",
              disabled: !writable,
              placeholder: "http://127.0.0.1:7890",
              onCommit: setField("customUrl"),
            }),
            react.createElement("span", { className: "dsxprx-hint" }, "支持 http:// 或 https:// 开头的地址。")
          )
          : null,

        // --- no_proxy ---
        react.createElement("div", { className: "dsxprx-field" },
          react.createElement("label", { htmlFor: "dsxprx-noproxy" }, "直连名单（NO_PROXY）"),
          react.createElement(DraftInput, {
            value: value.noProxy || "",
            disabled: !writable,
            placeholder: "localhost,127.0.0.1,::1",
            onCommit: setField("noProxy"),
          }),
          react.createElement("span", { className: "dsxprx-hint" }, "逗号分隔的主机名；localhost / 127.0.0.1 / ::1 始终直连；Windows 系统代理的 ProxyOverride 会并入。")
        ),

        // --- diagnostics ---
        react.createElement("div", { className: "dsxprx-diag" },
          react.createElement("label", { htmlFor: "dsxprx-diagurl" }, "路由诊断"),
          react.createElement("div", { className: "dsxprx-diagbar" },
            react.createElement("input", {
              id: "dsxprx-diagurl",
              type: "text",
              value: diagUrl,
              placeholder: "https://github.com/foo/bar",
              onChange: function (event) { setDiagUrl(event.target.value); },
              onKeyDown: function (event) { if (event.key === "Enter") runDiag(); },
            }),
            react.createElement("button", { type: "button", className: "dsxprx-diagbtn", onClick: runDiag, disabled: diagBusy[0] || !diagUrl.trim() }, "测试路由")
          ),
          diag !== null
            ? react.createElement("div", { className: "dsxprx-diagout" },
              diag.error
                ? react.createElement("span", null, "诊断失败：" + diag.error)
                : [
                  react.createElement("span", { key: "r" }, "路由： " + diag.route + (diag.bypassed ? "（NO_PROXY 命中）" : "")),
                  react.createElement("span", { key: "p" }, "连通探测： " + (diag.probe && diag.probe.ok ? "可达（HTTP " + diag.probe.status + "）" : (diag.probe && diag.probe.short) || "未知")),
                  diag.hint ? react.createElement("span", { key: "h" }, "提示： " + diag.hint) : null,
                ]
            )
            : null
        ),

        react.createElement("span", { className: "dsxprx-hint" }, "对话中的模型会实时感知代理状态（系统提示中标注），并可用 proxy_status / proxy_set / proxy_test 查询或临时切换。")
      );
    }

    /**
     * Browser plugin body: bind the `proxy` settings scope, then register the
     * conversation header button and the 代理管理 settings section.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: "proxy" });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-proxy-pro",
          order: 20,
          label: "代理管理",
        }, function Section() {
          return react.createElement(ProxyManagerPanel, { scope: scope });
        });
      });
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "dsh-proxy-pro",
          order: 10,
          label: "代理",
        }, function Header() {
          return react.createElement(ProxyHeaderButton, { scope: scope });
        });
      });
    }

    exports.name = "dsh-proxy-pro-ui";
    exports.apply = apply;
    // Cordis service names the browser loader must wait for — NOT package
    // names (those belong in package.json's dsh.client.inject). Writing
    // package names here keeps the plugin permanently pending and blocks
    // web boot (see docs/LESSONS.md §6).
    exports.inject = [
      "slots",
      "settingsScope",
    ];
    return module.exports;
  },
});