import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const AI_DEV_ROOT = 'src/core/ai-dev';
const CAPABILITIES_ROOT = `${AI_DEV_ROOT}/capabilities`;
const ORCHESTRATION_ROOT = 'src/core/ai-dev/orchestration';
const MCP_ROOT = `${AI_DEV_ROOT}/mcp`;
const MAIN_ROOT = 'src/main';
const QUERY_ENGINE_ROOT = 'src/core/query-engine';
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

const isMainLayerImport = (specifier: string): boolean => {
  const normalized = normalizeImport(specifier);
  return normalized.includes('/main/') || normalized.startsWith('../../main/');
};

/**
 * 白名单：core→main 的 C 类类型导入（待逐步收敛到 0）
 *
 * 规则：
 * - A 类运行时值导入：绝对禁止（已通过之前的修复清理完毕）
 * - B 类动态导入：绝对禁止（已清理完毕）
 * - C 类类型导入：允许在白名单中，新加入需说明理由并规划迁移路径
 *
 * 迁移路径：
 * - DuckDBService / EnhancedColumnSchema → 提取到 types/duckdb.ts ✅
 * - ProfileService / ProfileGroupService / AccountService / SavedSiteService → 提取到 types/service-interfaces.ts ✅
 * - WebContentsViewManager / WindowManager → 提取到 core/browser-pool/ports.ts ✅
 * - WebhookSender → 提取到 types/service-interfaces.ts ✅
 * - SchedulerService → 提取到 types/scheduler.ts ✅
 * - ExtensionControlRelay / ExtensionRelayClientState / ExtensionRelayEvent / RuyiFirefoxClient / RuyiFirefoxEvent
 *   → 提取到 core/browser-automation/transport-types.ts ✅
 */
const CORE_MAIN_TYPE_IMPORT_WHITELIST: ReadonlySet<string> = new Set([
  // ✅ 所有 C 类类型导入已清理完毕 — DuckDBService/EnhancedColumnSchema 提取到 types/duckdb.ts
]);

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

  it('query-engine runtime code stays independent from the main process layer', () => {
    const files = collectTsFiles(QUERY_ENGINE_ROOT).filter((file) => !file.endsWith('.test.ts'));
    const violations: string[] = [];

    for (const file of files) {
      for (const specifier of extractImports(file)) {
        if (isMainLayerImport(specifier)) {
          violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('core layer does not introduce new runtime dependencies on main layer', () => {
    const CORE_ROOT = 'src/core';
    const files = collectTsFiles(CORE_ROOT).filter(
      (file) =>
        !file.endsWith('.test.ts') &&
        !file.replace(/\\/g, '/').includes('/__tests__/')
    );
    const runtimeViolations: string[] = [];
    const whitelistMisses: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const imports = extractImports(file);

      for (let i = 0; i < imports.length; i++) {
        const specifier = imports[i];
        if (!isMainLayerImport(specifier)) {
          continue;
        }

        // 判断是否为 import type：在 source 中定位该 import 语句的起始位置
        const normalizedSpecifier = normalizeImport(specifier);
        const specifierIndex = source.indexOf(normalizedSpecifier);
        const sourceBeforeSpecifier =
          specifierIndex >= 0 ? source.slice(0, specifierIndex) : source;
        // 找到最近的 "import" 关键字
        const lastImportIndex = sourceBeforeSpecifier.lastIndexOf('import');
        const importStatementStart =
          lastImportIndex >= 0 ? sourceBeforeSpecifier.slice(lastImportIndex) : '';
        const isTypeOnly = /^import\s+type\b/.test(importStatementStart);

        const violationKey = `${relative(process.cwd(), file).replace(/\\/g, '/')} -> ${normalizedSpecifier}`;

        if (!isTypeOnly) {
          // A 类或 B 类运行时导入：绝对禁止
          runtimeViolations.push(violationKey);
        } else if (!CORE_MAIN_TYPE_IMPORT_WHITELIST.has(violationKey)) {
          // C 类类型导入：不在白名单中，禁止新增
          whitelistMisses.push(violationKey);
        }
      }
    }

    // 先报告运行时违规（最严重）
    expect(runtimeViolations).toEqual([]);
    // 再报告未在白名单中的类型导入（防止 C 类无序膨胀）
    expect(whitelistMisses).toEqual([]);
  });
});
