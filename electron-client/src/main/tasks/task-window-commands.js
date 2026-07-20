const MAX_COMMAND_SCRIPT_BYTES = 2 * 1024 * 1024;

function scriptTemplate(snapshot, key) {
  const value = snapshot?.windowCommands?.commands?.[key];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > MAX_COMMAND_SCRIPT_BYTES) {
    throw new Error(`verified window command template is unavailable: ${key}`);
  }
  return value;
}

function commandPayload(value) {
  const serialized = JSON.stringify(value == null ? {} : value);
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw new Error("window command payload is too large");
  return serialized;
}

function pageFetchScript(transport) {
  const request = {
    url: String(transport.url || ""),
    method: String(transport.method || "GET").toUpperCase(),
    headers: transport.headers && typeof transport.headers === "object" ? transport.headers : {},
    body: transport.body === undefined ? null : transport.body,
    timeoutMs: Math.max(1000, Math.min(120000, Number(transport.timeoutMs || 30000)))
  };
  return `
    (async () => {
      const request = ${commandPayload(request)};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const init = {
          method: request.method,
          credentials: "include",
          headers: request.headers,
          signal: controller.signal
        };
        if (request.body !== null && init.method !== "GET" && init.method !== "HEAD") {
          init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
        }
        const response = await fetch(request.url, init);
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          url: response.url || request.url,
          pageHref: location.href,
          pageTitle: document.title,
          text,
          error: response.ok ? "" : text.slice(0, 240)
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          url: request.url,
          pageHref: location.href,
          pageTitle: document.title,
          data: null,
          error: error && error.message ? error.message : String(error)
        };
      } finally {
        clearTimeout(timer);
      }
    })();
  `;
}

function taskWindowCommandScript(snapshot, command, args = {}) {
  if (command === "collect-role-shop-names") return scriptTemplate(snapshot, "collectRoleShopNames");
  if (command === "is-home-page") return scriptTemplate(snapshot, "isHomePage");
  if (command === "sign") {
    const factory = scriptTemplate(snapshot, "signFactory");
    return `(async () => { const command = ${factory}; return await command(${commandPayload(args)}); })();`;
  }
  if (command === "switch-shop") {
    const factory = scriptTemplate(snapshot, "switchShopFactory");
    return `(() => { const command = ${factory}; return command(${commandPayload(args)}); })();`;
  }
  if (command === "page-fetch") return pageFetchScript(args.transport || {});
  throw new Error(`window command is not registered: ${command}`);
}

module.exports = { taskWindowCommandScript };
