import type { BrowserFingerprint } from './types';

export function generatePermissionsScript(): string {
  return `
  // Permissions API 伪装
  (function() {
    if (!window.navigator.permissions || !window.navigator.permissions.query) return;

    const originalQuery = window.navigator.permissions.query;

    window.navigator.permissions.query = function(parameters) {
      if (parameters && parameters.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission === 'denied' ? 'denied' : Notification.permission,
          status: Notification.permission === 'denied' ? 'denied' : Notification.permission,
          onchange: null,
        });
      }
      return originalQuery.call(this, parameters);
    };

    if (window.__markAsNative) {
      window.__markAsNative(window.navigator.permissions.query, 'query');
    }
  })();
  `;
}

/**
 * 插件列表伪装
 */
export function generatePluginsScript(plugins: BrowserFingerprint['plugins']): string {
  const pluginsJson = JSON.stringify(
    plugins.map((p) => ({
      name: p.name,
      filename: p.filename,
      description: p.description,
      mimeTypes: p.mimeTypes || [],
    }))
  );

  return `
  // 插件列表伪装
  (function() {
    const pluginData = ${pluginsJson};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function defineValue(target, prop, value, enumerable) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: false,
          enumerable: !!enumerable,
          configurable: true,
        });
      } catch (_e) {}
    }

    function defineGetter(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    function ensureConstructor(name, tag) {
      const toStringTag = typeof Symbol === 'function' ? Symbol.toStringTag : null;
      try {
        const existing = window[name];
        if (typeof existing === 'function' && existing.prototype) {
          if (toStringTag && !existing.prototype[toStringTag]) {
            defineValue(existing.prototype, toStringTag, tag, false);
          }
          markNative(existing, name);
          return existing;
        }
      } catch (_e) {}

      const ctor = function() {};
      ctor.prototype = Object.create(Object.prototype);
      if (toStringTag) {
        defineValue(ctor.prototype, toStringTag, tag, false);
      }
      try {
        window[name] = ctor;
      } catch (_e) {}
      markNative(ctor, name);
      return ctor;
    }

    const PluginCtor = ensureConstructor('Plugin', 'Plugin');
    const MimeTypeCtor = ensureConstructor('MimeType', 'MimeType');
    const PluginArrayCtor = ensureConstructor('PluginArray', 'PluginArray');
    const iteratorSymbol = typeof Symbol === 'function' ? Symbol.iterator : null;

    function createMimeType(mt, pluginRef) {
      const mimeType = Object.create(MimeTypeCtor.prototype);
      defineValue(mimeType, 'type', mt.type, false);
      defineValue(mimeType, 'suffixes', mt.suffixes, false);
      defineValue(mimeType, 'description', mt.description, false);
      defineValue(mimeType, 'enabledPlugin', pluginRef || null, false);
      return mimeType;
    }

    function createPlugin(p) {
      const plugin = Object.create(PluginCtor.prototype);
      defineValue(plugin, 'name', p.name, false);
      defineValue(plugin, 'filename', p.filename, false);
      defineValue(plugin, 'description', p.description, false);
      defineValue(plugin, 'length', p.mimeTypes.length, false);
      const item = function(i) { return this[i] || null; };
      const namedItem = function(name) {
        for (let i = 0; i < this.length; i++) {
          const item = this[i];
          if (item && item.type === name) return item;
        }
        return null;
      };
      defineValue(plugin, 'item', item, false);
      defineValue(plugin, 'namedItem', namedItem, false);
      markNative(item, 'item');
      markNative(namedItem, 'namedItem');
      if (iteratorSymbol) {
        const iterator = function* () {
          for (let i = 0; i < this.length; i++) {
            yield this[i];
          }
        };
        defineValue(plugin, iteratorSymbol, iterator, false);
        markNative(iterator, 'Symbol.iterator');
      }

      for (let index = 0; index < p.mimeTypes.length; index++) {
        const mt = p.mimeTypes[index];
        const mimeType = createMimeType(mt, plugin);
        defineValue(plugin, index, mimeType, true);
      }

      return plugin;
    }

    const pluginArray = Object.create(PluginArrayCtor.prototype);
    defineValue(pluginArray, 'length', pluginData.length, false);
    const arrayItem = function(index) { return this[index] || null; };
    const arrayNamedItem = function(name) {
      for (let i = 0; i < this.length; i++) {
        const plugin = this[i];
        if (plugin && plugin.name === name) return plugin;
      }
      return null;
    };
    const refresh = function() {};
    defineValue(pluginArray, 'item', arrayItem, false);
    defineValue(pluginArray, 'namedItem', arrayNamedItem, false);
    defineValue(pluginArray, 'refresh', refresh, false);
    markNative(arrayItem, 'item');
    markNative(arrayNamedItem, 'namedItem');
    markNative(refresh, 'refresh');
    if (iteratorSymbol) {
      const iterator = function* () {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      defineValue(pluginArray, iteratorSymbol, iterator, false);
      markNative(iterator, 'Symbol.iterator');
    }

    for (let i = 0; i < pluginData.length; i++) {
      defineValue(pluginArray, i, createPlugin(pluginData[i]), true);
    }

    const getPlugins = function() { return pluginArray; };
    markNative(getPlugins, 'get plugins');

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = defineGetter(proto, 'plugins', getPlugins) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      defineGetter(navigator, 'plugins', getPlugins);
    }
  })();
  `;
}

/**
 * MimeTypes 伪装
 */
export function generateMimeTypesScript(plugins: BrowserFingerprint['plugins']): string {
  const allMimeTypes = plugins.flatMap((p) => p.mimeTypes || []);
  const mimeTypesJson = JSON.stringify(allMimeTypes);

  return `
  // MimeTypes 伪装
  (function() {
    const mimeTypeData = ${mimeTypesJson};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function defineValue(target, prop, value, enumerable) {
      try {
        Object.defineProperty(target, prop, {
          value: value,
          writable: false,
          enumerable: !!enumerable,
          configurable: true,
        });
      } catch (_e) {}
    }

    function defineGetter(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    function ensureConstructor(name, tag) {
      const toStringTag = typeof Symbol === 'function' ? Symbol.toStringTag : null;
      try {
        const existing = window[name];
        if (typeof existing === 'function' && existing.prototype) {
          if (toStringTag && !existing.prototype[toStringTag]) {
            defineValue(existing.prototype, toStringTag, tag, false);
          }
          markNative(existing, name);
          return existing;
        }
      } catch (_e) {}

      const ctor = function() {};
      ctor.prototype = Object.create(Object.prototype);
      if (toStringTag) {
        defineValue(ctor.prototype, toStringTag, tag, false);
      }
      try {
        window[name] = ctor;
      } catch (_e) {}
      markNative(ctor, name);
      return ctor;
    }

    const MimeTypeCtor = ensureConstructor('MimeType', 'MimeType');
    const MimeTypeArrayCtor = ensureConstructor('MimeTypeArray', 'MimeTypeArray');
    const iteratorSymbol = typeof Symbol === 'function' ? Symbol.iterator : null;

    function createMimeType(mt, pluginRef) {
      const mimeType = Object.create(MimeTypeCtor.prototype);
      defineValue(mimeType, 'type', mt.type, false);
      defineValue(mimeType, 'suffixes', mt.suffixes, false);
      defineValue(mimeType, 'description', mt.description, false);
      defineValue(mimeType, 'enabledPlugin', pluginRef || null, false);
      return mimeType;
    }

    const mimeTypes = [];
    const seenTypes = new Set();
    try {
      const pluginArray = navigator.plugins;
      if (pluginArray && typeof pluginArray.length === 'number') {
        for (let i = 0; i < pluginArray.length; i++) {
          const plugin = pluginArray[i];
          if (!plugin || typeof plugin.length !== 'number') continue;
          for (let j = 0; j < plugin.length; j++) {
            let candidate = plugin[j];
            if (!candidate || !candidate.type) continue;
            if (seenTypes.has(candidate.type)) continue;
            seenTypes.add(candidate.type);
            if (Object.getPrototypeOf(candidate) !== MimeTypeCtor.prototype) {
              try {
                Object.setPrototypeOf(candidate, MimeTypeCtor.prototype);
              } catch (_e) {}
            }
            if (!candidate.enabledPlugin) {
              defineValue(candidate, 'enabledPlugin', plugin, false);
            }
            mimeTypes.push(candidate);
          }
        }
      }
    } catch (_e) {}

    if (mimeTypes.length === 0) {
      for (let i = 0; i < mimeTypeData.length; i++) {
        const mt = mimeTypeData[i];
        if (!mt || !mt.type || seenTypes.has(mt.type)) continue;
        seenTypes.add(mt.type);
        mimeTypes.push(createMimeType(mt, null));
      }
    }

    const mimeTypesArray = Object.create(MimeTypeArrayCtor.prototype);
    defineValue(mimeTypesArray, 'length', mimeTypes.length, false);
    const arrayItem = function(index) { return this[index] || null; };
    const arrayNamedItem = function(name) {
      for (let i = 0; i < this.length; i++) {
        const mt = this[i];
        if (mt && mt.type === name) return mt;
      }
      return null;
    };
    defineValue(mimeTypesArray, 'item', arrayItem, false);
    defineValue(mimeTypesArray, 'namedItem', arrayNamedItem, false);
    markNative(arrayItem, 'item');
    markNative(arrayNamedItem, 'namedItem');
    if (iteratorSymbol) {
      const iterator = function* () {
        for (let i = 0; i < this.length; i++) {
          yield this[i];
        }
      };
      defineValue(mimeTypesArray, iteratorSymbol, iterator, false);
      markNative(iterator, 'Symbol.iterator');
    }

    for (let i = 0; i < mimeTypes.length; i++) {
      defineValue(mimeTypesArray, i, mimeTypes[i], true);
    }

    const getMimeTypes = function() { return mimeTypesArray; };
    markNative(getMimeTypes, 'get mimeTypes');

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = defineGetter(proto, 'mimeTypes', getMimeTypes) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      defineGetter(navigator, 'mimeTypes', getMimeTypes);
    }
  })();
  `;
}

/**
 * 语言列表伪装
 */
export function generateLanguagesScript(languages: string[]): string {
  const languagesJson = JSON.stringify(languages);
  const primary = languages[0] || 'en-US';

  return `
  // 语言列表伪装
  (function() {
    const __airpaLanguages = ${languagesJson};
    const __airpaPrimaryLanguage = ${JSON.stringify(primary)};

    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function tryDefine(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    const getLanguage = function() { return __airpaPrimaryLanguage; };
    const getLanguages = function() { return __airpaLanguages; };
    markNative(getLanguage, 'get language');
    markNative(getLanguages, 'get languages');

    let languagePatched = false;
    let languagesPatched = false;

    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        languagePatched = tryDefine(proto, 'language', getLanguage) || languagePatched;
        languagesPatched = tryDefine(proto, 'languages', getLanguages) || languagesPatched;
      }
    } catch (_e) {}

    languagePatched = tryDefine(navigator, 'language', getLanguage) || languagePatched;
    languagesPatched = tryDefine(navigator, 'languages', getLanguages) || languagesPatched;

    function shouldUseDefaultLocale(locales) {
      if (locales === undefined || locales === null) return true;
      if (Array.isArray(locales) && locales.length === 0) return true;
      if (typeof locales === 'string' && locales.trim().length === 0) return true;
      return false;
    }

    function patchIntlConstructor(name) {
      try {
        const Original = Intl[name];
        if (typeof Original !== 'function') return;
        const Wrapped = function(locales, options) {
          const resolvedLocales = shouldUseDefaultLocale(locales) ? __airpaPrimaryLanguage : locales;
          return new Original(resolvedLocales, options);
        };
        Wrapped.prototype = Original.prototype;
        if (typeof Original.supportedLocalesOf === 'function') {
          Wrapped.supportedLocalesOf = Original.supportedLocalesOf.bind(Original);
        }
        Intl[name] = Wrapped;
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(Wrapped, name);
        }
      } catch (_e) {}
    }

    ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames']
      .forEach(patchIntlConstructor);
  })();
  `;
}

/**
 * 硬件信息伪装
 */
export function generateHardwareScript(fingerprint: BrowserFingerprint): string {
  return `
  // 硬件信息伪装
  (function() {
    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    function tryDefine(target, prop, getter) {
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    const getHardwareConcurrency = function() { return ${fingerprint.hardwareConcurrency}; };
    markNative(getHardwareConcurrency, 'get hardwareConcurrency');

    let hardwarePatched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        hardwarePatched = tryDefine(proto, 'hardwareConcurrency', getHardwareConcurrency) || hardwarePatched;
      }
    } catch (_e) {}

    if (!hardwarePatched) {
      tryDefine(navigator, 'hardwareConcurrency', getHardwareConcurrency);
    }

    if ('deviceMemory' in navigator) {
      const getDeviceMemory = function() { return ${fingerprint.deviceMemory}; };
      markNative(getDeviceMemory, 'get deviceMemory');

      let memoryPatched = false;
      try {
        const proto = Object.getPrototypeOf(navigator);
        if (proto) {
          memoryPatched = tryDefine(proto, 'deviceMemory', getDeviceMemory) || memoryPatched;
        }
      } catch (_e) {}

      if (!memoryPatched) {
        tryDefine(navigator, 'deviceMemory', getDeviceMemory);
      }
    }
  })();
  `;
}

/**
 * Navigator 属性伪装
 */
export function generateNavigatorPropsScript(fingerprint: BrowserFingerprint): string {
  const ua = fingerprint.userAgent;
  const appVersion = ua.startsWith('Mozilla/') ? ua.slice(8) : ua;
  const isFirefox = /Firefox/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/(Chrome|Chromium|Edg)\//i.test(ua);
  const vendor = isFirefox ? '' : isSafari ? 'Apple Computer, Inc.' : 'Google Inc.';
  const productSub = isFirefox ? '20100101' : '20030107';
  const props = {
    platform: fingerprint.platform,
    userAgent: ua,
    appVersion,
    vendor,
    vendorSub: '',
    productSub,
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    product: 'Gecko',
  };

  return `
  // Navigator props spoof
  (function() {
    const props = ${JSON.stringify(props)};

    function defineProp(target, prop, value) {
      const getter = function() { return value; };
      try {
        Object.defineProperty(target, prop, {
          get: getter,
          configurable: true,
          enumerable: true,
        });
        try {
          if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
            window.__markAsNative(getter, prop);
          }
        } catch (_e) {}
        return true;
      } catch (_e) {
        return false;
      }
    }

    function patchProp(prop, value) {
      let patched = false;
      try {
        const proto = Object.getPrototypeOf(navigator);
        if (proto) {
          patched = defineProp(proto, prop, value);
        }
      } catch (_e) {}
      if (!patched) {
        defineProp(navigator, prop, value);
      }
    }

    for (const prop in props) {
      if (Object.prototype.hasOwnProperty.call(props, prop)) {
        patchProp(prop, props[prop]);
      }
    }
  })();
  `;
}

/**
 * 连接类型伪装
 */
export function generateConnectionScript(): string {
  return `
  // 连接类型伪装
  (function() {
    function markNative(fn, name) {
      try {
        if (typeof window !== 'undefined' && typeof window.__markAsNative === 'function') {
          window.__markAsNative(fn, name);
        }
      } catch (_e) {}
    }

    const connection = {
      effectiveType: '4g',
      downlink: 10,
      downlinkMax: 10,
      rtt: 50,
      saveData: false,
      type: 'wifi',
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; },
    };

    markNative(connection.addEventListener, 'addEventListener');
    markNative(connection.removeEventListener, 'removeEventListener');
    markNative(connection.dispatchEvent, 'dispatchEvent');

    const getConnection = function() { return connection; };
    markNative(getConnection, 'get connection');

    function tryDefine(target) {
      try {
        Object.defineProperty(target, 'connection', {
          get: getConnection,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (_e) {
        return false;
      }
    }

    let patched = false;
    try {
      const proto = Object.getPrototypeOf(navigator);
      if (proto) {
        patched = tryDefine(proto) || patched;
      }
    } catch (_e) {}

    if (!patched) {
      tryDefine(navigator);
    }
  })();
  `;
}

/**
 * 屏幕信息伪装
 *
 * 重要：Electron 离屏渲染时，screen.width/height 会返回 0，
 * 这会被抖音等网站的反爬虫系统检测到。必须伪装这些值。
 */
