import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  listCanonicalPublicCapabilities,
  listCanonicalPublicCapabilityNames,
  listOrchestrationCapabilities,
} from '../orchestration';

const OPENAPI_PATH = 'src/main/schemas/orchestration-openapi-v1.json';

describe('MCP/OpenAPI/assistant schema parity', () => {
  it('keeps public MCP tools aligned with the assistant surface manifest', () => {
    const capabilities = listOrchestrationCapabilities();
    const publicByCapability = capabilities
      .filter((capability) => capability.assistantSurface?.publicMcp === true)
      .map((capability) => capability.name)
      .sort();
    const publicByAssistantManifest = listCanonicalPublicCapabilityNames(capabilities).sort();

    expect(publicByAssistantManifest).toEqual(publicByCapability);
    expect(listCanonicalPublicCapabilities(capabilities).map((capability) => capability.name).sort()).toEqual(
      publicByCapability
    );
  });

  it('requires every public capability to expose input/output schemas and assistant metadata', () => {
    for (const capability of listCanonicalPublicCapabilities()) {
      expect(capability.inputSchema, `${capability.name} inputSchema`).toBeDefined();
      expect(capability.outputSchema, `${capability.name} outputSchema`).toBeDefined();
      expect(capability.assistantGuidance, `${capability.name} assistantGuidance`).toBeDefined();
      expect(capability.assistantSurface?.surfaceTier, `${capability.name} surfaceTier`).toMatch(
        /^(canonical|advanced)$/
      );
      expect(capability.requiredScopes?.length, `${capability.name} requiredScopes`).toBeGreaterThan(0);
      expect(capability.outputSchema).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({
          ok: expect.any(Object),
          data: expect.any(Object),
        }),
      });
    }
  });

  it('keeps the OpenAPI invoke/list envelope compatible with capability schemas', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, any>;
      components: { schemas: Record<string, any> };
    };

    expect(doc.paths['/api/v1/orchestration/capabilities']?.get?.responses?.['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/SuccessResponse' },
        },
      },
    });
    expect(doc.paths['/api/v1/orchestration/invoke']?.post?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/InvokeRequest' },
        },
      },
    });
    expect(doc.components.schemas.InvokeRequest).toMatchObject({
      required: expect.arrayContaining(['sessionId', 'name']),
      properties: expect.objectContaining({
        name: { type: 'string' },
        arguments: expect.objectContaining({
          type: 'object',
          additionalProperties: true,
        }),
      }),
    });
    expect(doc.components.schemas.SuccessResponse).toMatchObject({
      properties: expect.objectContaining({
        data: {},
        _meta: expect.objectContaining({
          properties: expect.objectContaining({
            capability: { type: 'string' },
            traceId: { type: 'string' },
          }),
        }),
      }),
    });
  });
});
