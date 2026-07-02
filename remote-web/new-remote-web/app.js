(function () {
  "use strict";

  var CONFIG_URL = "./config/liehu-config.json";
  var LKG_KEY = "liehu20_config_cache";

  var ROUTES = [
    { path: "/dy/shopList", title: "店铺管理", group: "账号管理", chunk: "index-R2jGZLVf.js", priority: "P0" },
    { path: "/dy/analysis", title: "经营数据", group: "推广数据", chunk: "index-DK98ggIw.js", priority: "P0" },
    { path: "/dy/financial", title: "资金数据", group: "推广数据", chunk: "index-2SfHpNxb.js", priority: "P0" },
    { path: "/dy/managementOfViolations", title: "违规管理", group: "店铺管理", chunk: "index-DTm9nDY0.js", priority: "P0" },
    { path: "/dy/managementOfOnSale", title: "售中管理", group: "店铺管理", chunk: "index-CDyvcjyo.js", priority: "P0" },
    { path: "/dy/timelimits", title: "限时限量购", group: "活动营销", chunk: "index-XGmD8C4T.js", priority: "P0" },
    { path: "/dy/newGiftMoney", title: "新人礼金", group: "活动营销", chunk: "index-BKUc4sUa.js", priority: "P0" },
    { path: "/dy/coupons", title: "通用优惠券", group: "活动营销", chunk: "index-BgmPRA1E.js", priority: "P0" },
    { path: "/dy/bussinessCenterSubmit", title: "商机提报", group: "商品优化", chunk: "index-C7UgVeRp.js", priority: "P1" },
    { path: "/dy/clearNoSales", title: "清理滞销", group: "商品优化", chunk: "index-DirnFtOd.js", priority: "P1" },
    { path: "/dy/batchListingAndDelisting", title: "批量上下架", group: "商品优化", chunk: "index-DKxNCFOc.js", priority: "P1" },
    { path: "/dy/batchDelete", title: "批量删除", group: "商品优化", chunk: "index-DP2DsaL1.js", priority: "P1" },
    { path: "/dy/gotTalentShowEdit", title: "达人秀修改", group: "商品优化", chunk: "index-is6rwhFa.js", priority: "P1" },
    { path: "/dy/batchEditTitle", title: "批量改标题", group: "商品优化", chunk: "index-DA_7pz_z.js", priority: "P1" },
    { path: "/dy/batchEditPrice", title: "批量改价", group: "商品优化", chunk: "index-BHaMFwh2.js", priority: "P1" },
    { path: "/dy/freightRateTemplate", title: "运费模板", group: "商品优化", chunk: "index-Dd8Kn5_d.js", priority: "P1" }
  ];

  var state = {
    config: null,
    configSource: "default",
    appInfo: null,
    currentPath: "/dy/shopList",
    diagnostics: []
  };

  function $(selector) {
    return document.querySelector(selector);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function redactedJson(value) {
    return window.liehuBridge.diagnostics.redact(value);
  }

  function record(event, payload) {
    var item = {
      time: new Date().toISOString(),
      event: event,
      payload: payload || {}
    };
    state.diagnostics.unshift(item);
    state.diagnostics = state.diagnostics.slice(0, 12);
    if (state.config && state.config.diagnostics && state.config.diagnostics.enabled) {
      window.liehuBridge.diagnostics.report({ event: event, payload: payload || {} });
    }
  }

  function defaultConfig() {
    return {
      version: "builtin.phase0",
      configTtlSeconds: 60,
      entry: {
        newRemoteEnabled: false,
        newRemoteOrigin: "/new-remote-web/",
        fallbackUrl: "/old-entry/legacy/index.html"
      },
      shell: {
        mode: "legacy",
        liehuEnabled: false,
        legacyReplicaEnabled: true,
        shellVersion: "builtin"
      },
      rollout: {
        enabled: false,
        percent: 0,
        userAllowlist: [],
        userBlocklist: [],
        shopAllowlist: [],
        shopBlocklist: []
      },
      routes: {},
      features: {
        rawClient: { enabled: true },
        diagnostics: { enabled: true }
      },
      diagnostics: {
        enabled: true,
        sampleRate: 1
      },
      release: {
        gitCommit: "builtin",
        buildTime: new Date().toISOString()
      }
    };
  }

  function validateConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("config is not an object");
    }
    if (!config.version) {
      throw new Error("config.version is required");
    }
    if (!config.entry || typeof config.entry !== "object") {
      throw new Error("config.entry is required");
    }
    if (!config.shell || typeof config.shell !== "object") {
      throw new Error("config.shell is required");
    }
    return config;
  }

  function readLastKnownGood() {
    try {
      var raw = localStorage.getItem(LKG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeLastKnownGood(config) {
    try {
      localStorage.setItem(LKG_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        config: config
      }));
    } catch (error) {
      record("config_lkg_write_failed", { message: error.message });
    }
  }

  async function loadConfig() {
    var builtin = defaultConfig();
    var lkg = readLastKnownGood();

    try {
      var response = await fetch(CONFIG_URL + "?v=" + Date.now(), {
        cache: "no-store",
        credentials: "omit"
      });
      if (!response.ok) {
        throw new Error("config http " + response.status);
      }
      var config = validateConfig(await response.json());
      writeLastKnownGood(config);
      return { source: "remote", config: config };
    } catch (error) {
      if (lkg && lkg.config) {
        return { source: "last-known-good", config: validateConfig(lkg.config), warning: error.message };
      }
      return { source: "builtin", config: builtin, warning: error.message };
    }
  }

  async function loadAppInfo() {
    var result = await window.liehuBridge.app.getAppInfo();
    state.appInfo = result;
    return result;
  }

  function routeMode(route) {
    var routeConfig = state.config && state.config.routes && state.config.routes[route.path];
    return routeConfig && routeConfig.mode || "legacy-replica";
  }

  function setRoute(path) {
    state.currentPath = path;
    var url = new URL(window.location.href);
    url.searchParams.set("route", path);
    history.replaceState({}, "", url);
    render();
    record("route_change", { path: path, mode: routeMode(ROUTES.find(function (route) { return route.path === path; }) || ROUTES[0]) });
  }

  function initRoute() {
    var url = new URL(window.location.href);
    var route = url.searchParams.get("route") || url.pathname;
    if (!ROUTES.some(function (item) { return item.path === route; })) {
      route = "/dy/shopList";
    }
    state.currentPath = route;
  }

  function groupRoutes() {
    return ROUTES.reduce(function (groups, route) {
      groups[route.group] = groups[route.group] || [];
      groups[route.group].push(route);
      return groups;
    }, {});
  }

  function renderSidebar() {
    var groups = groupRoutes();
    return Object.keys(groups).map(function (group) {
      return [
        "<section class=\"nav-group\">",
        "<h2>" + escapeHtml(group) + "</h2>",
        groups[group].map(function (route) {
          var active = route.path === state.currentPath ? " active" : "";
          return "<button class=\"route-button" + active + "\" data-route=\"" + escapeHtml(route.path) + "\">" +
            "<span>" + escapeHtml(route.title) + "</span>" +
            "<small>" + escapeHtml(route.priority) + "</small>" +
          "</button>";
        }).join(""),
        "</section>"
      ].join("");
    }).join("");
  }

  function renderBridgePanel() {
    var available = window.liehuBridge.rawMethods.filter(function (name) {
      return window.liehuBridge.hasMethod(name);
    });
    var missing = window.liehuBridge.rawMethods.length - available.length;
    return [
      "<section class=\"panel\">",
      "<div class=\"panel-title\"><h2>Bridge</h2><span>" + (window.liehuBridge.hasClient() ? "Electron" : "Web Preview") + "</span></div>",
      "<dl class=\"kv\">",
      "<div><dt>window.client</dt><dd>" + (window.liehuBridge.hasClient() ? "可用" : "不可用") + "</dd></div>",
      "<div><dt>可用方法</dt><dd>" + available.length + " / " + window.liehuBridge.rawMethods.length + "</dd></div>",
      "<div><dt>缺失方法</dt><dd>" + missing + "</dd></div>",
      "<div><dt>AppInfo</dt><dd>" + escapeHtml(redactedJson(state.appInfo || {})) + "</dd></div>",
      "</dl>",
      "<div class=\"panel-actions\">",
      "<button data-action=\"test-app-info\">测试 getAppInfo</button>",
      "<button data-action=\"test-log\">测试日志脱敏</button>",
      "</div>",
      "</section>"
    ].join("");
  }

  function renderConfigPanel() {
    return [
      "<section class=\"panel\">",
      "<div class=\"panel-title\"><h2>配置</h2><span>" + escapeHtml(state.configSource) + "</span></div>",
      "<dl class=\"kv\">",
      "<div><dt>version</dt><dd>" + escapeHtml(state.config.version) + "</dd></div>",
      "<div><dt>shell</dt><dd>" + escapeHtml(state.config.shell.mode) + "</dd></div>",
      "<div><dt>liehu</dt><dd>" + (state.config.shell.liehuEnabled ? "开启" : "关闭") + "</dd></div>",
      "<div><dt>legacy</dt><dd>" + (state.config.shell.legacyReplicaEnabled ? "开启" : "关闭") + "</dd></div>",
      "</dl>",
      "<div class=\"panel-actions\">",
      "<button data-action=\"reload-config\">刷新配置</button>",
      "<a href=\"" + escapeHtml(state.config.entry.fallbackUrl || "/old-entry/legacy/index.html") + "\">打开兜底页</a>",
      "</div>",
      "</section>"
    ].join("");
  }

  function renderLegacyView() {
    var route = ROUTES.find(function (item) { return item.path === state.currentPath; }) || ROUTES[0];
    var mode = routeMode(route);
    return [
      "<section class=\"workspace\">",
      "<div class=\"workspace-head\">",
      "<div>",
      "<h1>" + escapeHtml(route.title) + "</h1>",
      "<p>" + escapeHtml(route.path) + " · " + escapeHtml(route.chunk) + "</p>",
      "</div>",
      "<span class=\"mode-badge\">" + escapeHtml(mode) + "</span>",
      "</div>",
      "<div class=\"legacy-frame\">",
      "<div class=\"legacy-copy\">",
      "<h2>Legacy App Replica</h2>",
      "<p>Phase 0 已接住旧路由入口，后续按旧线上产物和行为逐页复刻。当前页面先保留路由、chunk、Bridge 和失败态闭环。</p>",
      "<div class=\"legacy-actions\">",
      "<button data-action=\"simulate-http\">模拟接口失败态</button>",
      "<button data-action=\"open-legacy-route\">打开旧路由容器</button>",
      "</div>",
      "</div>",
      "<img src=\"./assets/xzb-client-shell.png\" alt=\"小尊宝客户端界面采样\">",
      "</div>",
      "</section>"
    ].join("");
  }

  function renderDiagnostics() {
    return [
      "<section class=\"panel diagnostics-panel\">",
      "<div class=\"panel-title\"><h2>诊断</h2><span>脱敏输出</span></div>",
      "<div class=\"log-list\">",
      state.diagnostics.map(function (item) {
        return "<div class=\"log-item\"><strong>" + escapeHtml(item.event) + "</strong><span>" + escapeHtml(item.time) + "</span><pre>" + escapeHtml(redactedJson(item.payload)) + "</pre></div>";
      }).join("") || "<p class=\"empty\">暂无诊断事件</p>",
      "</div>",
      "</section>"
    ].join("");
  }

  function renderShell() {
    return [
      "<div class=\"app-shell\">",
      "<aside class=\"sidebar\">",
      "<div class=\"brand\"><div class=\"brand-mark\">尊</div><div><strong>小尊宝</strong><span>Phase 0</span></div></div>",
      renderSidebar(),
      "</aside>",
      "<main class=\"main\">",
      "<header class=\"topbar\">",
      "<div><strong>新远程 Web</strong><span>OLD_REMOTE_ENTRY -> NEW_REMOTE_WEB_ORIGIN</span></div>",
      "<div class=\"top-actions\">",
      "<button data-action=\"reload-config\">刷新配置</button>",
      "<button data-action=\"test-app-info\">Bridge 自检</button>",
      "</div>",
      "</header>",
      "<div class=\"content-grid\">",
      renderLegacyView(),
      "<aside class=\"right-rail\">",
      renderBridgePanel(),
      renderConfigPanel(),
      renderDiagnostics(),
      "</aside>",
      "</div>",
      "</main>",
      "</div>"
    ].join("");
  }

  function renderFallback(reason) {
    var fallbackUrl = state.config && state.config.entry && state.config.entry.fallbackUrl || "/old-entry/legacy/index.html";
    return [
      "<div class=\"fallback-screen\">",
      "<div class=\"brand-mark\">尊</div>",
      "<h1>新远程 Web 暂不可用</h1>",
      "<p>" + escapeHtml(reason || "配置关闭或初始化失败") + "</p>",
      "<a href=\"" + escapeHtml(fallbackUrl) + "\">进入兜底页</a>",
      "</div>"
    ].join("");
  }

  function bindEvents() {
    document.querySelectorAll("[data-route]").forEach(function (button) {
      button.addEventListener("click", function () {
        setRoute(button.getAttribute("data-route"));
      });
    });

    document.querySelectorAll("[data-action]").forEach(function (button) {
      button.addEventListener("click", async function () {
        var action = button.getAttribute("data-action");
        if (action === "reload-config") {
          await boot({ keepRoute: true });
        }
        if (action === "test-app-info") {
          var appInfo = await loadAppInfo();
          record("bridge_get_app_info", appInfo);
          render();
        }
        if (action === "test-log") {
          record("redaction_test", {
            Cookie: "sessionid=secret",
            Authorization: "Bearer secret-token",
            url: "https://example.test/?token=secret"
          });
          render();
        }
        if (action === "simulate-http") {
          record("http_failure_state", {
            route: state.currentPath,
            message: "Phase 0 does not call production APIs in browser preview"
          });
          render();
        }
        if (action === "open-legacy-route") {
          record("legacy_route_open", {
            route: state.currentPath,
            mode: "legacy-replica"
          });
          render();
        }
      });
    });
  }

  function render(reason) {
    var app = document.getElementById("app");
    if (!app) {
      return;
    }

    if (!state.config || !state.config.shell || !state.config.shell.legacyReplicaEnabled) {
      app.innerHTML = renderFallback(reason);
    } else {
      app.innerHTML = renderShell();
      bindEvents();
    }
  }

  async function boot(options) {
    options = options || {};
    if (!options.keepRoute) {
      initRoute();
    }

    var loaded = await loadConfig();
    state.config = loaded.config;
    state.configSource = loaded.source;
    record("config_loaded", {
      source: loaded.source,
      warning: loaded.warning,
      version: loaded.config.version
    });

    try {
      await loadAppInfo();
      record("app_info_loaded", state.appInfo);
    } catch (error) {
      state.appInfo = {
        hasClient: false,
        error: error.message
      };
      record("app_info_failed", state.appInfo);
    }

    render();
  }

  boot().catch(function (error) {
    state.config = defaultConfig();
    state.configSource = "fatal-builtin";
    record("boot_failed", { message: error.message });
    render(error.message);
  });
})();

