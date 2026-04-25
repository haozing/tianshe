import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const AI_DEV_ROOT = 'src/core/ai-dev';
const CAPABILITIES_ROOT = `${AI_DEV_ROOT}/capabilities`;
const ORCHESTRATION_ROOT = 'src/core/ai-dev/orchestration';
const MCP_ROOT = `${AI_DEV_ROOT}/mcp`;
const MAIN_ROOT = 'src/main';
const HTTP_ENTRY = 'src/main/mcp-server-http.ts';

const IMPORT_PATTERN = /^\s*import(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const collectTsFiles = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
};

const extractImports = (filePath: string): string[] => {
  const source = readFileSync(filePath, 'utf8');
  return Array.from(source.matchAll(IMPORT_PATTERN)).map((match) => match[1]);
};

const normalizeImport = (specifier: string): string => specifier.replace(/\\/g, '/');

const isMcpImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../mcp' ||
    normalized === '../../mcp' ||
    normalized === '../../../mcp' ||
    normalized.startsWith('../mcp/') ||
    normalized.startsWith('../../mcp/') ||
    normalized.startsWith('../../../mcp/') ||
    normalized.includes('/ai-dev/mcp/')
  );
};

const isOrchestrationImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../orchestration' ||
    normalized === '../../orchestration' ||
    normalized === '../../../orchestration' ||
    normalized.startsWith('../orchestration/') ||
    normalized.startsWith('../../orchestration/') ||
    normalized.startsWith('../../../orchestration/') ||
    normalized.includes('/ai-dev/orchestration/')
  );
};

const isCapabilitiesImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../capabilities' ||
    normalized === '../../capabilities' ||
    normalized === '../../../capabilities' ||
    normalized.startsWith('../capabilities/') ||
    normalized.startsWith('../../capabilities/') ||
    normalized.startsWith('../../../capabilities/') ||
    normalized.includes('/ai-dev/capabilities/')
  );
};

const isOrchestrationTypesOnlyImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../orchestration/types' ||
    normalized === '../../orchestration/types' ||
    normalized === '../../../orchestration/types' ||
    normalized.endsWith('/ai-dev/orchestration/types')
  );
};

const isOrchestrationPublicImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../orchestration' ||
    normalized === '../../orchestration' ||
    normalized === '../../../orchestration' ||
    normalized.endsWith('/ai-dev/orchestration')
  );
};

const isMainToCapabilitiesImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return normalized.includes('/core/ai-dev/capabilities/');
};

const isMcpSdkImport = (specifier: string): boolean => {
  return normalizeImport(specifier).startsWith('@modelcontextprotocol/sdk/');
};

const isLegacyMcpModuleImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return (
    normalized === '../core/ai-dev/mcp' ||
    normalized === '../../core/ai-dev/mcp' ||
    normalized === '../../../core/ai-dev/mcp' ||
    normalized.startsWith('../core/ai-dev/mcp/') ||
    normalized.startsWith('../../core/ai-dev/mcp/') ||
    normalized.startsWith('../../../core/ai-dev/mcp/')
  );
};

describe('AI-Dev layered boundary contracts', () => {
  it('capabilities 层禁止依赖 orchestration/mcp 层实现', () => {
    const files = collectTsFiles(CAPABILITIES_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isMcpImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
          continue;
        }
        if (isOrchestrationImport(specifier) && !isOrchestrationTypesOnlyImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('orchestration 层禁止依赖 mcp 层实现', () => {
    const files = collectTsFiles(ORCHESTRATION_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isMcpImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('mcp 协议层禁止直接依赖 capabilities 层实现', () => {
    const files = collectTsFiles(MCP_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isCapabilitiesImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('mcp 协议层依赖 orchestration 仅允许公共入口', () => {
    const files = collectTsFiles(MCP_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isOrchestrationImport(specifier) && !isOrchestrationPublicImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('HTTP 入口禁止直接依赖 mcp 内部模块', () => {
    const imports = extractImports(HTTP_ENTRY);
    const violations = imports
      .filter((specifier) => {
        const normalized = normalizeImport(specifier);
        return normalized === '../core/ai-dev/mcp' || normalized.startsWith('../core/ai-dev/mcp/');
      })
      .map((specifier) => `${HTTP_ENTRY} -> ${specifier}`);

    expect(violations).toEqual([]);
  });

  it('HTTP 入口禁止直接依赖 MCP SDK 协议实现', () => {
    const imports = extractImports(HTTP_ENTRY);
    const violations = imports
      .filter((specifier) => isMcpSdkImport(specifier))
      .map((specifier) => `${HTTP_ENTRY} -> ${specifier}`);

    expect(violations).toEqual([]);
  });

  it('main 层禁止直接依赖 ai-dev capabilities 内部模块', () => {
    const files = collectTsFiles(MAIN_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isMainToCapabilitiesImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('运行时源码禁止依赖 legacy mcp 兼容模块', () => {
    const files = collectTsFiles('src').filter((file) => {
      const normalized = file.replace(/\\/g, '/');
      return !normalized.endsWith('.test.ts') && !normalized.startsWith('src/core/ai-dev/mcp/');
    });
    const violations: string[] = [];

    for (const file of files) {
      const imports = extractImports(file);
      for (const specifier of imports) {
        if (isLegacyMcpModuleImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
