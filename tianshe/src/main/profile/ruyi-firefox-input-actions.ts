import type {
  DispatchNativeClickParams,
  DispatchNativeDragParams,
  DispatchNativeKeyPressParams,
  DispatchNativeMoveParams,
  DispatchNativeScrollParams,
  DispatchNativeTypeParams,
  DispatchTouchDragParams,
  DispatchTouchLongPressParams,
  DispatchTouchTapParams,
} from './ruyi-firefox-client.types';
import { normalizeButton } from './ruyi-firefox-client-utils';

type BidiInputActionSource = Record<string, unknown>;

const KEY_MODIFIER_MAP: Record<'shift' | 'control' | 'alt' | 'meta', string> = {
  shift: '\uE008',
  control: '\uE009',
  alt: '\uE00A',
  meta: '\uE03D',
};

const KEY_VALUE_MAP: Record<string, string> = {
  Enter: '\uE007',
  Escape: '\uE00C',
  Esc: '\uE00C',
  Tab: '\uE004',
  Backspace: '\uE003',
  Delete: '\uE017',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
  Home: '\uE011',
  End: '\uE010',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
};

export function buildNativeClickActionSources(
  params: DispatchNativeClickParams | undefined
): BidiInputActionSource[] {
  const x = Math.round(Number(params?.x ?? 0));
  const y = Math.round(Number(params?.y ?? 0));
  const button = normalizeButton(params?.button);
  const clickCount = Math.max(1, Math.trunc(params?.clickCount ?? 1));
  const actions: Array<Record<string, unknown>> = [
    {
      type: 'pointerMove',
      x,
      y,
      duration: 0,
    },
  ];

  for (let index = 0; index < clickCount; index += 1) {
    actions.push({ type: 'pointerDown', button });
    if ((params?.delay ?? 0) > 0) {
      actions.push({ type: 'pause', duration: Math.max(1, Math.trunc(params?.delay ?? 0)) });
    }
    actions.push({ type: 'pointerUp', button });
  }

  return [
    {
      type: 'pointer',
      id: 'mouse0',
      parameters: { pointerType: 'mouse' },
      actions,
    },
  ];
}

export function buildNativeMoveActionSources(
  params: DispatchNativeMoveParams | undefined
): BidiInputActionSource[] {
  return [
    {
      type: 'pointer',
      id: 'mouse0',
      parameters: { pointerType: 'mouse' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(Number(params?.x ?? 0)),
          y: Math.round(Number(params?.y ?? 0)),
          duration: 0,
        },
      ],
    },
  ];
}

export function buildNativeDragActionSources(
  params: DispatchNativeDragParams | undefined
): BidiInputActionSource[] {
  const fromX = Math.round(Number(params?.fromX ?? 0));
  const fromY = Math.round(Number(params?.fromY ?? 0));
  const toX = Math.round(Number(params?.toX ?? 0));
  const toY = Math.round(Number(params?.toY ?? 0));
  return [
    {
      type: 'pointer',
      id: 'mouse0',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: fromX, y: fromY, duration: 0 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', x: toX, y: toY, duration: 150 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ];
}

export function buildNativeTypeActionSources(
  params: DispatchNativeTypeParams | undefined
): BidiInputActionSource[] {
  const text = String(params?.text || '');
  const delay = Math.max(0, Math.trunc(params?.delay ?? 0));
  const actions: Array<Record<string, unknown>> = [];
  for (const char of text) {
    actions.push({ type: 'keyDown', value: char });
    if (delay > 0) {
      actions.push({ type: 'pause', duration: delay });
    }
    actions.push({ type: 'keyUp', value: char });
  }

  return [
    {
      type: 'key',
      id: 'keyboard0',
      actions,
    },
  ];
}

export function buildNativeKeyPressActionSources(
  params: DispatchNativeKeyPressParams | undefined
): BidiInputActionSource[] {
  const key = String(params?.key || '').trim();
  if (!key) {
    throw new Error('key is required');
  }

  const modifiers = Array.isArray(params?.modifiers) ? params.modifiers : [];
  const actions: Array<Record<string, unknown>> = [];
  for (const modifier of modifiers) {
    actions.push({ type: 'keyDown', value: KEY_MODIFIER_MAP[modifier] || modifier });
  }
  const mappedKey = KEY_VALUE_MAP[key] || key;
  actions.push({ type: 'keyDown', value: mappedKey });
  actions.push({ type: 'keyUp', value: mappedKey });
  for (const modifier of [...modifiers].reverse()) {
    actions.push({ type: 'keyUp', value: KEY_MODIFIER_MAP[modifier] || modifier });
  }

  return [
    {
      type: 'key',
      id: 'keyboard0',
      actions,
    },
  ];
}

export function buildNativeScrollActionSources(
  params: DispatchNativeScrollParams | undefined
): BidiInputActionSource[] {
  return [
    {
      type: 'wheel',
      id: 'wheel0',
      actions: [
        {
          type: 'scroll',
          x: Math.round(Number(params?.x ?? 0)),
          y: Math.round(Number(params?.y ?? 0)),
          deltaX: Math.round(Number(params?.deltaX ?? 0)),
          deltaY: Math.round(Number(params?.deltaY ?? 0)),
        },
      ],
    },
  ];
}

export function buildTouchTapActionSources(
  params: DispatchTouchTapParams | undefined
): BidiInputActionSource[] {
  return [
    {
      type: 'pointer',
      id: 'touch0',
      parameters: { pointerType: 'touch' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(Number(params?.x ?? 0)),
          y: Math.round(Number(params?.y ?? 0)),
          duration: 0,
        },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 40 },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ];
}

export function buildTouchLongPressActionSources(
  params: DispatchTouchLongPressParams | undefined
): BidiInputActionSource[] {
  return [
    {
      type: 'pointer',
      id: 'touch0',
      parameters: { pointerType: 'touch' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(Number(params?.x ?? 0)),
          y: Math.round(Number(params?.y ?? 0)),
          duration: 0,
        },
        { type: 'pointerDown', button: 0 },
        {
          type: 'pause',
          duration: Math.max(300, Math.trunc(Number(params?.durationMs ?? 600))),
        },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ];
}

export function buildTouchDragActionSources(
  params: DispatchTouchDragParams | undefined
): BidiInputActionSource[] {
  return [
    {
      type: 'pointer',
      id: 'touch0',
      parameters: { pointerType: 'touch' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(Number(params?.fromX ?? 0)),
          y: Math.round(Number(params?.fromY ?? 0)),
          duration: 0,
        },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 60 },
        {
          type: 'pointerMove',
          x: Math.round(Number(params?.toX ?? 0)),
          y: Math.round(Number(params?.toY ?? 0)),
          duration: 180,
        },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ];
}
