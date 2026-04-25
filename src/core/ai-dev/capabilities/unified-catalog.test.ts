import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../types/error-codes';
import type { OrchestrationCapabilityDefinition, OrchestrationDependencies } from '../orchestration/types';
import type { CapabilityHandler } from './types';
import {
  createUnifiedCapabilityCatalog,
  mergeCapabilityCatalogs,
  type CapabilityCatalog,
} from './unified-catalog';

function createCapability(
  name: string,
  version = '1.0.0',
  overrides: Partial<OrchestrationCapabilityDefinition> = {}
): { definition: OrchestrationCapabilityDefinition; handler: CapabilityHandler<OrchestrationDependencies> } {
  return {
    definition: {
      name,
      version,
      description: `${name} desc`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      idempotent: true,
      retryPolicy: { retryable: false, maxAttempts: 1 },
      requiredScopes: ['test.scope'],
      ...overrides,
    },
    handler: async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }),
  };
}

describe('unified capability catalog', () => {
  it('默认应包含 browser 域能力', () => {
    const catalog = createUnifiedCapabilityCatalog();
    expect(catalog.browser_observe).toBeDefined();
    expect(catalog.browser_debug_state).toBeDefined();
    expect(catalog.dataset_list).toBeDefined();
    expect(catalog.dataset_query).toBeDefined();
    expect(catalog.cross_plugin_list_apis).toBeDefined();
    expect(catalog.cross_plugin_call_api).toBeDefined();
    expect(catalog.system_get_health).toBeDefined();
    expect(catalog.system_bootstrap).toBeDefined();
    expect(catalog.plugin_list).toBeDefined();
    expect(catalog.plugin_get_runtime_status).toBeDefined();
    expect(catalog.plugin_install).toBeDefined();
    expect(catalog.plugin_reload).toBeDefined();
    expect(catalog.plugin_uninstall).toBeDefined();
    expect(catalog.dataset_import_file).toBeDefined();
    expect(catalog.dataset_create_empty).toBeDefined();
    expect(catalog.dataset_rename).toBeDefined();
    expect(catalog.dataset_delete).toBeDefined();
    expect(catalog.profile_list).toBeDefined();
    expect(catalog.profile_get).toBeDefined();
    expect(catalog.profile_resolve).toBeDefined();
    expect(catalog.profile_start_session).toBeDefined();
    expect(catalog.profile_create).toBeDefined();
    expect(catalog.profile_update).toBeDefined();
    expect(catalog.profile_delete).toBeDefined();
    expect(catalog.observation_get_trace_summary).toBeDefined();
    expect(catalog.observation_get_failure_bundle).toBeDefined();
    expect(catalog.observation_get_trace_timeline).toBeDefined();
    expect(catalog.observation_search_recent_failures).toBeDefined();
    expect(catalog.session_list).toBeDefined();
    expect(catalog.session_get_current).toBeDefined();
    expect(catalog.session_prepare).toBeDefined();
    expect(catalog.session_end_current).toBeDefined();
    expect(catalog.session_close).toBeDefined();
    expect(catalog.session_close_profile).toBeDefined();
  });

  it('merge 时 capability key 冲突应抛出 VALIDATION_ERROR', () => {
    const catalogA: CapabilityCatalog = {
      duplicate_key: createCapability('capability_one'),
    };
    const catalogB: CapabilityCatalog = {
      duplicate_key: createCapability('capability_two'),
    };

    try {
      mergeCapabilityCatalogs([catalogA, catalogB]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });

  it('merge 时 capability name 冲突应抛出 VALIDATION_ERROR', () => {
    const catalogA: CapabilityCatalog = {
      key_one: createCapability('same_capability_name'),
    };
    const catalogB: CapabilityCatalog = {
      key_two: createCapability('same_capability_name'),
    };

    try {
      mergeCapabilityCatalogs([catalogA, catalogB]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });

  it('merge 时缺失关键元数据应抛出 VALIDATION_ERROR', () => {
    const invalidCatalog: CapabilityCatalog = {
      broken_meta: createCapability('broken_capability', '1.0.0', {
        // Runtime validation should reject missing requiredScopes.
        requiredScopes: [],
      }),
    };

    try {
      mergeCapabilityCatalogs([invalidCatalog]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });

  it('merge 时非法 version 元数据应抛出 VALIDATION_ERROR', () => {
    const invalidCatalog: CapabilityCatalog = {
      broken_version: createCapability('broken_version_capability', '1'),
    };

    try {
      mergeCapabilityCatalogs([invalidCatalog]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });
  it('auto-populates assistant guidance for built-in capabilities', () => {
    const catalog = createUnifiedCapabilityCatalog();

    expect(catalog.browser_debug_state.definition.assistantGuidance).toMatchObject({
      workflowStage: 'observation',
      whenToUse: expect.stringContaining('Collect one compact debug bundle'),
      preferredNextTools: expect.arrayContaining(['browser_snapshot', 'browser_search']),
    });
    expect(catalog.browser_debug_state.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'canonical',
    });
    expect(catalog.browser_search.definition.assistantGuidance).toMatchObject({
      workflowStage: 'inspection',
      preferredNextTools: expect.arrayContaining(['browser_act', 'browser_snapshot']),
    });
    expect(catalog.browser_search.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'canonical',
    });
    expect(catalog.session_prepare.definition.assistantGuidance).toMatchObject({
      workflowStage: 'session',
      whenToUse: expect.stringContaining('Prepare the current MCP session'),
      preferredTargetKind: 'profile_query',
      recommendedToolProfile: 'compact',
    });
    expect(catalog.session_prepare.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'canonical',
      gettingStartedOrder: 30,
      sessionReuseOrder: 30,
    });
    expect(catalog.browser_act.definition.assistantGuidance).toMatchObject({
      workflowStage: 'interaction',
      examples: [
        expect.objectContaining({
          title: expect.any(String),
          arguments: expect.objectContaining({
            action: 'click',
          }),
        }),
      ],
    });
    expect(catalog.observation_get_trace_summary.definition.assistantGuidance).toMatchObject({
      workflowStage: 'observation',
      whenToUse: expect.stringContaining('final trace status'),
      preferredNextTools: ['observation_get_failure_bundle'],
    });
    expect(catalog.observation_get_trace_summary.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'canonical',
      pageDebugOrder: 5,
    });
    expect(catalog.system_bootstrap.definition.assistantGuidance).toMatchObject({
      workflowStage: 'observation',
      whenToUse: expect.stringContaining('first framework-level call'),
      preferredNextTools: expect.arrayContaining(['plugin_list', 'session_prepare']),
    });
    expect(catalog.system_bootstrap.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'canonical',
      gettingStartedOrder: 5,
    });
    expect(catalog.plugin_list.definition.assistantGuidance).toMatchObject({
      workflowStage: 'data',
      whenToUse: expect.stringContaining('which plugins are installed'),
      preferredNextTools: expect.arrayContaining(['plugin_get_runtime_status']),
    });
    expect(catalog.plugin_list.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'advanced',
    });
    expect(catalog.plugin_reload.definition.assistantGuidance).toMatchObject({
      workflowStage: 'teardown',
      whenToUse: expect.stringContaining('low-risk restart'),
      preferredNextTools: expect.arrayContaining(['plugin_get_runtime_status']),
    });
    expect(catalog.plugin_install.definition.assistantGuidance).toMatchObject({
      workflowStage: 'setup',
      whenToUse: expect.stringContaining('install or update a plugin'),
      preferredNextTools: expect.arrayContaining(['plugin_get_runtime_status']),
    });
    expect(catalog.plugin_uninstall.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'advanced',
    });
    expect(catalog.dataset_import_file.definition.assistantGuidance).toMatchObject({
      workflowStage: 'data',
      whenToUse: expect.stringContaining('import a local file'),
      preferredNextTools: expect.arrayContaining(['system_bootstrap']),
    });
    expect(catalog.dataset_create_empty.definition.assistantGuidance).toMatchObject({
      workflowStage: 'data',
      whenToUse: expect.stringContaining('new empty dataset shell'),
      preferredNextTools: expect.arrayContaining(['system_bootstrap']),
    });
    expect(catalog.dataset_delete.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'advanced',
    });
    expect(catalog.profile_update.definition.assistantGuidance).toMatchObject({
      workflowStage: 'setup',
      whenToUse: expect.stringContaining('mutate one profile'),
      preferredNextTools: expect.arrayContaining(['session_prepare']),
    });
    expect(catalog.profile_delete.definition.assistantSurface).toMatchObject({
      publicMcp: true,
      surfaceTier: 'advanced',
    });
  });

  it('preserves explicit assistant metadata when capability metadata already provides it', () => {
    const explicitCatalog: CapabilityCatalog = {
      explicit_guidance: createCapability('explicit_guidance_capability', '1.0.0', {
        assistantGuidance: {
          workflowStage: 'data',
          whenToUse: 'Use this only for explicit regression testing.',
          preferredNextTools: ['dataset_query'],
          examples: [{ title: 'Explicit example', arguments: { limit: 1 } }],
        },
        assistantSurface: {
          publicMcp: false,
          pageDebugOrder: 9,
        },
      }),
    };

    const merged = mergeCapabilityCatalogs([explicitCatalog]);
    expect(merged.explicit_guidance.definition.assistantGuidance).toEqual({
      workflowStage: 'data',
      whenToUse: 'Use this only for explicit regression testing.',
      preferredNextTools: ['dataset_query'],
      examples: [{ title: 'Explicit example', arguments: { limit: 1 } }],
    });
    expect(merged.explicit_guidance.definition.assistantSurface).toEqual({
      publicMcp: false,
      pageDebugOrder: 9,
    });
  });

  it('rejects invalid assistant guidance metadata', () => {
    const invalidCatalog: CapabilityCatalog = {
      broken_guidance: createCapability('broken_guidance_capability', '1.0.0', {
        assistantGuidance: {
          workflowStage: 'session',
          whenToUse: '',
          examples: [{ title: '', arguments: {} }],
        },
      }),
    };

    try {
      mergeCapabilityCatalogs([invalidCatalog]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });

  it('rejects invalid assistant surface metadata', () => {
    const invalidCatalog: CapabilityCatalog = {
      broken_surface: createCapability('broken_surface_capability', '1.0.0', {
        assistantSurface: {
          publicMcp: 'invalid' as unknown as boolean,
          gettingStartedOrder: 0,
        },
      }),
    };

    try {
      mergeCapabilityCatalogs([invalidCatalog]);
      throw new Error('Expected mergeCapabilityCatalogs to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
  });
});
