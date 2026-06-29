/**
 * 页面快照脚本
 *
 * 用于提取页面元素信息供大模型理解页面结构
 * 大模型可基于返回的 attributes 自行构建选择器，并使用 browser_validate_selector 验证
 */

/**
 * 注入到页面的脚本，用于提取元素信息
 * 返回一个立即执行函数的字符串
 */
export function getSnapshotScript(elementsFilter: 'all' | 'interactive' = 'interactive'): string {
  return `
(function() {
  const result = {
    elements: []
  };
  const elementsFilter = ${JSON.stringify(elementsFilter)};

  // ========== 工具函数 ==========

  /**
   * 检查元素是否可见
   */
  function isVisible(el) {
    if (!el) return false;

    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;

    // 检查尺寸
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    return true;
  }

  function escapeSelectorValue(value) {
    try {
      return CSS.escape(value);
    } catch {
      return String(value).replace(/["\\\\]/g, '\\\\$&');
    }
  }

  function textSnippet(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  }

  function getBounds(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  }

  function isMeaningful(el) {
    if (!isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const text = textSnippet(el.innerText || el.textContent || '');
    const hasSemanticTag = [
      'main',
      'nav',
      'header',
      'footer',
      'section',
      'article',
      'aside',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'li',
      'label',
      'table',
      'th',
      'td',
      'summary',
      'details',
      'img'
    ].includes(tag);
    const hasInteractiveSemantics = [
      'a',
      'button',
      'input',
      'select',
      'textarea'
    ].includes(tag) || [
      'button',
      'link',
      'checkbox',
      'radio',
      'textbox',
      'searchbox',
      'combobox',
      'listbox',
      'slider'
    ].includes(role);
    const hasUsefulMetadata =
      text.length > 0 ||
      !!el.getAttribute('aria-label') ||
      !!el.getAttribute('data-testid') ||
      !!el.getAttribute('title') ||
      !!el.getAttribute('placeholder') ||
      (typeof el.value === 'string' && textSnippet(el.value).length > 0);

    return hasSemanticTag || hasInteractiveSemantics || hasUsefulMetadata;
  }

  /**
   * 获取元素的 ARIA 角色
   */
  function getRole(el) {
    // 优先使用显式 role 属性
    const explicitRole = el.getAttribute('role');
    if (explicitRole) return explicitRole;

    // 根据标签推断角色
    const tag = el.tagName.toLowerCase();
    const type = el.type?.toLowerCase();

    switch (tag) {
      case 'a':
        return el.href ? 'link' : 'generic';
      case 'button':
        return 'button';
      case 'input':
        switch (type) {
          case 'button':
          case 'submit':
          case 'reset':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'range':
            return 'slider';
          case 'search':
            return 'searchbox';
          default:
            return 'textbox';
        }
      case 'select':
        return el.multiple ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'img':
        return 'img';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'header':
        return 'banner';
      case 'footer':
        return 'contentinfo';
      case 'article':
        return 'article';
      case 'aside':
        return 'complementary';
      case 'form':
        return 'form';
      case 'table':
        return 'table';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      default:
        return 'generic';
    }
  }

  /**
   * 获取元素的可访问名称
   */
  function getAccessibleName(el) {
    // 1. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // 2. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent?.trim() || '';
    }

    // 3. 关联的 label
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label) return label.textContent?.trim() || '';
    }

    // 4. 包裹的 label
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // 排除输入框本身的文本
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll('input, select, textarea');
      inputs.forEach(input => input.remove());
      const text = clone.textContent?.trim();
      if (text) return text;
    }

    // 5. placeholder
    if (el.placeholder) return el.placeholder;

    // 6. title
    if (el.title) return el.title;

    // 7. 按钮/链接的文本内容
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'label'].includes(tag)) {
      return el.textContent?.trim().slice(0, 50) || '';
    }

    // 8. input 的 value（对于按钮类型）
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) {
      return el.value || '';
    }

    // 9. alt 文本（图片）
    if (el.alt) return el.alt;

    return '';
  }

  function getSelectorCandidates(el, name, text) {
    const candidates = [];
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      candidates.push('#' + escapeSelectorValue(el.id));
    }

    const dataTestId = el.getAttribute('data-testid');
    if (dataTestId) {
      candidates.push('[data-testid="' + String(dataTestId).replace(/"/g, '\\"') + '"]');
    }

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      candidates.push('[aria-label="' + String(ariaLabel).replace(/"/g, '\\"') + '"]');
    }

    if (el.getAttribute('name')) {
      candidates.push(tag + '[name="' + String(el.getAttribute('name')).replace(/"/g, '\\"') + '"]');
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) {
      candidates.push(tag + '[placeholder="' + String(placeholder).replace(/"/g, '\\"') + '"]');
    }

    const classNames =
      typeof el.className === 'string'
        ? el.className
            .trim()
            .split(/\\s+/)
            .filter(Boolean)
            .slice(0, 2)
        : [];
    if (classNames.length > 0) {
      candidates.push(tag + '.' + classNames.map(escapeSelectorValue).join('.'));
    }

    const snippet = textSnippet(name || text || el.innerText || el.textContent || '');
    if (snippet) {
      candidates.push(tag + ':has-text("' + snippet.replace(/"/g, '\\"') + '")');
    }

    candidates.push(tag);
    return Array.from(new Set(candidates)).slice(0, 6);
  }

  // ========== 主逻辑 ==========

  // 获取所有可交互元素
  const interactiveSelector = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  const semanticSelector = [
    interactiveSelector,
    'main',
    'nav',
    'header',
    'footer',
    'section',
    'article',
    'aside',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'li',
    'label',
    'summary',
    'details',
    'table',
    'th',
    'td',
    'img[alt]',
    '[data-testid]',
    '[aria-label]'
  ].join(', ');

  const sourceSelector = elementsFilter === 'all' ? semanticSelector : interactiveSelector;
  const elements = Array.from(document.querySelectorAll(sourceSelector));
  const visited = new Set();

  elements.forEach(el => {
    if (visited.has(el)) return;
    visited.add(el);

    // 跳过不可见元素
    if (!isVisible(el)) return;

    // 跳过禁用元素
    if (el.disabled) return;

    if (elementsFilter === 'all' && !isMeaningful(el)) return;

    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const name = getAccessibleName(el);
    const text = textSnippet(el.textContent || '');
    const selectorCandidates = getSelectorCandidates(el, name, text);

    const elementInfo = {
      tag: tag,
      role: role,
      name: name,
      preferredSelector: selectorCandidates[0],
      selectorCandidates: selectorCandidates,
      inViewport: isInViewport(el),
      bounds: getBounds(el),
    };

    // 添加文本内容（如果与 name 不同）
    if (text && text !== name) {
      elementInfo.text = text;
    }

    // 添加输入框的值
    if (el.value !== undefined && el.value !== '') {
      elementInfo.value = el.value;
    }

    // 添加 placeholder
    if (el.placeholder) {
      elementInfo.placeholder = el.placeholder;
    }

    // 添加 checked 状态
    if (el.type === 'checkbox' || el.type === 'radio') {
      elementInfo.checked = el.checked;
    }

    // 添加重要属性（供大模型构建选择器）
    const attributes = {};
    if (el.id) attributes.id = el.id;
    if (el.className && typeof el.className === 'string') {
      attributes.class = el.className.trim().slice(0, 100);
    }
    if (el.name) attributes.name = el.name;
    if (el.type) attributes.type = el.type;
    if (el.href) attributes.href = el.href;
    if (el.getAttribute('data-testid')) {
      attributes['data-testid'] = el.getAttribute('data-testid');
    }
    if (el.getAttribute('aria-label')) {
      attributes['aria-label'] = el.getAttribute('aria-label');
    }

    if (Object.keys(attributes).length > 0) {
      elementInfo.attributes = attributes;
    }

    result.elements.push(elementInfo);
  });

  return result;
})()
`;
}

/**
 * 注入到页面的选择器引擎脚本
 * 支持扩展选择器语法如 :has-text()
 */
export function getSelectorEngineScript(): string {
  return `
(function() {
  if (window.__selectorEngine) {
    return;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           el.getBoundingClientRect().width > 0 &&
           el.getBoundingClientRect().height > 0;
  }

  window.__selectorEngine = {
    /**
     * 查询单个元素
     */
    querySelector: function(selector) {
      // 处理 :has-text() 扩展语法
      const textMatch = selector.match(/^(.+):has-text\\("(.+)"\\)$/);
      if (textMatch) {
        const [, baseSelector, text] = textMatch;
        const elements = document.querySelectorAll(baseSelector);
        for (const el of elements) {
          if (el.textContent?.includes(text)) {
            return el;
          }
        }
        return null;
      }

      // 处理 :visible 扩展语法
      const visibleMatch = selector.match(/^(.+):visible$/);
      if (visibleMatch) {
        const [, baseSelector] = visibleMatch;
        const elements = document.querySelectorAll(baseSelector);
        for (const el of elements) {
          if (isVisible(el)) {
            return el;
          }
        }
        return null;
      }

      // 标准 CSS 选择器
      return document.querySelector(selector);
    },

    /**
     * 查询所有元素
     */
    querySelectorAll: function(selector) {
      // 处理 :has-text() 扩展语法
      const textMatch = selector.match(/^(.+):has-text\\("(.+)"\\)$/);
      if (textMatch) {
        const [, baseSelector, text] = textMatch;
        const elements = document.querySelectorAll(baseSelector);
        return Array.from(elements).filter(el => el.textContent?.includes(text));
      }

      // 处理 :visible 扩展语法
      const visibleMatch = selector.match(/^(.+):visible$/);
      if (visibleMatch) {
        const [, baseSelector] = visibleMatch;
        const elements = document.querySelectorAll(baseSelector);
        return Array.from(elements).filter(el => isVisible(el));
      }

      // 标准 CSS 选择器
      return Array.from(document.querySelectorAll(selector));
    },

    /**
     * 检查元素是否可见
     */
    isVisible: function(el) {
      return isVisible(el);
    }
  };
})()
`;
}

/**
 * 获取页面结构分析脚本
 */
export function getPageStructureScript(): string {
  return `
(function() {
  return {
    hasHeader: !!document.querySelector('header, [role="banner"]'),
    hasNavigation: !!document.querySelector('nav, [role="navigation"]'),
    hasMainContent: !!document.querySelector('main, [role="main"]'),
    hasSidebar: !!document.querySelector('aside, [role="complementary"]'),
    hasFooter: !!document.querySelector('footer, [role="contentinfo"]'),
    mainHeading: document.querySelector('h1')?.textContent?.trim() || '',
    sections: Array.from(document.querySelectorAll('section')).map(s => ({
      heading: s.querySelector('h2, h3')?.textContent?.trim() || '',
      elementCount: s.querySelectorAll('a, button, input').length
    })).slice(0, 5)
  };
})()
`;
}
