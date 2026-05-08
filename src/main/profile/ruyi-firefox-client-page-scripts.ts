export function getWindowOpenPolicyInstallerFunction(): string {
  return String.raw`(policy) => {
    const globalObj = globalThis;
    const stateKey = '__airpaRuyiWindowOpenPolicyState';
    const existing = globalObj[stateKey];
    if (existing && typeof existing.cleanup === 'function') {
      try { existing.cleanup(); } catch {}
    }

    const toMatcher = (descriptor) => {
      if (!descriptor || typeof descriptor !== 'object') return null;
      if (descriptor.kind === 'regex') {
        try {
          return new RegExp(String(descriptor.source || ''), String(descriptor.flags || ''));
        } catch {
          return null;
        }
      }
      return String(descriptor.value || '');
    };

    const matchesPattern = (pattern, url) => {
      const input = String(url || '');
      if (!pattern) return false;
      if (pattern instanceof RegExp) return pattern.test(input);
      const text = String(pattern);
      if (!text) return false;
      if (text.includes('*')) {
        const escaped = text.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp('^' + escaped + '$', 'i').test(input);
      }
      return input.includes(text);
    };

    const resolveAction = (url) => {
      const rules = Array.isArray(policy && policy.rules) ? policy.rules : [];
      for (const rule of rules) {
        const matcher = toMatcher(rule && rule.match);
        if (matchesPattern(matcher, url)) {
          return String((rule && rule.action) || 'allow');
        }
      }
      return String((policy && policy.default) || 'allow');
    };

    const originalOpen =
      existing && typeof existing.originalOpen === 'function'
        ? existing.originalOpen
        : typeof globalObj.open === 'function'
          ? globalObj.open.bind(globalObj)
          : null;

    const handleDecision = (urlValue) => {
      const url = String(urlValue || '');
      const action = resolveAction(url);
      if (action === 'deny') {
        return { handled: true, navigate: false, url };
      }
      if (action === 'same-window') {
        return { handled: true, navigate: true, url };
      }
      return { handled: false, navigate: false, url };
    };

    const clickListener = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      let anchor = null;
      for (const candidate of path) {
        if (candidate && typeof candidate === 'object' && typeof candidate.closest === 'function') {
          const found = candidate.closest('a[target="_blank"], area[target="_blank"]');
          if (found) {
            anchor = found;
            break;
          }
        }
      }
      if (!anchor && event.target && typeof event.target.closest === 'function') {
        anchor = event.target.closest('a[target="_blank"], area[target="_blank"]');
      }
      if (!anchor) return;

      const href = typeof anchor.href === 'string' ? anchor.href : '';
      const decision = handleDecision(href);
      if (!decision.handled) return;

      event.preventDefault();
      event.stopPropagation();
      if (decision.navigate && decision.url) {
        globalObj.location.assign(decision.url);
      }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', clickListener, true);
    }

    if (originalOpen) {
      globalObj.open = function(url, target, features) {
        const decision = handleDecision(url);
        if (decision.handled) {
          if (decision.navigate && decision.url) {
            globalObj.location.assign(decision.url);
            return globalObj;
          }
          return null;
        }
        return originalOpen(url, target, features);
      };
    }

    globalObj[stateKey] = {
      originalOpen,
      cleanup() {
        try {
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('click', clickListener, true);
          }
        } catch {}
        if (originalOpen) {
          globalObj.open = originalOpen;
        }
        try { delete globalObj[stateKey]; } catch {}
      },
    };
  }`;
}

export function getWindowOpenPolicyClearFunction(): string {
  return String.raw`() => {
    const globalObj = globalThis;
    const stateKey = '__airpaRuyiWindowOpenPolicyState';
    const existing = globalObj[stateKey];
    if (existing && typeof existing.cleanup === 'function') {
      try { existing.cleanup(); } catch {}
    }
  }`;
}

export function getActiveContextTrackerInstallerFunction(): string {
  return String.raw`(emit) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const globalObj = globalThis;
    const stateKey = '__airpaRuyiActiveContextTrackerState';
    const existing = globalObj[stateKey];
    if (existing && typeof existing.cleanup === 'function') {
      try { existing.cleanup(); } catch {}
    }

    const isActiveDocument = () => {
      try {
        const visible = typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : false;
        return Boolean(visible || focused);
      } catch {
        return false;
      }
    };

    const report = (reason) => {
      try {
        emit({
          active: isActiveDocument(),
          reason,
          visibilityState: typeof document.visibilityState === 'string' ? document.visibilityState : null,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
          href: typeof location !== 'undefined' ? String(location.href || '') : '',
        });
      } catch {}
    };

    const onFocus = () => report('focus');
    const onVisibilityChange = () => report('visibilitychange');
    const onPageShow = () => report('pageshow');
    const onPointerDown = () => report('pointerdown');
    const onKeyDown = () => report('keydown');

    window.addEventListener('focus', onFocus, true);
    window.addEventListener('pageshow', onPageShow, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibilityChange, true);

    globalObj[stateKey] = {
      cleanup: () => {
        try { window.removeEventListener('focus', onFocus, true); } catch {}
        try { window.removeEventListener('pageshow', onPageShow, true); } catch {}
        try { window.removeEventListener('pointerdown', onPointerDown, true); } catch {}
        try { window.removeEventListener('keydown', onKeyDown, true); } catch {}
        try { document.removeEventListener('visibilitychange', onVisibilityChange, true); } catch {}
      },
    };

    report('init');
  }`;
}
