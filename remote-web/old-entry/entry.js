(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    version: "builtin.phase0",
    enabled: false,
    mode: "fallback",
    timeoutMs: 2500,
    newRemoteOrigin: "/new-remote-web/",
    preservePath: true,
    fallback: {
      mode: "legacy-replica",
      url: "/old-entry/legacy/index.html"
    },
    diagnostics: {
      enabled: true
    }
  };

  var messageEl = document.getElementById("entry-message");
  var detailsEl = document.getElementById("entry-details");
  var retryButton = document.getElementById("retry-button");
  var fallbackLink = document.getElementById("fallback-link");

  function setStatus(message, detail) {
    if (messageEl) {
      messageEl.textContent = message;
    }
    if (detailsEl) {
      detailsEl.textContent = detail || "";
    }
  }

  function redact(value) {
    return String(value || "")
      .replace(/(cookie|authorization|set-cookie)=?[^&\s]*/gi, "$1=[REDACTED]")
      .replace(/token=[^&\s]*/gi, "token=[REDACTED]");
  }

  function log(event, data) {
    if (!DEFAULT_CONFIG.diagnostics.enabled) {
      return;
    }
    try {
      console.info("[xzb-entry]", event, redact(JSON.stringify(data || {})));
    } catch (error) {
      console.info("[xzb-entry]", event);
    }
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = window.setTimeout(function () {
        reject(new Error("entry config timeout"));
      }, timeoutMs);

      promise.then(function (value) {
        window.clearTimeout(timer);
        resolve(value);
      }).catch(function (error) {
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function normalizeOrigin(origin) {
    if (!origin) {
      return "";
    }
    if (/^https?:\/\//i.test(origin)) {
      return origin.replace(/\/+$/, "/");
    }
    return new URL(origin, window.location.href).href.replace(/\/+$/, "/");
  }

  function createTargetUrl(config) {
    var base = normalizeOrigin(config.newRemoteOrigin || DEFAULT_CONFIG.newRemoteOrigin);
    var target = new URL(base, window.location.href);
    var current = new URL(window.location.href);

    if (config.preservePath) {
      var path = current.pathname;
      path = path.replace(/\/old-entry\/?/, "/");
      if (path && path !== "/" && path !== "/index.html") {
        target.searchParams.set("route", path);
      }
    }

    current.searchParams.forEach(function (value, key) {
      target.searchParams.set(key, value);
    });

    target.searchParams.set("entryVersion", config.version || "unknown");
    return target.href;
  }

  function fallback(config, reason) {
    var fallbackUrl = (config && config.fallback && config.fallback.url) || DEFAULT_CONFIG.fallback.url;
    if (fallbackLink) {
      fallbackLink.href = fallbackUrl;
    }
    setStatus("入口暂时不可用，已切换到兜底入口。", "reason: " + reason + "\nfallback: " + fallbackUrl);
    log("fallback", { reason: reason, fallbackUrl: fallbackUrl });
  }

  async function loadConfig() {
    var request = fetch("./entry-config.json?v=" + Date.now(), {
      cache: "no-store",
      credentials: "omit"
    }).then(function (response) {
      if (!response.ok) {
        throw new Error("entry config http " + response.status);
      }
      return response.json();
    });

    var config = await withTimeout(request, DEFAULT_CONFIG.timeoutMs);
    return Object.assign({}, DEFAULT_CONFIG, config, {
      fallback: Object.assign({}, DEFAULT_CONFIG.fallback, config.fallback || {}),
      diagnostics: Object.assign({}, DEFAULT_CONFIG.diagnostics, config.diagnostics || {})
    });
  }

  async function boot() {
    setStatus("正在读取入口配置，请稍候。", "entry version: loading");

    try {
      var config = await loadConfig();
      DEFAULT_CONFIG.diagnostics = config.diagnostics || DEFAULT_CONFIG.diagnostics;
      log("config_loaded", { version: config.version, enabled: config.enabled, mode: config.mode });

      if (!config.enabled) {
        fallback(config, "entry disabled");
        return;
      }

      var targetUrl = createTargetUrl(config);
      setStatus("入口配置已生效，正在进入新远程 Web。", "entry version: " + config.version + "\ntarget: " + redact(targetUrl));

      if (config.mode === "redirect" || config.mode === "html-bootstrap") {
        window.location.replace(targetUrl);
        return;
      }

      if (config.mode === "remote-loader") {
        fallback(config, "remote-loader is reserved for later phase");
        return;
      }

      fallback(config, "unsupported mode: " + config.mode);
    } catch (error) {
      fallback(DEFAULT_CONFIG, error && error.message ? error.message : "unknown error");
    }
  }

  if (retryButton) {
    retryButton.addEventListener("click", boot);
  }

  boot();
})();
