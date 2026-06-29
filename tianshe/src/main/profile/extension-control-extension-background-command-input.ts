export function renderCommandInputRuntime(): string {
  return String.raw`async function nativeClick(tabId, x, y, button, clickCount, delay) {
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button,
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    });
    if (delay && delay > 0) {
      await sleep(delay);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    });
  });
}

async function sendKeyEvent(tabId, key, modifiers) {
  const modifierMask = Array.isArray(modifiers)
    ? modifiers.reduce((mask, item) => {
        switch (item) {
          case 'alt':
            return mask | 1;
          case 'control':
            return mask | 2;
          case 'meta':
            return mask | 4;
          case 'shift':
            return mask | 8;
          default:
            return mask;
        }
      }, 0)
    : 0;

  const normalizedKey = String(key || '');
  const printable = normalizedKey.length === 1 ? normalizedKey : undefined;
  const code =
    normalizedKey.length === 1
      ? 'Key' + normalizedKey.toUpperCase()
      : ({
          Enter: 'Enter',
          Tab: 'Tab',
          Escape: 'Escape',
          Backspace: 'Backspace',
          Delete: 'Delete',
          ArrowLeft: 'ArrowLeft',
          ArrowRight: 'ArrowRight',
          ArrowUp: 'ArrowUp',
          ArrowDown: 'ArrowDown',
          Space: 'Space',
        }[normalizedKey] || normalizedKey);

  const virtualKeyCode =
    printable && printable.length === 1
      ? printable.toUpperCase().charCodeAt(0)
      : ({
          Enter: 13,
          Tab: 9,
          Escape: 27,
          Backspace: 8,
          Delete: 46,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          Space: 32,
        }[normalizedKey] || 0);

  await withDebugger(tabId, async () => {
    for (const modifier of Array.isArray(modifiers) ? modifiers : []) {
      const name =
        modifier === 'control'
          ? 'Control'
          : modifier === 'shift'
            ? 'Shift'
            : modifier === 'alt'
              ? 'Alt'
              : modifier === 'meta'
                ? 'Meta'
                : null;
      if (!name) continue;
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: name,
        code: name,
        windowsVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        nativeVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        modifiers: modifierMask,
      });
    }

    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: printable ? 'keyDown' : 'rawKeyDown',
      key: normalizedKey,
      code,
      text: printable,
      unmodifiedText: printable,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers: modifierMask,
    });

    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: normalizedKey,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers: modifierMask,
    });

    for (const modifier of (Array.isArray(modifiers) ? modifiers : []).slice().reverse()) {
      const name =
        modifier === 'control'
          ? 'Control'
          : modifier === 'shift'
            ? 'Shift'
            : modifier === 'alt'
              ? 'Alt'
              : modifier === 'meta'
                ? 'Meta'
                : null;
      if (!name) continue;
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: name,
        code: name,
        windowsVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        nativeVirtualKeyCode:
          name === 'Control' ? 17 : name === 'Shift' ? 16 : name === 'Alt' ? 18 : 91,
        modifiers: modifierMask,
      });
    }
  });
}`;
}
