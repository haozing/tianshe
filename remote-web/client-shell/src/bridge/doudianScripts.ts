import type { DoudianAdapterConfig, DoudianAdapterScripts } from "../types";

function homePath(adapter: DoudianAdapterConfig) {
  try {
    return new URL(adapter.homeUrl).pathname;
  } catch {
    return "/mshop/homepage/index";
  }
}

export function buildDoudianScripts(adapter: DoudianAdapterConfig): DoudianAdapterScripts {
  return {
    version: "2026.07.07.remote-scripts-v3-xzb-sign-query",
    collectRoleShopNames: `
      (() => {
        const adapter = ${JSON.stringify(adapter)};
        const selectors = adapter.selectors || {};
        const labels = adapter.labels || {};
        const workbenchLabel = labels.workbench || "\\u6296\\u5e97\\u5de5\\u4f5c\\u53f0";
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const clickNode = (node) => {
          if (!node) return;
          if (node.scrollIntoView) node.scrollIntoView({ block: "center", inline: "center" });
          if (typeof node.click === "function") node.click();
        };

        try {
          const retryButton = selectors.retryButton ? document.querySelector(selectors.retryButton) : null;
          if (retryButton) clickNode(retryButton);
        } catch {}
        if (!document.body) {
          try { location.reload(); } catch {}
          return [];
        }

        const names = [];
        const roleItems = Array.from(document.querySelectorAll(selectors.roleItemStrict || selectors.roleItem));
        for (const item of roleItems) {
          const statusNode = item.querySelector(selectors.roleStatus);
          const statusText = normalize(statusNode && statusNode.textContent);
          if (statusText !== workbenchLabel) continue;
          const nameNode = item.querySelector(selectors.roleNameStrict || selectors.roleName);
          const nameText = normalize(nameNode && nameNode.textContent);
          if (nameText) names.push(nameText);
        }

        if (names.length === 1) {
          const introNodes = Array.from(document.querySelectorAll(selectors.roleNameStrict || selectors.roleName));
          const target = introNodes.find((node) => normalize(node.textContent) === names[0]);
          if (target) clickNode(target);
        }

        return names;
      })();
    `,
    isHomePage: `
      (() => location.href.indexOf(${JSON.stringify(homePath(adapter))}) > -1)();
    `,
    signFactory: `
      (async (payload) => {
        const targetUrl = payload && payload.targetUrl ? payload.targetUrl : "";
        const adapter = payload && payload.adapter ? payload.adapter : ${JSON.stringify(adapter)};
        const plan = payload && payload.plan ? payload.plan : {};
        const context = payload && payload.context ? payload.context : {};
        const signConfig = adapter.sign || {};
        const enablePathList = Array.isArray(signConfig.enablePathList) ? signConfig.enablePathList : [];
        const configuredCandidates = Array.isArray(signConfig.candidates) && signConfig.candidates.length
          ? signConfig.candidates
          : [];
        const candidates = [];
        const candidateKeys = [];
        const seen = new Set();
        const target = new URL(targetUrl);
        const normalizeQuery = (value) => String(value || "").trim().replace(/^[?&]+/, "");
        const explicitSignQuery = normalizeQuery(
          typeof plan.signQuery === "string" && plan.signQuery.trim()
            ? plan.signQuery
            : (typeof plan.signQueryString === "string" ? plan.signQueryString : "")
        );
        const targetQuery = explicitSignQuery || (target.search ? target.search.slice(1) : "");
        const addCandidate = (name, value) => {
          candidateKeys.push(name);
          if (!value || seen.has(value)) return;
          seen.add(value);
          candidates.push({ name, ctx: value, fn: typeof value.sign === "function" ? value.sign : null });
        };

        for (const key of configuredCandidates || []) {
          try {
            addCandidate(key, window[key]);
          } catch {}
        }

        try {
          const pattern = new RegExp(signConfig.candidateKeyPattern || "$.^", "i");
          const limit = Number(signConfig.scanWindowKeysLimit || 80);
          Object.keys(window)
            .filter((key) => pattern.test(key))
            .slice(0, limit)
            .forEach((key) => {
              try {
                addCandidate(key, window[key]);
              } catch {}
            });
        } catch {}

        if (!candidates.length) {
          return {
            ok: false,
            reason: "signature-provider-missing",
            href: location.href,
            title: document.title,
            candidateKeys: Array.from(new Set(candidateKeys)).slice(0, 30)
          };
        }

        const readSignature = (value) => {
          if (typeof value === "string" && value) return value;
          if (value && typeof value === "object") {
            if (typeof value._signature === "string") return value._signature;
            if (typeof value.signature === "string") return value.signature;
          }
          return "";
        };
        const readMyargs = (value) => {
          if (!value || typeof value !== "object") return "";
          return typeof value.myargs === "string" ? value.myargs : "";
        };
        const randomFp = () => {
          const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
          let output = "";
          for (let index = 0; index < 50; index += 1) output += chars[Math.floor(Math.random() * chars.length)];
          return output;
        };
        const readCookie = (name) => {
          try {
            const prefix = name + "=";
            const item = document.cookie.split(";").map((part) => part.trim()).find((part) => part.indexOf(prefix) === 0);
            return item ? decodeURIComponent(item.slice(prefix.length)) : "";
          } catch {
            return "";
          }
        };
        const callABogus = (signer, query, body, userAgent) => {
          const roots = [
            signer.ctx,
            window,
            window.byted_acrawler,
            window.bytedAcrawler,
            window.acrawler
          ];
          const names = ["GetABougsSign", "getABogusSign", "getABougsSign", "sign"];
          for (const root of roots) {
            if (!root) continue;
            for (const name of names) {
              const fn = root[name];
              if (typeof fn !== "function") continue;
              try {
                const value = fn.call(root, query, body || "", userAgent || navigator.userAgent);
                const signature = readSignature(value);
                if (signature) return signature;
              } catch {}
              try {
                const value = fn.call(root, { url: targetUrl, query, body: body || "", userAgent: userAgent || navigator.userAgent });
                const signature = readSignature(value);
                if (signature) return signature;
              } catch {}
            }
          }
          return "";
        };

        const errors = [];
        for (const signer of candidates) {
          try {
            if (typeof signer.ctx.init === "function") {
              signer.ctx.init({
                ...(signConfig.init || {}),
                enablePathList
              });
            }
          } catch (error) {
            errors.push({ source: signer.name, step: "init", error: error && error.message ? error.message : String(error) });
          }

          if (plan.signStrategy === "mstoken-myargs") {
            try {
              const provider = signer.ctx && signer.ctx.GetMstokenSign;
              if (typeof provider === "function") {
                const domain = plan.signDomain || adapter.cookieDomain || ".jinritemai.com";
                const partition = plan.signPartition || context.partition || context.shopPartition || "";
                const providerCalls = [
                  { mode: "mstoken-myargs-xzb", args: [targetQuery, plan.signBody || "", plan.signSalt || "", partition, domain, plan.signToken || "", plan.signFallbackToken || ""] },
                  { mode: "mstoken-myargs-legacy", args: [targetQuery, plan.signBody || "", plan.signSalt || "", domain, plan.signToken || "", plan.signFallbackToken || ""] }
                ];
                for (const call of providerCalls) {
                  try {
                    const result = await provider.call(signer.ctx, ...call.args);
                    const myargs = readMyargs(result);
                    if (myargs) return { ok: true, query: myargs, myargs, source: signer.name, mode: call.mode };
                  } catch (error) {
                    errors.push({ source: signer.name, step: call.mode, error: error && error.message ? error.message : String(error) });
                  }
                }
              }
            } catch (error) {
              errors.push({ source: signer.name, step: "mstoken-provider", error: error && error.message ? error.message : String(error) });
            }

            try {
              const fp = readCookie("s_v_web_id") || readCookie("MONITOR_WEB_ID") || randomFp();
              const useMsToken = plan.signUseMsToken !== false && plan.useMsToken !== false;
              const includeMsTokenParam = useMsToken || plan.signIncludeEmptyMsToken === true || plan.signIncludeMsTokenParam === true;
              const msToken = useMsToken ? readCookie("msToken") : "";
              const queryBase = [
                targetQuery,
                "fp=" + encodeURIComponent(fp),
                "verifyFp=" + encodeURIComponent(fp),
                includeMsTokenParam ? "msToken=" + (msToken ? encodeURIComponent(msToken) : "") : ""
              ].filter(Boolean).join("&");
              const aBogus = callABogus(signer, queryBase, plan.signBody || "", navigator.userAgent);
              if (aBogus) {
                const myargs = queryBase + "&a_bogus=" + encodeURIComponent(aBogus);
                return { ok: true, query: myargs, myargs, source: signer.name, mode: "mstoken-myargs-compatible" };
              }
            } catch (error) {
              errors.push({ source: signer.name, step: "mstoken-compatible", error: error && error.message ? error.message : String(error) });
            }
          }

          if (typeof signer.fn !== "function") continue;

          try {
            const signature = readSignature(signer.fn.call(signer.ctx, { url: targetUrl }));
            if (signature) return { ok: true, signature, source: signer.name };
          } catch (error) {
            errors.push({ source: signer.name, step: "sign-object", error: error && error.message ? error.message : String(error) });
          }

          try {
            const signature = readSignature(signer.fn.call(signer.ctx, targetUrl));
            if (signature) return { ok: true, signature, source: signer.name };
          } catch (error) {
            errors.push({ source: signer.name, step: "sign-string", error: error && error.message ? error.message : String(error) });
          }

          try {
            const signature = readSignature(signer.ctx.sign({ url: targetUrl }));
            if (signature) return { ok: true, signature, source: signer.name };
          } catch (error) {
            errors.push({ source: signer.name, step: "ctx-sign-object", error: error && error.message ? error.message : String(error) });
          }
        }

        return {
          ok: false,
          reason: "empty-signature",
          href: location.href,
          title: document.title,
          signQuery: targetQuery.slice(0, 160),
          candidates: candidates.map((item) => item.name),
          errors: errors.slice(0, 8)
        };
      })
    `,
    probeFactory: `
      (async (payload) => {
        const adapter = payload && payload.adapter ? payload.adapter : ${JSON.stringify(adapter)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        await sleep(300);

        const bodyText = document.body ? document.body.innerText : "";
        const result = {
          ok: false,
          href: location.href,
          title: document.title,
          headerShopName: "",
          chooseEntries: [],
          bodySample: bodyText.slice(0, 300),
          shopListResponse: null,
          currentShopResponse: null
        };

        const firstText = (selectors) => {
          for (const selector of selectors || []) {
            const node = document.querySelector(selector);
            const text = node && node.textContent ? node.textContent.trim() : "";
            if (text) return text;
          }
          return "";
        };

        result.headerShopName = firstText(adapter.selectors.headerShopName);

        try {
          result.chooseEntries = Array.from(document.querySelectorAll(adapter.selectors.roleItem))
            .slice(0, 30)
            .map((node) => {
              const nameNode = node.querySelector(adapter.selectors.roleName);
              return {
                text: (node.textContent || "").trim().slice(0, 160),
                name: nameNode && nameNode.textContent ? nameNode.textContent.trim() : ""
              };
            })
            .filter((item) => item.text || item.name);
        } catch (error) {
          result.chooseEntries = [];
        }

        const signerCandidates = () => {
          const list = [];
          const signConfig = adapter.sign || {};
          const candidates = Array.isArray(signConfig.candidates) && signConfig.candidates.length
            ? signConfig.candidates
            : [];
          for (const key of candidates || []) {
            try {
              const ctx = window[key];
              if (ctx && typeof ctx.sign === "function") list.push({ ctx, fn: ctx.sign });
            } catch {}
          }
          return list;
        };

        const signUrl = (targetUrl) => {
          for (const signer of signerCandidates()) {
            try {
              const value = signer.fn.call(signer.ctx, { url: targetUrl });
              if (typeof value === "string" && value) return value;
              if (value && typeof value === "object") {
                if (typeof value._signature === "string") return value._signature;
                if (typeof value.signature === "string") return value.signature;
              }
            } catch {}
            try {
              const value = signer.fn.call(signer.ctx, targetUrl);
              if (typeof value === "string" && value) return value;
            } catch {}
          }
          return "";
        };

        const requestJson = async (path) => {
          const url = new URL(path, adapter.origin);
          if (!url.searchParams.has("_signature")) url.searchParams.set("_signature", "");
          const signature = signUrl(url.toString());
          if (signature) url.searchParams.set("_signature", signature);

          try {
            const response = await fetch(url.toString(), {
              credentials: "include",
              headers: {
                accept: "application/json, text/plain, */*"
              }
            });
            const text = await response.text();
            let data = null;
            try {
              data = JSON.parse(text);
            } catch {}
            return {
              ok: response.ok && !!data,
              status: response.status,
              url: url.pathname,
              data,
              textSample: data ? "" : text.slice(0, 240)
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              url: url.pathname,
              data: null,
              error: error && error.message ? error.message : String(error)
            };
          }
        };

        result.shopListResponse = await requestJson(adapter.endpoints.shopList);
        result.currentShopResponse = await requestJson(adapter.endpoints.currentShop);
        result.ok = !!(
          (result.shopListResponse && result.shopListResponse.ok) ||
          (result.currentShopResponse && result.currentShopResponse.ok) ||
          result.headerShopName
        );
        return result;
      })
    `,
    switchShopFactory: `
      ((payload) => {
        const shop = payload && payload.shop ? payload.shop : {};
        const adapter = payload && payload.adapter ? payload.adapter : ${JSON.stringify(adapter)};
        const targetName = String(shop.shopName || "");
        const selectors = adapter.selectors || {};
        const labels = adapter.labels || {};
        const workbenchLabel = labels.workbench || "\\u6296\\u5e97\\u5de5\\u4f5c\\u53f0";
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const describe = (node, index) => {
          const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          return {
            index,
            tag: node && node.tagName ? node.tagName : "",
            className: String((node && node.className) || "").slice(0, 160),
            text: normalize(node && node.textContent).slice(0, 240),
            rect: rect ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            } : null
          };
        };
        const fireMouse = (node, type) => {
          if (!node) return;
          const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
          const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          });
          node.dispatchEvent(event);
        };
        const clickNode = (node) => {
          if (!node) return;
          if (node.scrollIntoView) node.scrollIntoView({ block: "center", inline: "center" });
          fireMouse(node, "mouseover");
          fireMouse(node, "mousemove");
          fireMouse(node, "mousedown");
          fireMouse(node, "mouseup");
          fireMouse(node, "click");
          if (typeof node.click === "function") node.click();
        };

        try {
          const retryButton = selectors.retryButton ? document.querySelector(selectors.retryButton) : null;
          if (retryButton) clickNode(retryButton);
        } catch {}
        if (!document.body) {
          try { location.reload(); } catch {}
          return { ok: false, reason: "body-missing", href: location.href, title: document.title, entries: [] };
        }

        const roleItems = Array.from(document.querySelectorAll(selectors.roleItem));
        const entries = roleItems.map((item, index) => {
          const statusNode = item.querySelector(selectors.roleStatus);
          const nameNode = item.querySelector(selectors.roleName);
          return {
            index,
            item,
            nameNode,
            statusText: normalize(statusNode && statusNode.textContent),
            nameText: normalize(nameNode && nameNode.textContent),
            itemText: normalize(item.textContent),
            detail: describe(nameNode || item, index)
          };
        }).filter((entry) => entry.itemText || entry.nameText);
        const workbenchEntries = entries.filter((entry) => (
          !entry.statusText ||
          entry.statusText === workbenchLabel ||
          entry.itemText.includes(workbenchLabel)
        ));
        const exactMatch = workbenchEntries.find((entry) => entry.nameText === targetName);
        const looseMatch = workbenchEntries.find((entry) => targetName && entry.nameText.includes(targetName));
        const match = exactMatch || looseMatch;

        if (match && match.nameNode) {
          const introNodes = Array.from(document.querySelectorAll(selectors.roleName));
          const introIndex = introNodes.indexOf(match.nameNode);
          clickNode(match.nameNode);
          clickNode(match.item);
          return {
            ok: true,
            reason: "doudian-role-clicked",
            href: location.href,
            title: document.title,
            introIndex,
            matched: {
              index: match.index,
              nameText: match.nameText,
              statusText: match.statusText,
              itemText: match.itemText.slice(0, 240),
              detail: match.detail
            },
            entries: entries.slice(0, 40).map((entry) => ({
              index: entry.index,
              nameText: entry.nameText,
              statusText: entry.statusText,
              itemText: entry.itemText.slice(0, 240),
              detail: entry.detail
            }))
          };
        }

        const bodyText = normalize(document.body.innerText || "");
        return {
          ok: false,
          reason: entries.length ? "target-entry-not-found" : "role-list-not-ready",
          href: location.href,
          title: document.title,
          hasTargetText: !!targetName && bodyText.includes(targetName),
          bodySample: bodyText.slice(0, 300),
          entries: entries.slice(0, 40).map((entry) => ({
            index: entry.index,
            nameText: entry.nameText,
            statusText: entry.statusText,
            itemText: entry.itemText.slice(0, 240),
            detail: entry.detail
          }))
        };
      })
    `
  };
}
