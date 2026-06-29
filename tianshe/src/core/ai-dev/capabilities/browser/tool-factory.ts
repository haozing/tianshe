import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type?: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
    [key: string]: unknown;
  };
}

export interface ToolDefinitionWithSchema<T extends ZodType = ZodType> extends MCPToolDefinition {
  schema: T;
}

export interface CreateToolOptions {
  inputSchemaOverride?: MCPToolDefinition['inputSchema'];
}

const normalizeInputSchema = (
  schema: MCPToolDefinition['inputSchema'] | Record<string, unknown>
): MCPToolDefinition['inputSchema'] => {
  const normalizedSchema = { ...schema } as Record<string, unknown>;

  if (
    normalizedSchema.type === undefined &&
    (Array.isArray(normalizedSchema.anyOf) ||
      Array.isArray(normalizedSchema.oneOf) ||
      Array.isArray(normalizedSchema.allOf))
  ) {
    normalizedSchema.type = 'object';
  }

  return normalizedSchema as MCPToolDefinition['inputSchema'];
};

export function createTool<T extends ZodType>(
  name: string,
  description: string,
  schema: T,
  options: CreateToolOptions = {}
): ToolDefinitionWithSchema<T> {
  if (options.inputSchemaOverride) {
    return {
      name,
      description,
      schema,
      inputSchema: normalizeInputSchema(options.inputSchemaOverride),
    };
  }

  const jsonSchema = (zodToJsonSchema as any)(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    errorMessages: true,
  });

  const { $schema: _$schema, ...cleanSchema } = jsonSchema as Record<string, unknown>;

  return {
    name,
    description,
    schema,
    inputSchema: normalizeInputSchema(cleanSchema),
  };
}

export function createNoParamTool(name: string, description: string): MCPToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  };
}

export function createToolRegistry<T extends MCPToolDefinition>(tools: T[]): Record<string, T> {
  return tools.reduce(
    (acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    },
    {} as Record<string, T>
  );
}

export function getToolSchema<T extends ToolDefinitionWithSchema>(tool: T): T['schema'] {
  return tool.schema;
}

export {
  optionalBoolean,
  optionalNumber,
  optionalString,
  positiveInt,
  nonNegativeInt,
  selectorSchema,
  urlSchema,
} from './schema-primitives';
