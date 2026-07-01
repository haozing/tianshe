import { createStructuredError, ErrorCode } from '../../../types/error-codes';
import type { BrowserInterface, BrowserRuntimeDescriptor } from '../../../types/browser-interface';
import { siteAdapterRegistry } from '../../../site-adapters';
import { booksToScrapeAdapter } from '../../../site-adapters/books-to-scrape/adapter';
import { createSaveSearchDraftProcedure } from '../../../site-adapters/books-to-scrape/procedures/save-search-draft';
import { githubProfileAdapter } from '../../../site-adapters/github-profile/adapter';
import { createGitHubCreateIssueProcedure } from '../../../site-adapters/github-profile/procedures/create-issue';
import { createGitHubPrepareIssueDraftProcedure } from '../../../site-adapters/github-profile/procedures/prepare-issue-draft';
import { openLibraryAdapter } from '../../../site-adapters/open-library/adapter';
import { createOpenLibrarySearchDraftProcedure } from '../../../site-adapters/open-library/procedures/prepare-search-draft';
import {
  evaluateSiteLoginHealth,
  SiteAdapterRunner,
  type SiteAdapterFixtureRunResult,
  type SiteAdapterModule,
} from '../../site-adapter-runtime';
import { createChildTraceContext } from '../../observability/observation-context';
import type {
  OrchestrationDatasetRecord,
  OrchestrationDatasetStagedWritePlan,
  OrchestrationDependencies,
} from '../orchestration/types';
import type { RegisteredCapability } from './browser-catalog';
import {
  buildCapabilityAnnotations,
  createBrowserCapabilityRequires,
  createStructuredEnvelopeSchema,
} from './catalog-utils';
import { createStructuredErrorResult, createStructuredResult } from './result-utils';
import type { CapabilityCatalog, CapabilityCatalogFactory } from './unified-catalog';
import type { CapabilityHandler, CapabilityHandlerExecutionContext } from './types';

const SITE_CAPABILITY_VERSION = '1.0.0';
const BOOKS_TO_SCRAPE_CAPABILITY = 'books_to_scrape.extract_product';
const BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY =
  'books_to_scrape.prepare_search_draft';
const OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY =
  'open_library.prepare_search_draft';
const GITHUB_PROFILE_CAPABILITY = 'github.extract_profile_summary';
const GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY = 'github.prepare_issue_draft';
const GITHUB_CREATE_ISSUE_CAPABILITY = 'github.create_issue';
const SITE_CAPABILITY_LIST = 'site_capability_list';
const BOOKS_TO_SCRAPE_HOST = 'books.toscrape.com';
const OPEN_LIBRARY_HOST = 'openlibrary.org';
const GITHUB_HOST = 'github.com';
const GITHUB_PROFILE_URL = 'https://github.com/settings/profile';
const CUSTOM_SITE_CAPABILITY_NAMES = new Set([
  BOOKS_TO_SCRAPE_CAPABILITY,
  BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
  OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
  GITHUB_PROFILE_CAPABILITY,
  GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
  GITHUB_CREATE_ISSUE_CAPABILITY,
]);

function listSiteAdapterModules(): SiteAdapterModule[] {
  return siteAdapterRegistry.listAdapters();
}

const SITE_READ_METADATA = {
  idempotent: true,
  sideEffectLevel: 'low' as const,
  estimatedLatencyMs: 5_000,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['browser.read', 'dataset.write'],
  requires: createBrowserCapabilityRequires(['snapshot.page']),
};

const LOGIN_READ_METADATA = {
  idempotent: true,
  sideEffectLevel: 'none' as const,
  estimatedLatencyMs: 5_000,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['browser.read', 'profile.read'],
  requires: createBrowserCapabilityRequires(['snapshot.page', 'profileLoginStateGateway']),
};

const SITE_DISCOVERY_METADATA = {
  idempotent: true,
  sideEffectLevel: 'none' as const,
  estimatedLatencyMs: 250,
  retryPolicy: { retryable: true, maxAttempts: 1 },
  requiredScopes: ['system.read'],
  requires: [],
};

const GENERIC_SITE_READ_METADATA = {
  idempotent: true,
  sideEffectLevel: 'low' as const,
  estimatedLatencyMs: 5_000,
  retryPolicy: { retryable: true, maxAttempts: 2 },
  requiredScopes: ['browser.read'],
  requires: createBrowserCapabilityRequires(['snapshot.page']),
};

const SITE_PROCEDURE_WRITE_METADATA = {
  idempotent: false,
  sideEffectLevel: 'low' as const,
  estimatedLatencyMs: 5_000,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['browser.write'],
  requires: createBrowserCapabilityRequires(['input.native', 'text.dom']),
};

const GITHUB_LOW_RISK_PROCEDURE_METADATA = {
  idempotent: false,
  sideEffectLevel: 'low' as const,
  estimatedLatencyMs: 10_000,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['browser.write', 'profile.read'],
  requires: createBrowserCapabilityRequires([
    'input.native',
    'text.dom',
    'profileLoginStateGateway',
  ]),
};

const GITHUB_HIGH_RISK_PROCEDURE_METADATA = {
  idempotent: false,
  sideEffectLevel: 'high' as const,
  estimatedLatencyMs: 10_000,
  retryPolicy: { retryable: false, maxAttempts: 1 },
  requiredScopes: ['browser.write', 'profile.read'],
  requires: createBrowserCapabilityRequires([
    'input.native',
    'text.dom',
    'profileLoginStateGateway',
  ]),
};

const EXPECT_PRESENT = { __siteAdapterExpectation: 'present' } as const;
const EXPECT_NON_EMPTY_STRING = {
  __siteAdapterExpectation: 'non-empty-string',
} as const;
const EXPECT_CONFIDENCE = {
  __siteAdapterExpectation: 'number-at-least',
  min: 0.75,
} as const;

const PRODUCT_RUNTIME_EXPECTED = {
  productName: EXPECT_NON_EMPTY_STRING,
  price: EXPECT_NON_EMPTY_STRING,
  availability: EXPECT_NON_EMPTY_STRING,
  rating: EXPECT_NON_EMPTY_STRING,
  sourceUrl: EXPECT_NON_EMPTY_STRING,
  confidence: EXPECT_CONFIDENCE,
  selectorHits: { __siteAdapterExpectation: 'non-empty-array' },
  pageFingerprint: EXPECT_PRESENT,
} as const;

const GITHUB_RUNTIME_EXPECTED = {
  displayName: EXPECT_NON_EMPTY_STRING,
  sourceUrl: EXPECT_NON_EMPTY_STRING,
  confidence: EXPECT_CONFIDENCE,
  selectorHits: { __siteAdapterExpectation: 'non-empty-array' },
  pageFingerprint: EXPECT_PRESENT,
} as const;

const SELECTOR_HIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['field', 'selector', 'count'],
  properties: {
    field: { type: 'string' },
    selector: { type: 'string' },
    count: { type: 'number' },
  },
};

const PAGE_FINGERPRINT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['url', 'title', 'elementCount'],
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    elementCount: { type: 'number' },
  },
};

const PRODUCT_FIELDS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'productName',
    'price',
    'availability',
    'rating',
    'upc',
    'productType',
    'sourceUrl',
    'pageTitle',
    'confidence',
    'selectorHits',
    'missingFields',
    'extractorVersion',
    'runner',
    'pageFingerprint',
    'warnings',
  ],
  properties: {
    productName: { type: 'string', minLength: 1 },
    price: { type: 'string', minLength: 1 },
    availability: { type: 'string', minLength: 1 },
    rating: { type: 'string', minLength: 1 },
    upc: { type: 'string' },
    productType: { type: 'string' },
    sourceUrl: { type: 'string', minLength: 1 },
    pageTitle: { type: 'string' },
    confidence: { type: 'number', minimum: 0.75 },
    selectorHits: { type: 'array', items: SELECTOR_HIT_SCHEMA },
    missingFields: { type: 'array', items: { type: 'string' } },
    extractorVersion: { type: 'string' },
    runner: { type: 'string' },
    pageFingerprint: PAGE_FINGERPRINT_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const GITHUB_PROFILE_FIELDS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'displayName',
    'bio',
    'company',
    'blog',
    'sourceUrl',
    'confidence',
    'missingFields',
    'selectorHits',
    'extractorVersion',
    'runner',
    'pageFingerprint',
    'warnings',
  ],
  properties: {
    displayName: { type: 'string', minLength: 1 },
    bio: { type: 'string' },
    company: { type: 'string' },
    blog: { type: 'string' },
    sourceUrl: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0.75 },
    missingFields: { type: 'array', items: { type: 'string' } },
    selectorHits: { type: 'array', items: SELECTOR_HIT_SCHEMA },
    extractorVersion: { type: 'string' },
    runner: { type: 'string' },
    pageFingerprint: PAGE_FINGERPRINT_SCHEMA,
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const PRODUCT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      description: 'Books to Scrape product page URL.',
    },
    datasetId: {
      type: 'string',
      minLength: 1,
      description: 'Optional dataset to receive the extracted product row.',
    },
    commitDatasetWrite: {
      type: 'boolean',
      description: 'Commit the staged dataset write immediately after explicit confirmation.',
    },
    profileId: {
      type: 'string',
      minLength: 1,
      description: 'Optional profile to bind through session_prepare before extraction.',
    },
    runtimeId: {
      type: 'string',
      minLength: 1,
      description: 'Optional runtime to request through session_prepare before extraction.',
    },
    visible: {
      type: 'boolean',
      description: 'Optional visible session request for session_prepare.',
    },
  },
};

const PRODUCT_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['site', 'capability', 'adapter', 'sourceUrl', 'fields', 'runner', 'datasetWrite'],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    sourceUrl: { type: 'string' },
    fields: PRODUCT_FIELDS_SCHEMA,
    runner: {
      type: 'object',
      additionalProperties: true,
    },
    datasetWrite: {
      type: 'object',
      additionalProperties: true,
    },
    runtimePlan: {
      type: 'object',
      additionalProperties: true,
    },
    sessionPrepare: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
    artifactRefs: {
      type: 'array',
      items: { type: 'string' },
    },
  },
});

const SEARCH_DRAFT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Search draft query to enter in the prepared Books to Scrape workflow.',
    },
    profileId: {
      type: 'string',
      minLength: 1,
      description: 'Optional profile to bind through session_prepare before the draft workflow.',
    },
    runtimeId: {
      type: 'string',
      minLength: 1,
      description: 'Optional runtime to request through session_prepare before the draft workflow.',
    },
    visible: {
      type: 'boolean',
      description: 'Optional visible session request for session_prepare.',
    },
  },
};

const OPEN_LIBRARY_SEARCH_DRAFT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Search draft query to enter in the prepared Open Library workflow.',
    },
    profileId: {
      type: 'string',
      minLength: 1,
      description: 'Optional profile to bind through session_prepare before the draft workflow.',
    },
    runtimeId: {
      type: 'string',
      minLength: 1,
      description: 'Optional runtime to request through session_prepare before the draft workflow.',
    },
    visible: {
      type: 'boolean',
      description: 'Optional visible session request for session_prepare.',
    },
  },
};

const SEARCH_DRAFT_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: [
    'site',
    'capability',
    'adapter',
    'query',
    'procedure',
    'runner',
    'runtimePlan',
    'sessionPrepare',
    'artifactRefs',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    query: { type: 'string' },
    procedure: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'sideEffectLevel'],
      properties: {
        id: { type: 'string' },
        sideEffectLevel: { type: 'string' },
      },
    },
    runner: { type: 'object', additionalProperties: true },
    runtimePlan: { type: 'object', additionalProperties: true },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    artifactRefs: { type: 'array', items: { type: 'string' } },
  },
});

const GITHUB_PROFILE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId'],
  properties: {
    profileId: { type: 'string', minLength: 1 },
    runtimeId: { type: 'string', minLength: 1 },
    visible: { type: 'boolean' },
  },
};

const GITHUB_PROFILE_HANDOFF_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: [
    'site',
    'capability',
    'profileId',
    'status',
    'verified',
    'manualHandoffRequired',
    'loginUrl',
    'evidence',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    profileId: { type: 'string' },
    status: { type: 'string' },
    verified: { type: 'boolean' },
    manualHandoffRequired: { type: 'boolean', enum: [true] },
    loginUrl: { type: 'string' },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    evidence: { type: 'object', additionalProperties: true },
  },
};

const GITHUB_PROFILE_EXTRACT_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'site',
    'capability',
    'adapter',
    'sourceUrl',
    'fields',
    'runner',
    'runtimePlan',
    'sessionPrepare',
    'loginState',
    'evidence',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    sourceUrl: { type: 'string' },
    fields: GITHUB_PROFILE_FIELDS_SCHEMA,
    runner: { type: 'object', additionalProperties: true },
    runtimePlan: { type: 'object', additionalProperties: true },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    loginState: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    evidence: { type: 'object', additionalProperties: true },
  },
};

const GITHUB_PROFILE_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  oneOf: [GITHUB_PROFILE_HANDOFF_DATA_SCHEMA, GITHUB_PROFILE_EXTRACT_DATA_SCHEMA],
});

const GITHUB_PREPARE_ISSUE_DRAFT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId', 'owner', 'repo', 'title', 'body'],
  properties: {
    profileId: { type: 'string', minLength: 1 },
    owner: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      description: 'GitHub repository owner or organization.',
    },
    repo: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      description: 'GitHub repository name.',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Issue draft title to enter without submitting.',
    },
    body: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description: 'Issue draft body to enter without submitting.',
    },
    runtimeId: { type: 'string', minLength: 1 },
    visible: { type: 'boolean' },
  },
};

const GITHUB_CREATE_ISSUE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId', 'owner', 'repo', 'title', 'body'],
  properties: {
    profileId: { type: 'string', minLength: 1 },
    owner: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      description: 'GitHub repository owner or organization.',
    },
    repo: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
      description: 'GitHub repository name.',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Issue title to submit.',
    },
    body: {
      type: 'string',
      minLength: 1,
      maxLength: 8000,
      description: 'Issue body to submit.',
    },
    runtimeId: { type: 'string', minLength: 1 },
    visible: { type: 'boolean' },
  },
};

const GITHUB_PREPARE_ISSUE_DRAFT_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'site',
    'capability',
    'adapter',
    'repository',
    'issue',
    'procedure',
    'runner',
    'runtimePlan',
    'sessionPrepare',
    'evidence',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'repo', 'url'],
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        url: { type: 'string' },
      },
    },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'bodyLength', 'preparedOnly'],
      properties: {
        title: { type: 'string' },
        bodyLength: { type: 'number' },
        preparedOnly: { type: 'boolean', enum: [true] },
      },
    },
    procedure: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'sideEffectLevel'],
      properties: {
        id: { type: 'string' },
        sideEffectLevel: { type: 'string' },
      },
    },
    runner: { type: 'object', additionalProperties: true },
    runtimePlan: { type: 'object', additionalProperties: true },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    evidence: { type: 'object', additionalProperties: true },
    artifactRefs: { type: 'array', items: { type: 'string' } },
  },
};

const GITHUB_CREATE_ISSUE_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'site',
    'capability',
    'adapter',
    'repository',
    'issue',
    'procedure',
    'runner',
    'runtimePlan',
    'sessionPrepare',
    'evidence',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['owner', 'repo', 'url'],
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        url: { type: 'string' },
      },
    },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'bodyLength'],
      properties: {
        title: { type: 'string' },
        bodyLength: { type: 'number' },
      },
    },
    procedure: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'sideEffectLevel'],
      properties: {
        id: { type: 'string' },
        sideEffectLevel: { type: 'string' },
      },
    },
    runner: { type: 'object', additionalProperties: true },
    runtimePlan: { type: 'object', additionalProperties: true },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    evidence: { type: 'object', additionalProperties: true },
    artifactRefs: { type: 'array', items: { type: 'string' } },
  },
};

const GITHUB_CREATE_ISSUE_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  oneOf: [GITHUB_PROFILE_HANDOFF_DATA_SCHEMA, GITHUB_CREATE_ISSUE_DATA_SCHEMA],
});

const GITHUB_PREPARE_ISSUE_DRAFT_OUTPUT_SCHEMA: Record<string, unknown> =
  createStructuredEnvelopeSchema({
    oneOf: [GITHUB_PROFILE_HANDOFF_DATA_SCHEMA, GITHUB_PREPARE_ISSUE_DRAFT_DATA_SCHEMA],
  });

const GENERIC_SITE_CAPABILITY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', minLength: 1 },
    profileId: {
      type: 'string',
      minLength: 1,
      description: 'Optional profile to bind through session_prepare before extraction.',
    },
    runtimeId: {
      type: 'string',
      minLength: 1,
      description: 'Optional runtime to request through session_prepare before extraction.',
    },
    visible: {
      type: 'boolean',
      description: 'Optional visible session request for session_prepare.',
    },
  },
};

const GENERIC_SITE_CAPABILITY_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: [
    'site',
    'capability',
    'adapter',
    'sourceUrl',
    'fields',
    'runner',
    'runtimePlan',
    'sessionPrepare',
    'artifactRefs',
  ],
  properties: {
    site: { type: 'string' },
    capability: { type: 'string' },
    adapter: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
      },
    },
    sourceUrl: { type: 'string' },
    fields: {
      type: 'object',
      additionalProperties: true,
      required: ['sourceUrl', 'confidence', 'selectorHits', 'pageFingerprint'],
      properties: {
        sourceUrl: { type: 'string', minLength: 1 },
        confidence: { type: 'number' },
        selectorHits: { type: 'array', items: SELECTOR_HIT_SCHEMA },
        pageFingerprint: PAGE_FINGERPRINT_SCHEMA,
      },
    },
    runner: { type: 'object', additionalProperties: true },
    runtimePlan: { type: 'object', additionalProperties: true },
    sessionPrepare: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    artifactRefs: { type: 'array', items: { type: 'string' } },
  },
});

const SITE_CAPABILITY_LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    siteId: { type: 'string', minLength: 1 },
    site: { type: 'string', minLength: 1 },
    action: { type: 'string', minLength: 1 },
  },
};

const SITE_CAPABILITY_LIST_OUTPUT_SCHEMA: Record<string, unknown> = createStructuredEnvelopeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['total', 'capabilities'],
  properties: {
    total: { type: 'number' },
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['name', 'siteId', 'site', 'action', 'adapter'],
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          siteId: { type: 'string' },
          site: { type: 'string' },
          action: { type: 'string' },
          adapter: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'version'],
            properties: {
              id: { type: 'string' },
              version: { type: 'string' },
            },
          },
          sideEffectLevel: { type: 'string' },
          riskLevel: { type: 'string' },
          requiresLogin: { type: 'boolean' },
          requiredScopes: { type: 'array', items: { type: 'string' } },
          supportedRunners: { type: 'array', items: { type: 'string' } },
          outputFields: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
});

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw createStructuredError(ErrorCode.PARAMETER_TYPE_MISMATCH, `Parameter ${key} must be a string`, {
      context: { parameter: key },
    });
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw createStructuredError(ErrorCode.PARAMETER_TYPE_MISMATCH, `Parameter ${key} must be a boolean`, {
      context: { parameter: key },
    });
  }
  return value;
}

function readGitHubPathArg(args: Record<string, unknown>, key: 'owner' | 'repo'): string {
  const value = readStringArg(args, key);
  if (!value) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, `Parameter ${key} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `Parameter ${key} must be a GitHub path segment`,
      {
        context: {
          parameter: key,
          value,
        },
      }
    );
  }
  return value;
}

function actionFromCapabilityName(name: string): string {
  return name.includes('.') ? name.split('.').slice(1).join('.') : name;
}

function createSiteCapabilityDiscoveryRecords(): Array<Record<string, unknown>> {
  const catalog = {
    ...createBooksToScrapeCapabilityCatalog(),
    ...createOpenLibraryCapabilityCatalog(),
    ...createGitHubCapabilityCatalog(),
    ...createGenericOfficialSiteCapabilityCatalog(),
  };
  const adapters = listSiteAdapterModules();

  return adapters.flatMap((adapter) =>
    (adapter.manifest.capabilities || []).map((capabilityName) => {
      const definition = catalog[capabilityName]?.definition;
      return {
        name: capabilityName,
        title: definition?.title || capabilityName,
        description: definition?.description || '',
        siteId: adapter.manifest.siteId || adapter.manifest.id,
        site: adapter.manifest.site,
        action: actionFromCapabilityName(capabilityName),
        adapter: {
          id: adapter.manifest.id,
          version: adapter.manifest.version,
        },
        sideEffectLevel: definition?.sideEffectLevel || adapter.manifest.sideEffectLevel,
        riskLevel:
          definition?.sideEffectLevel === 'high'
            ? 'high'
            : definition
              ? 'low'
              : adapter.manifest.riskLevel || 'low',
        requiresLogin: definition?.assistantGuidance?.requiresBoundProfile === true,
        requiredScopes: definition?.requiredScopes || adapter.manifest.requiredScopes || [],
        supportedRunners: adapter.manifest.supportedRunners || [],
        outputFields: adapter.manifest.extractors.flatMap((extractor) => extractor.outputFields),
        preferredNextTools: definition?.assistantGuidance?.preferredNextTools || [],
      };
    })
  );
}

const siteCapabilityListHandler: CapabilityHandler<OrchestrationDependencies> = async (args) => {
  const siteId = readStringArg(args, 'siteId')?.toLowerCase();
  const site = readStringArg(args, 'site')?.toLowerCase();
  const action = readStringArg(args, 'action')?.toLowerCase();
  const capabilities = createSiteCapabilityDiscoveryRecords().filter((capability) => {
    const capabilitySiteId = String(capability.siteId || '').toLowerCase();
    const capabilitySite = String(capability.site || '').toLowerCase();
    const capabilityAction = String(capability.action || '').toLowerCase();
    return (
      (!siteId || capabilitySiteId === siteId) &&
      (!site || capabilitySite.includes(site)) &&
      (!action || capabilityAction.includes(action))
    );
  });

  return createStructuredResult(
    {
      summary: `Found ${capabilities.length} site business capability(s).`,
      data: {
        total: capabilities.length,
        capabilities,
      },
      nextActionHints: [
        'Prefer a listed <site>.<action> capability before using generic browser tools.',
        'Use browser_observe/browser_act only when no mature site capability matches the task.',
      ],
      recommendedNextTools: capabilities.map((capability) => String(capability.name)),
      authoritativeFields: [
        'structuredContent.data.capabilities[].name',
        'structuredContent.data.capabilities[].adapter.version',
        'structuredContent.data.capabilities[].requiresLogin',
      ],
    },
    { includeJsonInText: true }
  );
};

function assertBooksToScrapeUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, 'url must be a valid URL', {
      context: { url: rawUrl },
    });
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== BOOKS_TO_SCRAPE_HOST) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `url must be an https://${BOOKS_TO_SCRAPE_HOST} product page`,
      {
        context: { url: rawUrl, expectedHost: BOOKS_TO_SCRAPE_HOST },
      }
    );
  }

  return parsed;
}

async function resolveBrowserReady(
  deps: OrchestrationDependencies,
  capabilityName = BOOKS_TO_SCRAPE_CAPABILITY
): Promise<BrowserInterface> {
  const browser = deps.browser || (deps.browserFactory ? await deps.browserFactory({}) : undefined);
  const missing = ['goto', 'snapshot'].filter(
    (method) =>
      !browser ||
      typeof (browser as unknown as Record<string, unknown>)[method] !== 'function'
  );
  if (missing.length > 0 || !browser) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'A prepared browser session is required before running a site capability',
      {
        suggestion: 'Call runtime_plan and session_prepare, then retry the site capability.',
        recommendedNextTools: ['runtime_plan', 'session_prepare'],
        context: {
          capability: capabilityName,
          missingBrowserMethods: missing,
        },
      }
    );
  }
  return browser;
}

async function resolveProcedureBrowserReady(
  deps: OrchestrationDependencies,
  capabilityName: string
): Promise<BrowserInterface> {
  const browser = deps.browser || (deps.browserFactory ? await deps.browserFactory({}) : undefined);
  const missing = ['type', 'click', 'getText', 'textExists'].filter(
    (method) =>
      !browser ||
      typeof (browser as unknown as Record<string, unknown>)[method] !== 'function'
  );
  if (missing.length > 0 || !browser) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'A prepared browser session with element interaction support is required before running a site Procedure capability',
      {
        suggestion: 'Call runtime_plan and session_prepare, then retry the site Procedure capability.',
        recommendedNextTools: ['runtime_plan', 'session_prepare'],
        context: {
          capability: capabilityName,
          missingBrowserMethods: missing,
        },
      }
    );
  }
  return browser;
}

function describeRuntime(browser: BrowserInterface): BrowserRuntimeDescriptor | null {
  try {
    return typeof browser.describeRuntime === 'function' ? browser.describeRuntime() : null;
  } catch {
    return null;
  }
}

function createRuntimePlan(
  browser: BrowserInterface,
  capabilityName = BOOKS_TO_SCRAPE_CAPABILITY
): Record<string, unknown> {
  const runtimeDescriptor = describeRuntime(browser);
  return {
    status: 'ready',
    capability: capabilityName,
    requiredCapabilities: ['navigation', 'snapshot.page'],
    nextAction: null,
    runtimeId: runtimeDescriptor?.runtimeId ?? null,
    runtimeDescriptor,
  };
}

function createProcedureRuntimePlan(
  browser: BrowserInterface,
  capabilityName: string
): Record<string, unknown> {
  const runtimeDescriptor = describeRuntime(browser);
  return {
    status: 'ready',
    capability: capabilityName,
    requiredCapabilities: ['input.native', 'text.dom'],
    nextAction: null,
    runtimeId: runtimeDescriptor?.runtimeId ?? null,
    runtimeDescriptor,
  };
}

async function prepareSessionIfRequested(
  args: Record<string, unknown>,
  deps: OrchestrationDependencies
): Promise<Record<string, unknown> | null> {
  const profileId = readStringArg(args, 'profileId');
  const runtimeId = readStringArg(args, 'runtimeId');
  const visible = readBooleanArg(args, 'visible');

  if (!profileId && !runtimeId && visible === undefined) {
    return null;
  }
  if (!deps.mcpSessionGateway?.prepareCurrentSession) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'session_prepare gateway is not available for this invocation',
      {
        suggestion: 'Prepare the MCP session before calling the site capability.',
        recommendedNextTools: ['session_prepare'],
      }
    );
  }

  return deps.mcpSessionGateway.prepareCurrentSession({
    ...(profileId ? { profileId } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(visible !== undefined ? { visible } : {}),
    scopes: ['browser.read', 'dataset.write'],
  }) as unknown as Promise<Record<string, unknown>>;
}

async function prepareGenericReadOnlySessionIfRequested(
  args: Record<string, unknown>,
  deps: OrchestrationDependencies,
  adapter: SiteAdapterModule,
  scopes: string[] = adapter.manifest.requiredScopes || ['browser.read']
): Promise<Record<string, unknown> | null> {
  const profileId = readStringArg(args, 'profileId');
  const runtimeId = readStringArg(args, 'runtimeId');
  const visible = readBooleanArg(args, 'visible');

  if (!profileId && !runtimeId && visible === undefined) {
    return null;
  }
  if (!deps.mcpSessionGateway?.prepareCurrentSession) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'session_prepare gateway is not available for this invocation',
      {
        suggestion: 'Prepare the MCP session before calling the site capability.',
        recommendedNextTools: ['session_prepare'],
      }
    );
  }

  return deps.mcpSessionGateway.prepareCurrentSession({
    ...(profileId ? { profileId } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(visible !== undefined ? { visible } : {}),
    scopes,
  }) as unknown as Promise<Record<string, unknown>>;
}

function assertOfficialAdapterUrl(adapter: SiteAdapterModule, capabilityName: string, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createStructuredError(ErrorCode.INVALID_PARAMETER, 'url must be a valid URL', {
      context: { url: rawUrl, capability: capabilityName },
    });
  }

  const expectedHost = adapter.manifest.site.toLowerCase();
  const actualHost = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    (actualHost !== expectedHost && !actualHost.endsWith(`.${expectedHost}`))
  ) {
    throw createStructuredError(
      ErrorCode.INVALID_PARAMETER,
      `url must be an https://${adapter.manifest.site} page`,
      {
        context: {
          url: rawUrl,
          capability: capabilityName,
          expectedHost: adapter.manifest.site,
        },
      }
    );
  }

  return parsed;
}

function titleFromSiteCapabilityName(name: string): string {
  return name
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function createGenericRuntimeExpected(adapter: SiteAdapterModule): Record<string, unknown> {
  const skipFields = new Set([
    'extractorVersion',
    'infoboxTitle',
    'language',
    'missingFields',
    'nextPageUrl',
    'pageTitle',
    'pagination',
    'runner',
    'warnings',
  ]);
  const expected: Record<string, unknown> = {};

  for (const field of adapter.manifest.extractors.flatMap((extractor) => extractor.outputFields)) {
    if (skipFields.has(field)) {
      continue;
    }
    if (field === 'confidence') {
      expected[field] = EXPECT_CONFIDENCE;
    } else if (field === 'selectorHits' || /s$/.test(field)) {
      expected[field] = { __siteAdapterExpectation: 'non-empty-array' };
    } else if (/Count$/.test(field)) {
      expected[field] = { __siteAdapterExpectation: 'number-at-least', min: 1 };
    } else if (field === 'pageFingerprint') {
      expected[field] = EXPECT_PRESENT;
    } else {
      expected[field] = EXPECT_NON_EMPTY_STRING;
    }
  }

  return {
    sourceUrl: EXPECT_NON_EMPTY_STRING,
    confidence: EXPECT_CONFIDENCE,
    selectorHits: { __siteAdapterExpectation: 'non-empty-array' },
    pageFingerprint: EXPECT_PRESENT,
    ...expected,
  };
}

function createGenericSiteCapabilityHandler(
  adapter: SiteAdapterModule,
  capabilityName: string
): CapabilityHandler<OrchestrationDependencies> {
  return async (args, deps, context) => {
    const rawUrl = readStringArg(args, 'url');
    if (!rawUrl) {
      throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter url is required');
    }
    const url = assertOfficialAdapterUrl(adapter, capabilityName, rawUrl);
    const sessionPrepare = await prepareGenericReadOnlySessionIfRequested(args, deps, adapter);
    const browser = await resolveBrowserReady(deps, capabilityName);
    const runtimePlan = createRuntimePlan(browser, capabilityName);

    await browser.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const run = await SiteAdapterRunner.run({
      runner: 'browser-snapshot',
      adapter,
      browser,
      fixtureName: `runtime-${adapter.manifest.fixtures?.[0] || 'snapshot'}`,
      expected: createGenericRuntimeExpected(adapter),
      input: { runner: 'browser-snapshot' },
      snapshotOptions: { elementsFilter: 'all' },
      options: {
        context: createChildTraceContext({
          traceId: context.traceId,
          capability: capabilityName,
          source: 'mcp',
          attributes: {
            site: adapter.manifest.site,
            url: url.toString(),
          },
        }),
        component: 'site-capability',
        workspaceRoot: process.cwd(),
        signal: context.signal,
      },
    });

    if (!run.ok) {
      return createStructuredErrorResult(
        createStructuredError(
          ErrorCode.OPERATION_FAILED,
          `${adapter.manifest.name} extraction failed verification`,
          {
            suggestion: 'Inspect the failure bundle and site_adapter_repair_bundle before retrying.',
            recommendedNextTools: ['observation_get_failure_bundle', 'observation_get_trace_summary'],
            context: {
              capability: capabilityName,
              adapterId: adapter.manifest.id,
              adapterVersion: adapter.manifest.version,
              artifactRefs: run.artifactRefs,
            },
          }
        )
      );
    }

    return createStructuredResult(
      {
        summary: `Extracted ${adapter.manifest.name} data from ${url.hostname}.`,
        data: {
          site: adapter.manifest.site,
          capability: capabilityName,
          adapter: {
            id: adapter.manifest.id,
            version: adapter.manifest.version,
          },
          sourceUrl: String(run.result.sourceUrl || url.toString()),
          fields: run.result,
          runner: {
            fixtureName: run.fixtureName,
            ok: run.ok,
            diagnostics: run.diagnostics,
            verifierResults: run.verifierResults,
            artifactRefs: run.artifactRefs,
          },
          runtimePlan,
          sessionPrepare,
          artifactRefs: run.artifactRefs,
        },
        nextActionHints: ['Use observation_get_trace_summary with the traceId to review run evidence.'],
        recommendedNextTools: ['observation_get_trace_summary'],
        authoritativeFields: [
          'structuredContent.data.fields',
          'structuredContent.data.adapter.version',
          'structuredContent.data.runner.artifactRefs',
        ],
      },
      { includeJsonInText: true }
    );
  };
}

function extractDatasetRecord(result: Record<string, unknown>): OrchestrationDatasetRecord {
  return {
    site: BOOKS_TO_SCRAPE_HOST,
    productName: typeof result.productName === 'string' ? result.productName : null,
    price: typeof result.price === 'string' ? result.price : null,
    availability: typeof result.availability === 'string' ? result.availability : null,
    rating: typeof result.rating === 'string' ? result.rating : null,
    upc: typeof result.upc === 'string' ? result.upc : null,
    productType: typeof result.productType === 'string' ? result.productType : null,
    sourceUrl: typeof result.sourceUrl === 'string' ? result.sourceUrl : null,
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    capturedAt: new Date().toISOString(),
  };
}

async function writeDatasetIfRequested(
  args: Record<string, unknown>,
  deps: OrchestrationDependencies,
  run: SiteAdapterFixtureRunResult,
  context: CapabilityHandlerExecutionContext,
  runtimePlan: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const datasetId = readStringArg(args, 'datasetId');
  if (!datasetId) {
    return { status: 'not_requested' };
  }
  if (!deps.datasetGateway?.stageWritePlan) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Dataset gateway does not support staged write plans',
      {
        recommendedNextTools: ['dataset_stage_write_plan'],
      }
    );
  }

  const provenance = {
    traceId: context.traceId ?? null,
    adapterId: booksToScrapeAdapter.manifest.id,
    adapterVersion: booksToScrapeAdapter.manifest.version,
    runtimeId:
      typeof runtimePlan.runtimeId === 'string' ? runtimePlan.runtimeId : null,
    sourceUrl: typeof run.result.sourceUrl === 'string' ? run.result.sourceUrl : null,
    metadata: {
      capability: BOOKS_TO_SCRAPE_CAPABILITY,
      site: BOOKS_TO_SCRAPE_HOST,
      fixtureName: run.fixtureName,
    },
  };
  const plan = await deps.datasetGateway.stageWritePlan(
    datasetId,
    [{ type: 'insert', record: extractDatasetRecord(run.result) }],
    provenance
  );

  const commitDatasetWrite = readBooleanArg(args, 'commitDatasetWrite') === true;
  if (!commitDatasetWrite) {
    return {
      status: 'staged',
      planId: plan.planId,
      datasetId: plan.datasetId,
      rowCount: plan.rowCount,
      requiresConfirmation: true,
      plan,
    };
  }
  if (!deps.datasetGateway.commitWritePlan) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'Dataset gateway does not support staged write commits',
      {
        recommendedNextTools: ['dataset_commit_write_plan'],
      }
    );
  }

  const commit = await deps.datasetGateway.commitWritePlan(
    plan as OrchestrationDatasetStagedWritePlan,
    {
      ...provenance,
      confirmRisk: true,
    }
  );
  return {
    status: 'committed',
    plan,
    commit,
  };
}

const booksToScrapeExtractProductHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  const rawUrl = readStringArg(args, 'url');
  if (!rawUrl) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter url is required');
  }
  const url = assertBooksToScrapeUrl(rawUrl);
  const sessionPrepare = await prepareSessionIfRequested(args, deps);
  const browser = await resolveBrowserReady(deps, BOOKS_TO_SCRAPE_CAPABILITY);
  const runtimePlan = createRuntimePlan(browser, BOOKS_TO_SCRAPE_CAPABILITY);

  await browser.goto(url.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  const run = await SiteAdapterRunner.run({
    runner: 'browser-snapshot',
    adapter: booksToScrapeAdapter,
    browser,
    fixtureName: 'runtime-product-page',
    expected: PRODUCT_RUNTIME_EXPECTED,
    input: { runner: 'browser-snapshot' },
    snapshotOptions: { elementsFilter: 'all' },
    options: {
      context: createChildTraceContext({
        traceId: context.traceId,
        capability: BOOKS_TO_SCRAPE_CAPABILITY,
        source: 'mcp',
        attributes: {
          site: BOOKS_TO_SCRAPE_HOST,
          url: url.toString(),
        },
      }),
      component: 'site-capability',
      workspaceRoot: process.cwd(),
      signal: context.signal,
    },
  });

  if (!run.ok) {
    const failedFields = run.verifierResults.flatMap((verification) =>
      (verification.diagnostics || [])
        .filter((diagnostic) => !diagnostic.ok)
        .map((diagnostic) => diagnostic.path)
    );
    return createStructuredErrorResult(
      createStructuredError(
        ErrorCode.OPERATION_FAILED,
        'Books to Scrape product extraction failed verification',
        {
          suggestion: 'Inspect the failure bundle and site_adapter_repair_bundle before retrying.',
          recommendedNextTools: [
            'observation_get_failure_bundle',
            'observation_get_trace_summary',
          ],
          context: {
            capability: BOOKS_TO_SCRAPE_CAPABILITY,
            adapterId: booksToScrapeAdapter.manifest.id,
            adapterVersion: booksToScrapeAdapter.manifest.version,
            sourceUrl: url.toString(),
            failedFields,
            artifactRefs: run.artifactRefs,
          },
        }
      )
    );
  }

  const datasetWrite = await writeDatasetIfRequested(args, deps, run, context, runtimePlan);

  return createStructuredResult(
    {
      summary: `Extracted product "${String(run.result.productName || '')}" from Books to Scrape.`,
      data: {
        site: BOOKS_TO_SCRAPE_HOST,
        capability: BOOKS_TO_SCRAPE_CAPABILITY,
        adapter: {
          id: booksToScrapeAdapter.manifest.id,
          version: booksToScrapeAdapter.manifest.version,
        },
        sourceUrl: String(run.result.sourceUrl || url.toString()),
        fields: run.result,
        runner: {
          fixtureName: run.fixtureName,
          ok: run.ok,
          diagnostics: run.diagnostics,
          verifierResults: run.verifierResults,
          artifactRefs: run.artifactRefs,
        },
        datasetWrite,
        runtimePlan,
        sessionPrepare,
        artifactRefs: run.artifactRefs,
      },
      nextActionHints: [
        'Use dataset_get_record_provenance after committing to inspect row provenance.',
        'Use observation_get_trace_summary with the traceId to review the run evidence.',
      ],
      recommendedNextTools: [
        'dataset_get_record_provenance',
        'observation_get_trace_summary',
      ],
      authoritativeFields: [
        'structuredContent.data.fields',
        'structuredContent.data.adapter.version',
        'structuredContent.data.datasetWrite',
        'structuredContent.data.runner.artifactRefs',
      ],
    },
    { includeJsonInText: true }
  );
};

interface SearchDraftProcedureCapabilityOptions {
  capabilityName: string;
  siteHost: string;
  adapter: SiteAdapterModule;
  createProcedure: (query: string) => ReturnType<typeof createSaveSearchDraftProcedure>;
  failureMessage: string;
  summaryPrefix: string;
}

async function runSearchDraftProcedureCapability(
  args: Record<string, unknown>,
  deps: OrchestrationDependencies,
  context: CapabilityHandlerExecutionContext,
  options: SearchDraftProcedureCapabilityOptions
) {
  const query = readStringArg(args, 'query');
  if (!query) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter query is required');
  }
  const sessionPrepare = await prepareGenericReadOnlySessionIfRequested(
    args,
    deps,
    options.adapter,
    SITE_PROCEDURE_WRITE_METADATA.requiredScopes
  );
  const browser = await resolveProcedureBrowserReady(deps, options.capabilityName);
  const runtimePlan = createProcedureRuntimePlan(browser, options.capabilityName);
  const procedure = options.createProcedure(query);
  const adapterWithProcedure: SiteAdapterModule = {
    ...options.adapter,
    procedures: [
      procedure,
      ...(options.adapter.procedures || []).filter((item) => item.id !== procedure.id),
    ],
  };
  const run = await SiteAdapterRunner.run({
    runner: 'procedure',
    adapter: adapterWithProcedure,
    procedureId: procedure.id,
    browser,
    options: {
      signal: context.signal,
    },
  });

  if (!run.ok) {
    return createStructuredErrorResult(
      createStructuredError(
        ErrorCode.OPERATION_FAILED,
        options.failureMessage,
        {
          suggestion: 'Inspect the procedure action trace and failure bundle before retrying.',
          recommendedNextTools: [
            'observation_get_failure_bundle',
            'observation_get_trace_summary',
          ],
          context: {
            capability: options.capabilityName,
            adapterId: options.adapter.manifest.id,
            adapterVersion: options.adapter.manifest.version,
            procedureId: procedure.id,
            artifactRefs: run.artifactRefs,
          },
        }
      )
    );
  }

  return createStructuredResult(
    {
      summary: `${options.summaryPrefix} for "${query}".`,
      data: {
        site: options.siteHost,
        capability: options.capabilityName,
        adapter: {
          id: options.adapter.manifest.id,
          version: options.adapter.manifest.version,
        },
        query,
        procedure: {
          id: procedure.id,
          sideEffectLevel: procedure.sideEffectLevel,
        },
        runner: {
          runner: run.runner,
          runId: run.runState.runId,
          status: run.runState.status,
          actionTrace: run.actionTrace,
          transitions: run.transitions,
          artifactRefs: run.artifactRefs,
        },
        runtimePlan,
        sessionPrepare,
        artifactRefs: run.artifactRefs,
      },
      nextActionHints: [
        'Use observation_get_trace_summary with the traceId to review the Procedure run evidence.',
      ],
      recommendedNextTools: ['observation_get_trace_summary'],
      authoritativeFields: [
        'structuredContent.data.runner.status',
        'structuredContent.data.runner.actionTrace',
        'structuredContent.data.procedure.id',
      ],
    },
    { includeJsonInText: true }
  );
}

const booksToScrapePrepareSearchDraftHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  return runSearchDraftProcedureCapability(args, deps, context, {
    capabilityName: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
    siteHost: BOOKS_TO_SCRAPE_HOST,
    adapter: booksToScrapeAdapter,
    createProcedure: createSaveSearchDraftProcedure,
    failureMessage: 'Books to Scrape search draft Procedure failed verification',
    summaryPrefix: 'Prepared Books to Scrape search draft',
  });
};

const openLibraryPrepareSearchDraftHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  return runSearchDraftProcedureCapability(args, deps, context, {
    capabilityName: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
    siteHost: OPEN_LIBRARY_HOST,
    adapter: openLibraryAdapter,
    createProcedure: createOpenLibrarySearchDraftProcedure,
    failureMessage: 'Open Library search draft Procedure failed verification',
    summaryPrefix: 'Prepared Open Library search draft',
  });
};

async function ensureGitHubLoginOrHandoff(
  args: Record<string, unknown>,
  deps: OrchestrationDependencies,
  options: {
    capabilityName?: string;
    handoffPurpose?: string;
    sessionScopes?: string[];
  } = {}
): Promise<{
  ready: true;
  profileId: string;
  runtimeId?: string;
  sessionPrepare: Record<string, unknown> | null;
} | {
  ready: false;
  result: ReturnType<typeof createStructuredResult>;
}> {
  const capabilityName = options.capabilityName || GITHUB_PROFILE_CAPABILITY;
  const handoffPurpose = options.handoffPurpose || 'profile extraction';
  const profileId = readStringArg(args, 'profileId');
  if (!profileId) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter profileId is required');
  }
  if (!deps.profileLoginStateGateway) {
    throw createStructuredError(
      ErrorCode.OPERATION_FAILED,
      'profile login state gateway is required for logged-in site capabilities',
      {
        recommendedNextTools: ['profile_ensure_logged_in'],
      }
    );
  }

  const loginState = await deps.profileLoginStateGateway.getLoginState({
    profileId,
    site: GITHUB_HOST,
  });
  const runtimeId = readStringArg(args, 'runtimeId') || loginState?.runtimeId || undefined;
  const loginHealth = evaluateSiteLoginHealth({
    profileId,
    site: GITHUB_HOST,
    state: loginState,
    requiredRuntimeId: runtimeId,
  });
  if (!loginHealth.ok) {
    const sessionPrepare = deps.mcpSessionGateway?.prepareCurrentSession
      ? await deps.mcpSessionGateway.prepareCurrentSession({
          profileId,
          ...(runtimeId ? { runtimeId } : {}),
          visible: true,
          ...(options.sessionScopes ? { scopes: options.sessionScopes } : {}),
        })
      : null;
    const nextStatus =
      loginState?.status ||
      (loginHealth.status === 'captcha' ||
      loginHealth.status === 'two_factor' ||
      loginHealth.status === 'blocked' ||
      loginHealth.status === 'expired' ||
      loginHealth.status === 'unknown'
        ? loginHealth.status
        : 'needs_manual_login');
    const nextLoginState = await deps.profileLoginStateGateway.upsertLoginState({
      profileId,
      site: GITHUB_HOST,
      loginUrl: 'https://github.com/login',
      ...(runtimeId ? { runtimeId: runtimeId as never } : {}),
      status: nextStatus,
      verified: false,
      verifiedBy: 'capability',
      evidence: {
        manualHandoffRequired: true,
        loginHealth,
        ...loginHealth.safeEvidence,
      },
      reason: loginHealth.reasonCode,
    });

    return {
      ready: false,
      result: createStructuredResult(
        {
          summary: `GitHub login requires visible human handoff before ${handoffPurpose}.`,
          data: {
            site: GITHUB_HOST,
            capability: capabilityName,
            profileId,
            status: nextLoginState.status,
            verified: false,
            manualHandoffRequired: true,
            loginUrl: 'https://github.com/login',
            sessionPrepare,
            loginHealth,
            evidence: {
              ...loginHealth.safeEvidence,
            },
          },
          nextActionHints: [
            'Use profile_ensure_logged_in for visible handoff and retry after the login state is verified.',
          ],
          recommendedNextTools: ['profile_ensure_logged_in', 'session_prepare'],
          authoritativeFields: [
            'structuredContent.data.status',
            'structuredContent.data.manualHandoffRequired',
          ],
        },
        { includeJsonInText: true }
      ),
    };
  }

  const requestedVisible = readBooleanArg(args, 'visible');
  const sessionPrepare = deps.mcpSessionGateway?.prepareCurrentSession
    ? await deps.mcpSessionGateway.prepareCurrentSession({
        profileId,
        ...(runtimeId ? { runtimeId } : {}),
        visible: requestedVisible ?? false,
        ...(options.sessionScopes ? { scopes: options.sessionScopes } : {}),
      })
    : null;
  return {
    ready: true,
    profileId,
    ...(runtimeId ? { runtimeId } : {}),
    sessionPrepare: sessionPrepare as unknown as Record<string, unknown> | null,
  };
}

async function updateGitHubVerifiedLoginState(
  deps: OrchestrationDependencies,
  input: {
    profileId: string;
    runtimeId?: string;
    run: SiteAdapterFixtureRunResult;
  }
): Promise<Record<string, unknown> | null> {
  if (!deps.profileLoginStateGateway?.upsertLoginState) {
    return null;
  }

  const loginState = await deps.profileLoginStateGateway.upsertLoginState({
    profileId: input.profileId,
    site: GITHUB_HOST,
    loginUrl: 'https://github.com/login',
    ...(input.runtimeId ? { runtimeId: input.runtimeId as never } : {}),
    status: 'logged_in',
    verified: true,
    verifiedBy: 'trusted_site_adapter_verifier',
    verifiedAt: new Date(),
    evidence: {
      verifier: 'github-profile-settings',
      displayNamePresent: Boolean(input.run.result.displayName),
      artifactRefs: input.run.artifactRefs,
      credentialValuesReturned: false,
      cookieValuesReturned: false,
      tokenValuesReturned: false,
    },
    reason: 'profile_settings_extracted',
  });

  return loginState as unknown as Record<string, unknown>;
}

const githubExtractProfileSummaryHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  const login = await ensureGitHubLoginOrHandoff(args, deps);
  if (login.ready === false) {
    return login.result;
  }

  const browser = await resolveBrowserReady(deps, GITHUB_PROFILE_CAPABILITY);
  const runtimePlan = createRuntimePlan(browser, GITHUB_PROFILE_CAPABILITY);
  await browser.goto(GITHUB_PROFILE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  const run = await SiteAdapterRunner.run({
    runner: 'browser-snapshot',
    adapter: githubProfileAdapter,
    browser,
    fixtureName: 'runtime-profile-settings',
    expected: GITHUB_RUNTIME_EXPECTED,
    input: { runner: 'browser-snapshot' },
    snapshotOptions: { elementsFilter: 'all' },
    options: {
      context: createChildTraceContext({
        traceId: context.traceId,
        capability: GITHUB_PROFILE_CAPABILITY,
        source: 'mcp',
        attributes: {
          site: GITHUB_HOST,
          url: GITHUB_PROFILE_URL,
        },
      }),
      component: 'site-capability',
      workspaceRoot: process.cwd(),
      signal: context.signal,
    },
  });

  if (!run.ok) {
    return createStructuredErrorResult(
      createStructuredError(ErrorCode.OPERATION_FAILED, 'GitHub profile extraction failed verification', {
        suggestion: 'Inspect the failure bundle and site_adapter_repair_bundle before retrying.',
        recommendedNextTools: ['observation_get_failure_bundle'],
        context: {
          capability: GITHUB_PROFILE_CAPABILITY,
          adapterId: githubProfileAdapter.manifest.id,
          adapterVersion: githubProfileAdapter.manifest.version,
          artifactRefs: run.artifactRefs,
        },
      })
    );
  }

  const loginState = await updateGitHubVerifiedLoginState(deps, {
    profileId: login.profileId,
    runtimeId: login.runtimeId,
    run,
  });

  return createStructuredResult(
    {
      summary: `Extracted GitHub profile summary for "${String(run.result.displayName || '')}".`,
      data: {
        site: GITHUB_HOST,
        capability: GITHUB_PROFILE_CAPABILITY,
        adapter: {
          id: githubProfileAdapter.manifest.id,
          version: githubProfileAdapter.manifest.version,
        },
        sourceUrl: String(run.result.sourceUrl || GITHUB_PROFILE_URL),
        fields: run.result,
        runner: {
          fixtureName: run.fixtureName,
          ok: run.ok,
          diagnostics: run.diagnostics,
          verifierResults: run.verifierResults,
          artifactRefs: run.artifactRefs,
        },
        runtimePlan,
        sessionPrepare: login.sessionPrepare,
        loginState,
        evidence: {
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
      },
      nextActionHints: ['Use observation_get_trace_summary to review run evidence.'],
      recommendedNextTools: ['observation_get_trace_summary'],
      authoritativeFields: [
        'structuredContent.data.fields',
        'structuredContent.data.evidence',
      ],
    },
    { includeJsonInText: true }
  );
};

const githubPrepareIssueDraftHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  const owner = readGitHubPathArg(args, 'owner');
  const repo = readGitHubPathArg(args, 'repo');
  const title = readStringArg(args, 'title');
  const body = readStringArg(args, 'body');
  if (!title) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter title is required');
  }
  if (!body) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter body is required');
  }

  const login = await ensureGitHubLoginOrHandoff(args, deps, {
    capabilityName: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
    handoffPurpose: 'GitHub issue draft preparation',
    sessionScopes: GITHUB_LOW_RISK_PROCEDURE_METADATA.requiredScopes,
  });
  if (login.ready === false) {
    return login.result;
  }

  const browser = await resolveProcedureBrowserReady(
    deps,
    GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY
  );
  const runtimePlan = createProcedureRuntimePlan(
    browser,
    GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY
  );
  const procedure = createGitHubPrepareIssueDraftProcedure({ owner, repo, title, body });
  const adapterWithProcedure: SiteAdapterModule = {
    ...githubProfileAdapter,
    procedures: [
      procedure,
      ...(githubProfileAdapter.procedures || []).filter((item) => item.id !== procedure.id),
    ],
  };
  const run = await SiteAdapterRunner.run({
    runner: 'procedure',
    adapter: adapterWithProcedure,
    procedureId: procedure.id,
    browser,
    options: {
      signal: context.signal,
    },
  });

  return createStructuredResult(
    {
      summary: `Prepared GitHub issue draft "${title}" in ${owner}/${repo} without submitting.`,
      data: {
        site: GITHUB_HOST,
        capability: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
        adapter: {
          id: githubProfileAdapter.manifest.id,
          version: githubProfileAdapter.manifest.version,
        },
        repository: {
          owner,
          repo,
          url: `https://github.com/${owner}/${repo}`,
        },
        issue: {
          title,
          bodyLength: body.length,
          preparedOnly: true,
        },
        procedure: {
          id: procedure.id,
          sideEffectLevel: procedure.sideEffectLevel,
        },
        runner: {
          runner: run.runner,
          runId: run.runState.runId,
          status: run.runState.status,
          actionTrace: run.actionTrace,
          transitions: run.transitions,
          artifactRefs: run.artifactRefs,
        },
        runtimePlan,
        sessionPrepare: login.sessionPrepare,
        evidence: {
          submitted: false,
          destructiveConfirmation: false,
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
        artifactRefs: run.artifactRefs,
      },
      nextActionHints: [
        'Review the visible issue draft before submitting it with an explicitly confirmed high-risk capability.',
        'Use observation_get_trace_summary with the traceId to review the low-risk Procedure run evidence.',
      ],
      recommendedNextTools: ['observation_get_trace_summary', GITHUB_CREATE_ISSUE_CAPABILITY],
      authoritativeFields: [
        'structuredContent.data.runner.status',
        'structuredContent.data.procedure.sideEffectLevel',
        'structuredContent.data.issue.preparedOnly',
        'structuredContent.data.evidence.submitted',
      ],
    },
    { includeJsonInText: true }
  );
};

const githubCreateIssueHandler: CapabilityHandler<OrchestrationDependencies> = async (
  args,
  deps,
  context
) => {
  const owner = readGitHubPathArg(args, 'owner');
  const repo = readGitHubPathArg(args, 'repo');
  const title = readStringArg(args, 'title');
  const body = readStringArg(args, 'body');
  if (!title) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter title is required');
  }
  if (!body) {
    throw createStructuredError(ErrorCode.MISSING_PARAMETER, 'Parameter body is required');
  }
  const login = await ensureGitHubLoginOrHandoff(args, deps, {
    capabilityName: GITHUB_CREATE_ISSUE_CAPABILITY,
    handoffPurpose: 'GitHub issue creation',
    sessionScopes: GITHUB_HIGH_RISK_PROCEDURE_METADATA.requiredScopes,
  });
  if (login.ready === false) {
    return login.result;
  }

  const browser = await resolveProcedureBrowserReady(deps, GITHUB_CREATE_ISSUE_CAPABILITY);
  const runtimePlan = createProcedureRuntimePlan(browser, GITHUB_CREATE_ISSUE_CAPABILITY);
  const procedure = createGitHubCreateIssueProcedure({ owner, repo, title, body });
  const adapterWithProcedure: SiteAdapterModule = {
    ...githubProfileAdapter,
    procedures: [
      procedure,
      ...(githubProfileAdapter.procedures || []).filter((item) => item.id !== procedure.id),
    ],
  };
  const run = await SiteAdapterRunner.run({
    runner: 'procedure',
    adapter: adapterWithProcedure,
    procedureId: procedure.id,
    browser,
    options: {
      confirmationGranted: true,
      signal: context.signal,
    },
  });

  return createStructuredResult(
    {
      summary: `Created GitHub issue "${title}" in ${owner}/${repo}.`,
      data: {
        site: GITHUB_HOST,
        capability: GITHUB_CREATE_ISSUE_CAPABILITY,
        adapter: {
          id: githubProfileAdapter.manifest.id,
          version: githubProfileAdapter.manifest.version,
        },
        repository: {
          owner,
          repo,
          url: `https://github.com/${owner}/${repo}`,
        },
        issue: {
          title,
          bodyLength: body.length,
        },
        procedure: {
          id: procedure.id,
          sideEffectLevel: procedure.sideEffectLevel,
        },
        runner: {
          runner: run.runner,
          runId: run.runState.runId,
          status: run.runState.status,
          actionTrace: run.actionTrace,
          transitions: run.transitions,
          artifactRefs: run.artifactRefs,
        },
        runtimePlan,
        sessionPrepare: login.sessionPrepare,
        evidence: {
          destructiveConfirmation: true,
          credentialValuesReturned: false,
          cookieValuesReturned: false,
          tokenValuesReturned: false,
        },
        artifactRefs: run.artifactRefs,
      },
      nextActionHints: [
        'Use observation_get_trace_summary with the traceId to review the high-risk Procedure run evidence.',
      ],
      recommendedNextTools: ['observation_get_trace_summary'],
      authoritativeFields: [
        'structuredContent.data.runner.status',
        'structuredContent.data.procedure.sideEffectLevel',
        'structuredContent.data.evidence.destructiveConfirmation',
      ],
    },
    { includeJsonInText: true }
  );
};

function createBooksToScrapeCapabilityCatalog(): CapabilityCatalog {
  return {
    [BOOKS_TO_SCRAPE_CAPABILITY]: {
      definition: {
        name: BOOKS_TO_SCRAPE_CAPABILITY,
        title: 'Books to Scrape Extract Product',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Extract product details from a Books to Scrape product page using the official Books to Scrape site adapter.',
        inputSchema: PRODUCT_INPUT_SCHEMA,
        outputSchema: PRODUCT_OUTPUT_SCHEMA,
        confirmationPolicy: {
          requiredWhen: [
            {
              argument: 'commitDatasetWrite',
              equals: true,
              reason: 'commits a staged dataset write during extraction',
            },
          ],
        },
        annotations: buildCapabilityAnnotations(SITE_READ_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'data',
          whenToUse:
            'Use this for Books to Scrape product pages instead of browser scripting or selectors.',
          avoidWhen:
            'Do not use for other book stores, search pages, login flows, or pages outside books.toscrape.com.',
          preferredTargetKind: 'site_product',
          requiresBoundProfile: false,
          transportEffect: 'browser-navigation',
          recommendedToolProfile: 'compact',
          preferredNextTools: [
            'dataset_get_record_provenance',
            'observation_get_trace_summary',
          ],
          examples: [
            {
              title: 'Extract one public product page',
              arguments: {
                url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
              },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 60,
        },
        ...SITE_READ_METADATA,
      },
      handler: booksToScrapeExtractProductHandler,
    },
    [BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY]: {
      definition: {
        name: BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
        title: 'Books to Scrape Prepare Search Draft',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Prepare a low-risk Books to Scrape search draft through the official Books to Scrape Procedure runner.',
        inputSchema: SEARCH_DRAFT_INPUT_SCHEMA,
        outputSchema: SEARCH_DRAFT_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(SITE_PROCEDURE_WRITE_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'interaction',
          whenToUse:
            'Use this for the supported Books to Scrape low-risk search draft workflow instead of generic browser typing/clicking.',
          avoidWhen:
            'Do not use for checkout, account changes, login flows, or pages outside the declared Books to Scrape Procedure.',
          preferredTargetKind: 'site_low_risk_procedure',
          requiresBoundProfile: false,
          transportEffect: 'browser-interaction',
          recommendedToolProfile: 'compact',
          preferredNextTools: ['observation_get_trace_summary'],
          examples: [
            {
              title: 'Prepare a search draft',
              arguments: {
                query: 'poetry',
              },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 65,
        },
        ...SITE_PROCEDURE_WRITE_METADATA,
      },
      handler: booksToScrapePrepareSearchDraftHandler,
    },
  };
}

function createOpenLibraryCapabilityCatalog(): CapabilityCatalog {
  return {
    [OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY]: {
      definition: {
        name: OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
        title: 'Open Library Prepare Search Draft',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Prepare a low-risk Open Library search draft through the official Open Library Procedure runner.',
        inputSchema: OPEN_LIBRARY_SEARCH_DRAFT_INPUT_SCHEMA,
        outputSchema: SEARCH_DRAFT_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(SITE_PROCEDURE_WRITE_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'interaction',
          whenToUse:
            'Use this for the supported Open Library low-risk search draft workflow instead of generic browser typing/clicking.',
          avoidWhen:
            'Do not use for account changes, login flows, checkout flows, or pages outside the declared Open Library Procedure.',
          preferredTargetKind: 'site_low_risk_procedure',
          requiresBoundProfile: false,
          transportEffect: 'browser-interaction',
          recommendedToolProfile: 'compact',
          preferredNextTools: ['observation_get_trace_summary'],
          examples: [
            {
              title: 'Prepare an Open Library search draft',
              arguments: {
                query: 'database systems',
              },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 66,
        },
        ...SITE_PROCEDURE_WRITE_METADATA,
      },
      handler: openLibraryPrepareSearchDraftHandler,
    },
  };
}

function createGitHubCapabilityCatalog(): CapabilityCatalog {
  return {
    [GITHUB_PROFILE_CAPABILITY]: {
      definition: {
        name: GITHUB_PROFILE_CAPABILITY,
        title: 'GitHub Extract Profile Summary',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Extract public profile fields from the logged-in GitHub profile settings page after profile login state is verified.',
        inputSchema: GITHUB_PROFILE_INPUT_SCHEMA,
        outputSchema: GITHUB_PROFILE_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(LOGIN_READ_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'data',
          whenToUse:
            'Use this when a GitHub profile has verified login state and public profile fields need to be read.',
          avoidWhen:
            'Do not use to enter credentials, bypass CAPTCHA/2FA, or read private secrets/tokens.',
          preferredTargetKind: 'logged_in_site_profile',
          requiresBoundProfile: true,
          transportEffect: 'browser-navigation',
          recommendedToolProfile: 'compact',
          preferredNextTools: ['profile_ensure_logged_in', 'observation_get_trace_summary'],
          examples: [
            {
              title: 'Extract profile summary after login handoff',
              arguments: { profileId: 'profile-id' },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 70,
        },
        ...LOGIN_READ_METADATA,
      },
      handler: githubExtractProfileSummaryHandler,
    },
    [GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY]: {
      definition: {
        name: GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
        title: 'GitHub Prepare Issue Draft',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Prepare a GitHub issue draft in a selected repository through the official GitHub low-risk Procedure after verified login, without submitting it.',
        inputSchema: GITHUB_PREPARE_ISSUE_DRAFT_INPUT_SCHEMA,
        outputSchema: GITHUB_PREPARE_ISSUE_DRAFT_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(GITHUB_LOW_RISK_PROCEDURE_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'interaction',
          whenToUse:
            'Use this when the user wants a GitHub issue drafted in a repository but has not asked to submit it yet.',
          avoidWhen:
            'Do not use to submit the issue, edit repositories, manage pull requests, change settings, enter credentials, or bypass CAPTCHA/2FA.',
          preferredTargetKind: 'logged_in_site_low_risk_procedure',
          requiresBoundProfile: true,
          transportEffect: 'browser-interaction',
          recommendedToolProfile: 'compact',
          preferredNextTools: [
            'profile_ensure_logged_in',
            'observation_get_trace_summary',
            GITHUB_CREATE_ISSUE_CAPABILITY,
          ],
          examples: [
            {
              title: 'Prepare an issue draft',
              arguments: {
                profileId: 'profile-id',
                owner: 'owner',
                repo: 'repo',
                title: 'Bug: unexpected state',
                body: 'Draft steps to reproduce...',
              },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 71,
        },
        ...GITHUB_LOW_RISK_PROCEDURE_METADATA,
      },
      handler: githubPrepareIssueDraftHandler,
    },
    [GITHUB_CREATE_ISSUE_CAPABILITY]: {
      definition: {
        name: GITHUB_CREATE_ISSUE_CAPABILITY,
        title: 'GitHub Create Issue',
        version: SITE_CAPABILITY_VERSION,
        description:
          'Create a GitHub issue in a selected repository through the official GitHub high-risk Procedure after verified login and explicit confirmation.',
        inputSchema: GITHUB_CREATE_ISSUE_INPUT_SCHEMA,
        outputSchema: GITHUB_CREATE_ISSUE_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(GITHUB_HIGH_RISK_PROCEDURE_METADATA, {
          destructiveHint: true,
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'interaction',
          whenToUse:
            'Use this only when the user explicitly asks to create a GitHub issue in a specific repository and confirms the high-risk write.',
          avoidWhen:
            'Do not use to edit repositories, close issues, manage pull requests, change settings, enter credentials, or bypass CAPTCHA/2FA.',
          preferredTargetKind: 'logged_in_site_high_risk_procedure',
          requiresBoundProfile: true,
          transportEffect: 'browser-interaction',
          recommendedToolProfile: 'compact',
          preferredNextTools: ['profile_ensure_logged_in', 'observation_get_trace_summary'],
          examples: [
            {
              title: 'Create a confirmed issue',
              arguments: {
                profileId: 'profile-id',
                owner: 'owner',
                repo: 'repo',
                title: 'Bug: unexpected state',
                body: 'Steps to reproduce...',
              },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 72,
        },
        ...GITHUB_HIGH_RISK_PROCEDURE_METADATA,
      },
      handler: githubCreateIssueHandler,
    },
  };
}

function createGenericOfficialSiteCapabilityCatalog(): CapabilityCatalog {
  return Object.assign(
    {},
    ...listSiteAdapterModules().flatMap((adapter) =>
      (adapter.manifest.capabilities || [])
        .filter((capabilityName) => !CUSTOM_SITE_CAPABILITY_NAMES.has(capabilityName))
        .map((capabilityName) => {
          const metadata = {
            ...GENERIC_SITE_READ_METADATA,
            requiredScopes: adapter.manifest.requiredScopes || GENERIC_SITE_READ_METADATA.requiredScopes,
          };
          return {
            [capabilityName]: {
              definition: {
                name: capabilityName,
                title: titleFromSiteCapabilityName(capabilityName),
                version: SITE_CAPABILITY_VERSION,
                description: `Extract structured data from ${adapter.manifest.name} using the official ${adapter.manifest.name} site adapter.`,
                inputSchema: GENERIC_SITE_CAPABILITY_INPUT_SCHEMA,
                outputSchema: GENERIC_SITE_CAPABILITY_OUTPUT_SCHEMA,
                annotations: buildCapabilityAnnotations(metadata, {
                  openWorldHint: false,
                }),
                assistantGuidance: {
                  workflowStage: 'data',
                  whenToUse: `Use this for ${adapter.manifest.site} pages before falling back to generic browser tools.`,
                  avoidWhen: `Do not use for pages outside ${adapter.manifest.site} or for write/login flows not declared by the adapter.`,
                  preferredTargetKind: 'site_read_model',
                  requiresBoundProfile: false,
                  transportEffect: 'browser-navigation',
                  recommendedToolProfile: 'compact',
                  preferredNextTools: ['observation_get_trace_summary'],
                  examples: [
                    {
                      title: `Extract ${adapter.manifest.name} data`,
                      arguments: {
                        url: `https://${adapter.manifest.site}/`,
                      },
                    },
                  ],
                },
                assistantSurface: {
                  publicMcp: true,
                  surfaceTier: 'canonical',
                  gettingStartedOrder: 80,
                },
                ...metadata,
              },
              handler: createGenericSiteCapabilityHandler(adapter, capabilityName),
            },
          };
        })
    )
  );
}

function getOfficialSiteCapabilityNames(): string[] {
  return listSiteAdapterModules().flatMap((adapter) => adapter.manifest.capabilities || []);
}

function createSiteCapabilityDiscoveryCatalog(): CapabilityCatalog {
  return {
    [SITE_CAPABILITY_LIST]: {
      definition: {
        name: SITE_CAPABILITY_LIST,
        title: 'Site Capability List',
        version: SITE_CAPABILITY_VERSION,
        description:
          'List official business site capabilities so agents can choose <site>.<action> before generic browser fallback.',
        inputSchema: SITE_CAPABILITY_LIST_INPUT_SCHEMA,
        outputSchema: SITE_CAPABILITY_LIST_OUTPUT_SCHEMA,
        annotations: buildCapabilityAnnotations(SITE_DISCOVERY_METADATA, {
          openWorldHint: false,
        }),
        assistantGuidance: {
          workflowStage: 'data',
          whenToUse:
            'Use this before browser scripting when the user asks for site extraction or site-specific automation.',
          avoidWhen:
            'Do not use this to inspect arbitrary page selectors, debug Lab artifacts, or apply repairs.',
          preferredTargetKind: 'site_capability_catalog',
          requiresBoundProfile: false,
          transportEffect: 'none',
          recommendedToolProfile: 'compact',
          preferredNextTools: [...getOfficialSiteCapabilityNames(), 'browser_observe'],
          examples: [
            {
              title: 'Find product extraction capabilities',
              arguments: { action: 'extract_product' },
            },
          ],
        },
        assistantSurface: {
          publicMcp: true,
          surfaceTier: 'canonical',
          gettingStartedOrder: 55,
        },
        ...SITE_DISCOVERY_METADATA,
      },
      handler: siteCapabilityListHandler,
    },
  };
}

const SITE_CAPABILITY_CATALOG_FACTORIES: readonly CapabilityCatalogFactory[] = [
  createSiteCapabilityDiscoveryCatalog,
  createBooksToScrapeCapabilityCatalog,
  createOpenLibraryCapabilityCatalog,
  createGitHubCapabilityCatalog,
  createGenericOfficialSiteCapabilityCatalog,
];

export function createSiteCapabilityCatalog(
  factories: readonly CapabilityCatalogFactory[] = SITE_CAPABILITY_CATALOG_FACTORIES
): Record<string, RegisteredCapability> {
  return Object.assign({}, ...factories.map((factory) => factory()));
}

export {
  BOOKS_TO_SCRAPE_CAPABILITY,
  BOOKS_TO_SCRAPE_PREPARE_SEARCH_DRAFT_CAPABILITY,
  OPEN_LIBRARY_PREPARE_SEARCH_DRAFT_CAPABILITY,
  GITHUB_PROFILE_CAPABILITY,
  GITHUB_PREPARE_ISSUE_DRAFT_CAPABILITY,
  GITHUB_CREATE_ISSUE_CAPABILITY,
  SITE_CAPABILITY_LIST,
};
