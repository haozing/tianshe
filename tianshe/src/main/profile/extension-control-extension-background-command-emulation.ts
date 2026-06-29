export function renderCommandEmulationRuntime(): string {
  return String.raw`function buildTouchEmulationPayload(enabled) {
  return enabled ? { enabled: true, maxTouchPoints: 1 } : { enabled: false };
}

function hasEmulationOption(options, name) {
  return Object.prototype.hasOwnProperty.call(options || {}, name);
}

function normalizeOptionalString(value, trim) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = trim ? value.trim() : value;
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalGeolocation(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = Number(value.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('geolocation requires finite latitude and longitude');
  }
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 100,
  };
}

function normalizeViewportSize(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(label + ' must be a finite number');
  }
  return Math.max(1, Math.round(numeric));
}

function normalizeDevicePixelRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1;
  }
  return numeric;
}

function createEmulationBaselineSnapshot(raw) {
  return {
    userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : '',
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    acceptLanguage:
      typeof raw.acceptLanguage === 'string' && raw.acceptLanguage.trim().length > 0
        ? raw.acceptLanguage
        : typeof raw.locale === 'string'
          ? raw.locale
          : '',
    locale: typeof raw.locale === 'string' ? raw.locale : '',
    timezoneId: typeof raw.timezoneId === 'string' ? raw.timezoneId : '',
    touch: !!raw.touch,
  };
}

async function captureEmulationBaseline(tabId) {
  const raw = await runDomTask(tabId, 'evaluate', {
    script:
      '(() => {' +
      '  const resolved = typeof Intl !== "undefined" && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions() : {};' +
      '  const languages = Array.isArray(navigator.languages)' +
      '    ? navigator.languages.map((value) => String(value || "").trim()).filter(Boolean)' +
      '    : [];' +
      '  const locale = String((resolved && resolved.locale) || navigator.language || "");' +
      '  return {' +
      '    userAgent: String(navigator.userAgent || ""),' +
      '    platform: String(navigator.platform || ""),' +
      '    acceptLanguage: languages.length > 0 ? languages.join(",") : locale,' +
      '    locale,' +
      '    timezoneId: String((resolved && resolved.timeZone) || ""),' +
      '    touch: Number(navigator.maxTouchPoints || 0) > 0,' +
      '  };' +
      '})()',
  });
  return createEmulationBaselineSnapshot(raw || {});
}

async function ensureEmulationBaseline(tabId) {
  const state = getTabState(tabId);
  if (state.emulation && state.emulation.baseline) {
    return state.emulation.baseline;
  }
  const baseline = await captureEmulationBaseline(tabId);
  state.emulation.baseline = baseline;
  return baseline;
}

async function applyIdentityEmulation(tabId, options) {
  const state = getTabState(tabId);
  const baseline = await ensureEmulationBaseline(tabId);
  const current = state.emulation.current;

  const hasUserAgent = hasEmulationOption(options, 'userAgent');
  const hasLocale = hasEmulationOption(options, 'locale');
  const hasTimezoneId = hasEmulationOption(options, 'timezoneId');
  const hasTouch = hasEmulationOption(options, 'touch');
  const hasGeolocation = hasEmulationOption(options, 'geolocation');

  if (hasUserAgent) {
    current.userAgent = normalizeOptionalString(options.userAgent, false);
  }
  if (hasLocale) {
    current.locale = normalizeOptionalString(options.locale, true);
  }
  if (hasTimezoneId) {
    current.timezoneId = normalizeOptionalString(options.timezoneId, true);
  }
  if (hasTouch) {
    current.touch = !!options.touch;
  }
  if (hasGeolocation) {
    current.geolocation = normalizeOptionalGeolocation(options.geolocation);
  }

  await withDebugger(tabId, async () => {
    if (hasUserAgent || hasLocale) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
        userAgent: current.userAgent || baseline.userAgent,
        acceptLanguage: current.locale || baseline.acceptLanguage || baseline.locale || undefined,
        platform: baseline.platform || undefined,
      });
    }

    if (hasLocale) {
      const locale = current.locale || baseline.locale;
      if (locale) {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', {
          locale,
        });
      }
    }

    if (hasTimezoneId) {
      const timezoneId = current.timezoneId || baseline.timezoneId;
      if (timezoneId) {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
          timezoneId,
        });
      }
    }

    if (hasTouch) {
      const touchEnabled = current.touch === null ? baseline.touch : current.touch === true;
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setTouchEmulationEnabled',
        buildTouchEmulationPayload(touchEnabled)
      );
    }

    if (hasGeolocation) {
      if (current.geolocation) {
        await chrome.debugger.sendCommand(
          { tabId },
          'Emulation.setGeolocationOverride',
          current.geolocation
        );
      } else {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride');
      }
    }

    state.emulation.active = true;
  });
}

async function applyViewportEmulation(tabId, options) {
  if (!options || typeof options !== 'object') {
    throw new Error('viewport options are required');
  }

  const state = getTabState(tabId);
  const width = normalizeViewportSize(options.width, 'viewport width');
  const height = normalizeViewportSize(options.height, 'viewport height');
  const deviceScaleFactor = normalizeDevicePixelRatio(options.devicePixelRatio);

  await ensureEmulationBaseline(tabId);
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: options.isMobile === true,
    });

    if (hasEmulationOption(options, 'hasTouch')) {
      state.emulation.current.touch = !!options.hasTouch;
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setTouchEmulationEnabled',
        buildTouchEmulationPayload(state.emulation.current.touch)
      );
    }

    state.emulation.active = true;
  });
}

async function clearEmulationOverrides(tabId) {
  const state = getTabState(tabId);
  const baseline = await ensureEmulationBaseline(tabId);

  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearGeolocationOverride');
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.setTouchEmulationEnabled',
      buildTouchEmulationPayload(baseline.touch)
    );
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', {
      userAgent: baseline.userAgent,
      acceptLanguage: baseline.acceptLanguage || baseline.locale || undefined,
      platform: baseline.platform || undefined,
    });
    if (baseline.locale) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setLocaleOverride', {
        locale: baseline.locale,
      });
    }
    if (baseline.timezoneId) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTimezoneOverride', {
        timezoneId: baseline.timezoneId,
      });
    }
    state.emulation.active = false;
    state.emulation.current = createEmptyEmulationOverrideState();
  });

  await detachDebuggerIfIdle(tabId);
}`;
}
