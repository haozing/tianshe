function configuredBlockedSchemes() {
  return String(process.env.CHIHU_BLOCKED_EXTERNAL_SCHEMES || "")
    .split(",")
    .map((scheme) => scheme.trim().toLowerCase().replace(/:$/, ""))
    .filter(Boolean)
    .map((scheme) => `${scheme}:`);
}

const BLOCKED_SCHEMES = configuredBlockedSchemes();

function isBlockedScheme(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase().trim();
  if (BLOCKED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return true;

  try {
    const parsed = new URL(url);
    return BLOCKED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function installSchemeBlocker(app, protocol) {
  if (!BLOCKED_SCHEMES.length) return;

  protocol.registerSchemesAsPrivileged(
    BLOCKED_SCHEMES.map((scheme) => ({
      scheme: scheme.replace(":", ""),
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: false,
        stream: true,
        supportFetchAPI: false
      }
    }))
  );

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (isBlockedScheme(url)) event.preventDefault();
    });

    try {
      contents.on("will-frame-navigate", (event, url) => {
        if (isBlockedScheme(url)) event.preventDefault();
      });
    } catch {
      // Electron versions differ on will-frame-navigate support.
    }

    contents.setWindowOpenHandler(({ url }) => {
      return isBlockedScheme(url) ? { action: "deny" } : { action: "allow" };
    });
  });

  app.whenReady().then(() => {
    for (const blocked of BLOCKED_SCHEMES) {
      const scheme = blocked.replace(":", "");
      try {
        protocol.handle(scheme, () => new Response(null, { status: 204 }));
      } catch {
        // A scheme may already be registered during hot restarts.
      }
    }
  });
}

module.exports = {
  BLOCKED_SCHEMES,
  isBlockedScheme,
  installSchemeBlocker
};
