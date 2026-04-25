import type { OrchestrationCapabilityDefinition, OrchestrationDependencies } from '../orchestration/types';
import type { CapabilityHandler } from './types';
import type { ToolHandlerDependencies } from './browser/handlers/types';
import { browserHandlers } from './browser/handlers/browser-handlers';
import {
  type BrowserToolName,
  type PublicBrowserToolName,
} from './browser/tool-definitions';
import { PUBLIC_BROWSER_TOOL_MANIFEST } from './browser/tool-manifest';
import {
  buildCapabilityAnnotations,
  createArrayItemsSchema,
  createOpaqueOutputSchema,
  createStructuredEnvelopeSchema,
  toCapabilityTitle,
} from './catalog-utils';

export interface RegisteredCapability {
  definition: OrchestrationCapabilityDefinition;
  handler: CapabilityHandler<OrchestrationDependencies>;
}

const BROWSER_CAPABILITY_VERSION = '1.0.0';
const DEFAULT_BROWSER_OUTPUT_SCHEMA = createOpaqueOutputSchema(
  'Capability-specific browser tool result.'
);

const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] } as const;
const NULLABLE_NUMBER_SCHEMA = { type: ['number', 'null'] } as const;
const STRING_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'string' },
} as const;
const NUMBER_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'number' },
} as const;

const SNAPSHOT_BOUNDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
} as const;

const SNAPSHOT_ATTRIBUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    class: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string' },
    href: { type: 'string' },
    src: { type: 'string' },
    'data-testid': { type: 'string' },
    'aria-label': { type: 'string' },
  },
} as const;

const SNAPSHOT_ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tag', 'role', 'name'],
  properties: {
    tag: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    text: { type: 'string' },
    value: { type: 'string' },
    placeholder: { type: 'string' },
    checked: { type: 'boolean' },
    disabled: { type: 'boolean' },
    attributes: SNAPSHOT_ATTRIBUTES_SCHEMA,
    preferredSelector: { type: 'string' },
    selectorCandidates: {
      type: 'array',
      items: { type: 'string' },
    },
    elementRef: { type: 'string' },
    inViewport: { type: 'boolean' },
    bounds: SNAPSHOT_BOUNDS_SCHEMA,
  },
} as const;

const PAGE_STRUCTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hasHeader', 'hasNavigation', 'hasMainContent', 'hasSidebar', 'hasFooter'],
  properties: {
    hasHeader: { type: 'boolean' },
    hasNavigation: { type: 'boolean' },
    hasMainContent: { type: 'boolean' },
    hasSidebar: { type: 'boolean' },
    hasFooter: { type: 'boolean' },
    mainHeading: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'elementCount'],
        properties: {
          heading: { type: 'string' },
          elementCount: { type: 'number' },
        },
      },
    },
  },
} as const;

const KEY_ELEMENTS_COUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'forms',
    'textInputs',
    'passwordInputs',
    'checkboxes',
    'radioButtons',
    'selectBoxes',
    'buttons',
    'links',
    'images',
  ],
  properties: {
    forms: { type: 'number' },
    textInputs: { type: 'number' },
    passwordInputs: { type: 'number' },
    checkboxes: { type: 'number' },
    radioButtons: { type: 'number' },
    selectBoxes: { type: 'number' },
    buttons: { type: 'number' },
    links: { type: 'number' },
    images: { type: 'number' },
  },
} as const;

const PAGE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pageType',
    'confidence',
    'intent',
    'structure',
    'keyElements',
    'primaryActions',
    'primaryInputs',
    'secondaryLinks',
  ],
  properties: {
    pageType: {
      type: 'string',
      enum: [
        'login',
        'register',
        'search',
        'search-results',
        'list',
        'detail',
        'form',
        'dashboard',
        'profile',
        'settings',
        'checkout',
        'article',
        'landing',
        'unknown',
      ],
    },
    confidence: { type: 'number' },
    intent: { type: 'string' },
    structure: PAGE_STRUCTURE_SCHEMA,
    keyElements: KEY_ELEMENTS_COUNT_SCHEMA,
    primaryActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text'],
        properties: {
          type: { type: 'string' },
          text: { type: 'string' },
          attributes: SNAPSHOT_ATTRIBUTES_SCHEMA,
        },
      },
    },
    primaryInputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'type', 'required'],
        properties: {
          label: { type: 'string' },
          type: { type: 'string' },
          required: { type: 'boolean' },
          value: { type: 'string' },
          attributes: SNAPSHOT_ATTRIBUTES_SCHEMA,
        },
      },
    },
    secondaryLinks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'href'],
        properties: {
          text: { type: 'string' },
          href: { type: 'string' },
        },
      },
    },
    loginStatus: {
      type: 'object',
      additionalProperties: false,
      required: ['mayNeedLogin', 'isAuthPage', 'authElements'],
      properties: {
        mayNeedLogin: { type: 'boolean' },
        isAuthPage: { type: 'boolean' },
        authElements: {
          type: 'object',
          additionalProperties: false,
          required: [
            'hasLoginForm',
            'hasPasswordField',
            'hasLoginButton',
            'hasLogoutButton',
            'hasUserMenu',
          ],
          properties: {
            hasLoginForm: { type: 'boolean' },
            hasPasswordField: { type: 'boolean' },
            hasLoginButton: { type: 'boolean' },
            hasLogoutButton: { type: 'boolean' },
            hasUserMenu: { type: 'boolean' },
          },
        },
        suggestion: { type: 'string' },
      },
    },
  },
} as const;

const NETWORK_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'url', 'method', 'resourceType', 'classification', 'startTime'],
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    method: { type: 'string' },
    resourceType: { type: 'string' },
    classification: { type: 'string', enum: ['document', 'api', 'static', 'media', 'other'] },
    status: { type: 'number' },
    statusText: { type: 'string' },
    requestHeaders: STRING_MAP_SCHEMA,
    responseHeaders: STRING_MAP_SCHEMA,
    requestBody: { type: 'string' },
    responseBody: { type: 'string' },
    startTime: { type: 'number' },
    endTime: { type: 'number' },
    duration: { type: 'number' },
    error: { type: 'string' },
  },
} as const;

const NETWORK_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'byType', 'byMethod', 'failed', 'slow', 'apiCalls'],
  properties: {
    total: { type: 'number' },
    byType: NUMBER_MAP_SCHEMA,
    byMethod: NUMBER_MAP_SCHEMA,
    failed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'status', 'method'],
        properties: {
          url: { type: 'string' },
          status: { type: 'number' },
          method: { type: 'string' },
        },
      },
    },
    slow: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'duration', 'method'],
        properties: {
          url: { type: 'string' },
          duration: { type: 'number' },
          method: { type: 'string' },
        },
      },
    },
    apiCalls: {
      type: 'array',
      items: NETWORK_ENTRY_SCHEMA,
    },
  },
} as const;

const CONSOLE_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'message', 'timestamp'],
  properties: {
    level: { type: 'string', enum: ['verbose', 'info', 'warning', 'error'] },
    message: { type: 'string' },
    source: { type: 'string' },
    line: { type: 'number' },
    timestamp: { type: 'number' },
  },
} as const;

const PAGE_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'title', 'elements'],
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    elements: {
      type: 'array',
      items: SNAPSHOT_ELEMENT_SCHEMA,
    },
    summary: PAGE_SUMMARY_SCHEMA,
    network: {
      type: 'array',
      items: NETWORK_ENTRY_SCHEMA,
    },
    networkSummary: NETWORK_SUMMARY_SCHEMA,
    console: {
      type: 'array',
      items: CONSOLE_MESSAGE_SCHEMA,
    },
  },
} as const;

const INTERACTION_DIAGNOSTICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'viewportWidth',
    'viewportHeight',
    'totalElements',
    'elementsWithBounds',
    'outOfViewportCount',
    'negativeBoundsCount',
    'overflowBoundsCount',
  ],
  properties: {
    viewportWidth: { type: 'number' },
    viewportHeight: { type: 'number' },
    totalElements: { type: 'number' },
    elementsWithBounds: { type: 'number' },
    outOfViewportCount: { type: 'number' },
    negativeBoundsCount: { type: 'number' },
    overflowBoundsCount: { type: 'number' },
  },
} as const;

const INTERACTION_HEALTH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'interactionReady',
    'viewportHealth',
    'sessionVisibility',
    'hostWindowId',
    'offscreenDetected',
  ],
  properties: {
    interactionReady: { type: 'boolean' },
    viewportHealth: { type: 'string', enum: ['unknown', 'ready', 'warning', 'broken'] },
    viewportHealthReason: { type: ['string', 'null'] },
    sessionVisibility: { type: 'string', enum: ['visible', 'hidden', 'unknown'] },
    hostWindowId: { type: ['string', 'null'] },
    offscreenDetected: { type: 'boolean' },
    diagnostics: INTERACTION_DIAGNOSTICS_SCHEMA,
  },
} as const;

const ACTION_WAIT_TARGET_LEAF_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'value'],
  properties: {
    type: { type: 'string', enum: ['selector', 'ref', 'text', 'textGone', 'urlIncludes'] },
    value: { type: 'string' },
    selector: { type: ['string', 'null'] },
    ref: { type: ['string', 'null'] },
    source: { type: ['string', 'null'] },
    state: { type: ['string', 'null'], enum: ['attached', 'visible', null] },
  },
} as const;

const createActionWaitTargetGroupOutputSchema = (depth: number): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'value', 'conditions'],
  properties: {
    type: { type: 'string', enum: ['allOf', 'anyOf'] },
    value: { type: 'string', enum: ['allOf', 'anyOf'] },
    selector: { type: 'null' },
    ref: { type: 'null' },
    source: { type: 'null' },
    state: { type: 'null' },
    conditions: {
      type: 'array',
      items:
        depth <= 0
          ? ACTION_WAIT_TARGET_LEAF_OUTPUT_SCHEMA
          : {
              anyOf: [
                ACTION_WAIT_TARGET_LEAF_OUTPUT_SCHEMA,
                createActionWaitTargetGroupOutputSchema(depth - 1),
              ],
            },
    },
  },
});

const ACTION_WAIT_TARGET_OUTPUT_SCHEMA: Record<string, unknown> = {
  anyOf: [
    ACTION_WAIT_TARGET_LEAF_OUTPUT_SCHEMA,
    createActionWaitTargetGroupOutputSchema(2),
    { type: 'null' },
  ],
};

const TEXT_MATCH_SOURCE_OUTPUT_SCHEMA = {
  type: 'string',
  enum: ['dom', 'ocr', 'none'],
} as const;

const TEXT_CLICK_METHOD_OUTPUT_SCHEMA = {
  type: 'string',
  enum: ['dom-click', 'dom-anchor-assign', 'native-click'],
} as const;

const REGION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    space: { type: 'string', enum: ['normalized', 'viewport'] },
  },
} as const;

const BROWSER_ACT_ELEMENT_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['element'] },
    selector: { type: 'string' },
    ref: NULLABLE_STRING_SCHEMA,
  },
  anyOf: [{ required: ['selector'] }, { required: ['ref'] }],
} as const;

const RESOLVED_TARGET_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['selector', 'source', 'ref', 'selectorCandidates'],
  properties: {
    selector: NULLABLE_STRING_SCHEMA,
    source: { type: ['string', 'null'], enum: ['selector', 'ref', null] },
    ref: NULLABLE_STRING_SCHEMA,
    selectorCandidates: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'string' },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

const BROWSER_ACT_SELECTOR_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['selector', 'ref'],
  properties: {
    selector: NULLABLE_STRING_SCHEMA,
    ref: NULLABLE_STRING_SCHEMA,
  },
} as const;

const BROWSER_ACT_PRESS_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'key', 'modifiers'],
  properties: {
    kind: { type: 'string', enum: ['key'] },
    key: { type: 'string' },
    modifiers: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['shift', 'control', 'alt', 'meta'],
      },
    },
  },
} as const;

const BROWSER_ACT_TEXT_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text', 'strategy'],
  properties: {
    kind: { type: 'string', enum: ['text'] },
    text: { type: 'string' },
    strategy: { type: 'string', enum: ['auto', 'dom', 'ocr'] },
    exactMatch: { type: 'boolean' },
    region: {
      anyOf: [REGION_OUTPUT_SCHEMA, { type: 'null' }],
    },
  },
} as const;

const ACTION_ATTEMPT_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    selector: NULLABLE_STRING_SCHEMA,
    source: { type: ['string', 'null'], enum: ['selector', 'ref', null] },
    ref: NULLABLE_STRING_SCHEMA,
    selectorCandidates: {
      anyOf: [
        {
          type: 'array',
          items: { type: 'string' },
        },
        { type: 'null' },
      ],
    },
    href: NULLABLE_STRING_SCHEMA,
    text: { type: 'string' },
    strategy: { type: 'string' },
    key: { type: 'string' },
    modifiers: {
      type: 'array',
      items: { type: 'string' },
    },
    textLength: { type: 'number' },
    clear: { type: 'boolean' },
    submitRequested: { type: 'boolean' },
    clickTargetTag: NULLABLE_STRING_SCHEMA,
    anchorTag: NULLABLE_STRING_SCHEMA,
    dispatchAllowed: { type: ['boolean', 'null'] },
  },
} as const;

const ACTION_ATTEMPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'target', 'startedAt', 'verified'],
  properties: {
    method: { type: 'string' },
    target: ACTION_ATTEMPT_TARGET_SCHEMA,
    startedAt: { type: 'string' },
    verified: { type: 'boolean' },
    verificationMethod: NULLABLE_STRING_SCHEMA,
    waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
    failureReason: NULLABLE_STRING_SCHEMA,
  },
} as const;

const ACTION_EFFECT_SIGNAL_SCHEMA = {
  type: 'string',
  enum: ['waitFor', 'target-click-event', 'url-changed', 'dom-changed'],
} as const;

const ACTION_EFFECT_SIGNALS_SCHEMA = {
  type: 'array',
  items: ACTION_EFFECT_SIGNAL_SCHEMA,
} as const;

const ACTION_PRIMARY_EFFECT_SCHEMA = {
  type: 'string',
  enum: ['none', 'waitFor', 'target-click-event', 'url-changed', 'dom-changed'],
} as const;

const PAGE_FINGERPRINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'url',
    'title',
    'readyState',
    'bodyTextSample',
    'bodyTextLength',
    'activeTag',
    'activeType',
    'historyLength',
  ],
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    readyState: { type: 'string' },
    bodyTextSample: { type: 'string' },
    bodyTextLength: { type: 'number' },
    activeTag: { type: 'string' },
    activeType: { type: 'string' },
    historyLength: { type: 'number' },
  },
} as const;

const CLICK_PROBE_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['events', 'lastTrusted', 'lastTag'],
  properties: {
    events: { type: 'number' },
    lastTrusted: { type: 'boolean' },
    lastTag: { type: 'string' },
  },
} as const;

const TYPED_STATE_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['value', 'textContent', 'active'],
  properties: {
    value: NULLABLE_STRING_SCHEMA,
    textContent: { type: 'string' },
    active: { type: 'boolean' },
  },
} as const;

const INPUT_PROBE_EVENT_COUNTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keydown', 'keypress', 'beforeinput', 'input', 'change', 'keyup'],
  properties: {
    keydown: { type: 'number' },
    keypress: { type: 'number' },
    beforeinput: { type: 'number' },
    input: { type: 'number' },
    change: { type: 'number' },
    keyup: { type: 'number' },
  },
} as const;

const INPUT_PROBE_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['events', 'trustedEvents', 'lastInputType', 'lastData', 'lastKey', 'active'],
  properties: {
    events: INPUT_PROBE_EVENT_COUNTS_SCHEMA,
    trustedEvents: INPUT_PROBE_EVENT_COUNTS_SCHEMA,
    lastInputType: { type: 'string' },
    lastData: { type: 'string' },
    lastKey: { type: 'string' },
    active: { type: 'boolean' },
  },
} as const;

const SUBMIT_FALLBACK_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['submitted', 'method'],
  properties: {
    submitted: { type: 'boolean' },
    method: {
      type: 'string',
      enum: ['requestSubmit', 'submit', 'dispatch', 'none'],
    },
    formPresent: { type: 'boolean' },
    targetTag: NULLABLE_STRING_SCHEMA,
    formTag: NULLABLE_STRING_SCHEMA,
    dispatchResult: { type: ['boolean', 'null'] },
  },
} as const;

const ACTION_VERIFICATION_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clickEventMatched', 'pageChanged', 'beforeFingerprint', 'afterFingerprint'],
  properties: {
    clickEventMatched: { type: 'boolean' },
    clickProbe: CLICK_PROBE_SCHEMA,
    pageChanged: { type: 'boolean' },
    waitTimedOut: { type: 'boolean' },
    beforeFingerprint: PAGE_FINGERPRINT_SCHEMA,
    afterFingerprint: PAGE_FINGERPRINT_SCHEMA,
    typedState: TYPED_STATE_SCHEMA,
    inputProbe: INPUT_PROBE_SCHEMA,
    valueMatched: { type: 'boolean' },
    submitRequested: { type: 'boolean' },
    submitAttempted: { type: 'boolean' },
    submitMethod: {
      type: 'string',
      enum: ['none', 'native-enter', 'requestSubmit', 'submit', 'dispatch'],
    },
    submitFallbackUsed: { type: 'boolean' },
    submitEffectVerified: { type: 'boolean' },
    submitFallback: SUBMIT_FALLBACK_SCHEMA,
  },
} as const;

const NORMALIZED_BOUNDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
} as const;

const SCREENSHOT_CAPTURE_METHOD_SCHEMA = {
  type: 'string',
  enum: [
    'electron.capture_page',
    'electron.capture_page_rect',
    'electron.capture_page_crop',
    'bidi.viewport_screenshot',
    'bidi.full_page_screenshot',
    'cdp.viewport_screenshot',
    'cdp.full_page_screenshot',
    'stitched_viewport_capture',
  ],
} as const;

const DEBUG_SCREENSHOT_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'captureMode',
    'captureMethod',
    'fallbackUsed',
    'degraded',
    'degradationReason',
    'format',
    'mimeType',
  ],
  properties: {
    captureMode: { type: 'string', enum: ['viewport', 'full_page'] },
    captureMethod: SCREENSHOT_CAPTURE_METHOD_SCHEMA,
    fallbackUsed: { type: 'boolean' },
    degraded: { type: 'boolean' },
    degradationReason: NULLABLE_STRING_SCHEMA,
    format: { type: 'string', enum: ['png', 'jpeg'] },
    mimeType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
  },
} as const;

const BROWSER_OUTPUT_SCHEMAS: Partial<Record<BrowserToolName, Record<string, unknown>>> = {
  browser_get_url: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string' },
    },
  }),
  browser_snapshot: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'url',
      'title',
      'elementsFilter',
      'originalElementCount',
      'returnedElementCount',
      'interactionReady',
      'viewportHealth',
      'sessionVisibility',
      'hostWindowId',
      'offscreenDetected',
      'snapshot',
    ],
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      elementsFilter: { type: 'string', enum: ['all', 'interactive'] },
      originalElementCount: { type: 'number' },
      returnedElementCount: { type: 'number' },
      interactionReady: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.interactionReady,
      viewportHealth: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealth,
      viewportHealthReason: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealthReason,
      sessionVisibility: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.sessionVisibility,
      hostWindowId: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.hostWindowId,
      offscreenDetected: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.offscreenDetected,
      diagnostics: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.diagnostics,
      snapshot: PAGE_SNAPSHOT_SCHEMA,
    },
  }),
  browser_observe: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'currentUrl',
      'navigationPerformed',
      'waitApplied',
      'waitTarget',
      'url',
      'title',
      'elementsFilter',
      'originalElementCount',
      'returnedElementCount',
      'interactionReady',
      'viewportHealth',
      'sessionVisibility',
      'hostWindowId',
      'offscreenDetected',
      'snapshot',
    ],
    properties: {
      currentUrl: { type: 'string' },
      navigationPerformed: { type: 'boolean' },
      waitApplied: { type: 'boolean' },
      waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
      url: { type: 'string' },
      title: { type: 'string' },
      elementsFilter: { type: 'string', enum: ['all', 'interactive'] },
      originalElementCount: { type: 'number' },
      returnedElementCount: { type: 'number' },
      interactionReady: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.interactionReady,
      viewportHealth: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealth,
      viewportHealthReason: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealthReason,
      sessionVisibility: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.sessionVisibility,
      hostWindowId: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.hostWindowId,
      offscreenDetected: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.offscreenDetected,
      diagnostics: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.diagnostics,
      snapshot: PAGE_SNAPSHOT_SCHEMA,
    },
  }),
  browser_act: createStructuredEnvelopeSchema({
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'target',
          'resolvedTarget',
          'beforeUrl',
          'afterUrl',
          'navigationOccurred',
          'waitApplied',
          'waitTarget',
          'verified',
          'verificationMethod',
          'primaryEffect',
          'effectSignals',
          'delegatedTool',
          'submitRequested',
          'submitted',
          'clickMethod',
          'fallbackUsed',
        ],
        properties: {
          action: { type: 'string', enum: ['click'] },
          target: BROWSER_ACT_ELEMENT_TARGET_SCHEMA,
          resolvedTarget: RESOLVED_TARGET_SCHEMA,
          beforeUrl: { type: 'string' },
          afterUrl: { type: 'string' },
          navigationOccurred: { type: 'boolean' },
          waitApplied: { type: 'boolean' },
          waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
          verified: { type: 'boolean' },
          verificationMethod: NULLABLE_STRING_SCHEMA,
          primaryEffect: ACTION_PRIMARY_EFFECT_SCHEMA,
          effectSignals: ACTION_EFFECT_SIGNALS_SCHEMA,
          delegatedTool: { type: 'string', enum: ['browser_act.click'] },
          submitRequested: { type: 'boolean' },
          submitted: { type: 'boolean' },
          clickMethod: TEXT_CLICK_METHOD_OUTPUT_SCHEMA,
          fallbackUsed: { type: 'boolean' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'target',
          'resolvedTarget',
          'beforeUrl',
          'afterUrl',
          'navigationOccurred',
          'waitApplied',
          'waitTarget',
          'verified',
          'verificationMethod',
          'primaryEffect',
          'effectSignals',
          'delegatedTool',
          'submitRequested',
          'submitted',
          'matchSource',
          'clickMethod',
          'matchedTag',
          'clickTargetTag',
          'href',
          'fallbackUsed',
        ],
        properties: {
          action: { type: 'string', enum: ['click'] },
          target: BROWSER_ACT_TEXT_TARGET_SCHEMA,
          resolvedTarget: RESOLVED_TARGET_SCHEMA,
          beforeUrl: { type: 'string' },
          afterUrl: { type: 'string' },
          navigationOccurred: { type: 'boolean' },
          waitApplied: { type: 'boolean' },
          waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
          verified: { type: 'boolean' },
          verificationMethod: NULLABLE_STRING_SCHEMA,
          primaryEffect: ACTION_PRIMARY_EFFECT_SCHEMA,
          effectSignals: ACTION_EFFECT_SIGNALS_SCHEMA,
          delegatedTool: { type: 'string', enum: ['browser_act.click_text'] },
          submitRequested: { type: 'boolean' },
          submitted: { type: 'boolean' },
          matchSource: TEXT_MATCH_SOURCE_OUTPUT_SCHEMA,
          clickMethod: TEXT_CLICK_METHOD_OUTPUT_SCHEMA,
          matchedTag: NULLABLE_STRING_SCHEMA,
          clickTargetTag: NULLABLE_STRING_SCHEMA,
          href: NULLABLE_STRING_SCHEMA,
          fallbackUsed: { type: 'boolean' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'target',
          'resolvedTarget',
          'beforeUrl',
          'afterUrl',
          'navigationOccurred',
          'waitApplied',
          'waitTarget',
          'verified',
          'verificationMethod',
          'primaryEffect',
          'effectSignals',
          'delegatedTool',
          'submitRequested',
          'submitted',
          'submitAttempted',
          'submitMethod',
          'submitFallbackUsed',
          'submitEffectVerified',
          'textLength',
          'clear',
          'fallbackUsed',
        ],
        properties: {
          action: { type: 'string', enum: ['type'] },
          target: BROWSER_ACT_ELEMENT_TARGET_SCHEMA,
          resolvedTarget: RESOLVED_TARGET_SCHEMA,
          beforeUrl: { type: 'string' },
          afterUrl: { type: 'string' },
          navigationOccurred: { type: 'boolean' },
          waitApplied: { type: 'boolean' },
          waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
          verified: { type: 'boolean' },
          verificationMethod: NULLABLE_STRING_SCHEMA,
          primaryEffect: ACTION_PRIMARY_EFFECT_SCHEMA,
          effectSignals: ACTION_EFFECT_SIGNALS_SCHEMA,
          delegatedTool: { type: 'string', enum: ['browser_act.type'] },
          submitRequested: { type: 'boolean' },
          submitted: { type: 'boolean' },
          submitAttempted: { type: 'boolean' },
          submitMethod: {
            type: 'string',
            enum: ['none', 'native-enter', 'requestSubmit', 'submit', 'dispatch'],
          },
          submitFallbackUsed: { type: 'boolean' },
          submitEffectVerified: { type: 'boolean' },
          textLength: { type: 'number' },
          clear: { type: 'boolean' },
          fallbackUsed: { type: 'boolean' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'action',
          'target',
          'resolvedTarget',
          'beforeUrl',
          'afterUrl',
          'navigationOccurred',
          'waitApplied',
          'waitTarget',
          'verified',
          'verificationMethod',
          'primaryEffect',
          'effectSignals',
          'delegatedTool',
          'submitRequested',
          'submitted',
          'fallbackUsed',
        ],
        properties: {
          action: { type: 'string', enum: ['press'] },
          target: BROWSER_ACT_PRESS_TARGET_SCHEMA,
          resolvedTarget: RESOLVED_TARGET_SCHEMA,
          beforeUrl: { type: 'string' },
          afterUrl: { type: 'string' },
          navigationOccurred: { type: 'boolean' },
          waitApplied: { type: 'boolean' },
          waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
          verified: { type: 'boolean' },
          verificationMethod: NULLABLE_STRING_SCHEMA,
          primaryEffect: ACTION_PRIMARY_EFFECT_SCHEMA,
          effectSignals: ACTION_EFFECT_SIGNALS_SCHEMA,
          delegatedTool: { type: 'string', enum: ['browser_act.press'] },
          submitRequested: { type: 'boolean' },
          submitted: { type: 'boolean' },
          fallbackUsed: { type: 'boolean' },
        },
      },
    ],
  }),
  browser_wait_for: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['matched', 'condition', 'waitTarget'],
    properties: {
      matched: { type: 'boolean' },
      condition: { type: 'string' },
      waitTarget: ACTION_WAIT_TARGET_OUTPUT_SCHEMA,
      selector: NULLABLE_STRING_SCHEMA,
      source: { type: ['string', 'null'], enum: ['selector', 'ref', null] },
      ref: { type: ['string', 'null'] },
      url: { type: ['string', 'null'] },
    },
  }),
  browser_search: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'query', 'results'],
    properties: {
      total: { type: 'number' },
      query: { type: 'string' },
      results: createArrayItemsSchema(),
    },
  }),
  browser_network_entries: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'omittedCount', 'entries', 'filter'],
    properties: {
      total: { type: 'number' },
      omittedCount: { type: 'number' },
      entries: {
        ...createArrayItemsSchema(),
      },
      filter: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }),
  browser_network_summary: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['total', 'byType', 'byMethod', 'failed', 'slow', 'apiCalls'],
    properties: {
      total: { type: 'number' },
      byType: { type: 'object', additionalProperties: { type: 'number' } },
      byMethod: { type: 'object', additionalProperties: { type: 'number' } },
      failed: createArrayItemsSchema(),
      slow: createArrayItemsSchema(),
      apiCalls: createArrayItemsSchema(),
    },
  }),
  browser_screenshot: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'captureMode',
      'captureMethod',
      'fallbackUsed',
      'degraded',
      'interactionReady',
      'viewportHealth',
      'sessionVisibility',
      'hostWindowId',
      'offscreenDetected',
      'format',
      'mimeType',
    ],
    properties: {
      captureMode: { type: 'string', enum: ['viewport', 'full_page'] },
      captureMethod: {
        ...SCREENSHOT_CAPTURE_METHOD_SCHEMA,
      },
      fallbackUsed: { type: 'boolean' },
      degraded: { type: 'boolean' },
      degradationReason: { type: ['string', 'null'] },
      selector: { type: ['string', 'null'] },
      source: { type: ['string', 'null'] },
      ref: { type: ['string', 'null'] },
      format: { type: 'string', enum: ['png', 'jpeg'] },
      mimeType: { type: 'string', enum: ['image/png', 'image/jpeg'] },
      quality: { type: ['number', 'null'] },
      interactionReady: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.interactionReady,
      viewportHealth: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealth,
      viewportHealthReason: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealthReason,
      sessionVisibility: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.sessionVisibility,
      hostWindowId: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.hostWindowId,
      offscreenDetected: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.offscreenDetected,
      diagnostics: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.diagnostics,
    },
  }),
  browser_find_text: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['found', 'text', 'strategy', 'matchSource'],
    properties: {
      found: { type: 'boolean' },
      text: { type: 'string' },
      strategy: { type: 'string', enum: ['auto', 'dom', 'ocr'] },
      matchSource: TEXT_MATCH_SOURCE_OUTPUT_SCHEMA,
      normalizedBounds: NORMALIZED_BOUNDS_SCHEMA,
      centerX: { type: 'number' },
      centerY: { type: 'number' },
      safeCenterX: { type: 'number' },
      safeCenterY: { type: 'number' },
      inViewport: { type: 'boolean' },
      clippedToViewport: { type: 'boolean' },
      overflow: {
        type: 'object',
        additionalProperties: false,
        required: ['left', 'top', 'right', 'bottom'],
        properties: {
          left: { type: 'number' },
          top: { type: 'number' },
          right: { type: 'number' },
          bottom: { type: 'number' },
        },
      },
    },
  }),
  browser_console_get: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: ['stats', 'messages', 'filter'],
    properties: {
      stats: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'verbose', 'info', 'warning', 'error'],
        properties: {
          total: { type: 'number' },
          verbose: { type: 'number' },
          info: { type: 'number' },
          warning: { type: 'number' },
          error: { type: 'number' },
        },
      },
      messages: {
        type: 'array',
        items: CONSOLE_MESSAGE_SCHEMA,
      },
      filter: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'since', 'limit'],
        properties: {
          level: { type: 'string' },
          since: { type: ['number', 'null'] },
          limit: { type: 'number' },
        },
      },
    },
  }),
  browser_debug_state: createStructuredEnvelopeSchema({
    type: 'object',
    additionalProperties: false,
    required: [
      'snapshot',
      'interactionReady',
      'viewportHealth',
      'sessionVisibility',
      'hostWindowId',
      'offscreenDetected',
      'console',
      'network',
    ],
    properties: {
      interactionReady: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.interactionReady,
      viewportHealth: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealth,
      viewportHealthReason: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.viewportHealthReason,
      sessionVisibility: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.sessionVisibility,
      hostWindowId: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.hostWindowId,
      offscreenDetected: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.offscreenDetected,
      diagnostics: INTERACTION_HEALTH_OUTPUT_SCHEMA.properties.diagnostics,
      snapshot: PAGE_SNAPSHOT_SCHEMA,
      screenshot: DEBUG_SCREENSHOT_SCHEMA,
      console: {
        type: 'object',
        additionalProperties: false,
        required: ['enabled', 'count', 'preview'],
        properties: {
          enabled: { type: 'boolean' },
          count: { type: 'number' },
          preview: { type: 'array', items: CONSOLE_MESSAGE_SCHEMA },
        },
      },
      network: {
        type: 'object',
        additionalProperties: false,
        required: ['enabled', 'summary'],
        properties: {
          enabled: { type: 'boolean' },
          summary: {
            anyOf: [NETWORK_SUMMARY_SCHEMA, { type: 'null' }],
          },
        },
      },
    },
  }),
};

const BROWSER_DESTRUCTIVE_HINTS = new Set<BrowserToolName>([
  'browser_cookies_clear',
  'browser_console_clear',
]);

export function createBrowserCapabilityCatalog(): Record<string, RegisteredCapability> {
  return Object.fromEntries(
    Object.entries(PUBLIC_BROWSER_TOOL_MANIFEST).flatMap(([name, entry]) => {
      const toolName = name as PublicBrowserToolName;
      const handler = browserHandlers[toolName];
      if (!handler) {
        return [];
      }
      const tool = entry.tool;
      const metadata = entry.metadata;

      const definition: OrchestrationCapabilityDefinition = {
        name: tool.name,
        title: toCapabilityTitle(tool.name),
        version: BROWSER_CAPABILITY_VERSION,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: BROWSER_OUTPUT_SCHEMAS[toolName] || DEFAULT_BROWSER_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(metadata, {
          destructiveHint: BROWSER_DESTRUCTIVE_HINTS.has(toolName),
          openWorldHint: true,
        }),
        ...metadata,
      };

      const adaptedHandler: CapabilityHandler<OrchestrationDependencies> = async (args, deps) =>
        handler(args, deps as ToolHandlerDependencies);

      return [[name, { definition, handler: adaptedHandler }]];
    })
  );
}
