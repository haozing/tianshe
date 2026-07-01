import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSiteAdapterRepairPath, type SiteAdapterFixture } from '../../core/site-adapter-runtime';
import { siteAdapterRegistry } from '../../site-adapters';

export interface SaveSiteAdapterExpectedInput {
  adapterId: string;
  fixtureName: string;
  expected: Record<string, unknown>;
}

export interface SaveSiteAdapterExpectedResult {
  adapterId: string;
  fixtureName: string;
  expectedPath: string;
  saved: true;
}

export interface SaveSiteAdapterExpectedOptions {
  workspaceRoot?: string;
  writeFile?: (absolutePath: string, content: string) => Promise<void> | void;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function resolveOfficialExpectedRelativePath(
  adapterId: string,
  fixtureName: string
): string {
  const registration = siteAdapterRegistry.getRegisteredAdapter(adapterId);
  if (!registration) {
    throw new Error(`Site adapter not found: ${adapterId}`);
  }
  if (registration.source !== 'built-in') {
    throw new Error(`Expected fixture save is only supported for built-in site adapters: ${adapterId}`);
  }
  const adapter = registration.module;
  if (!adapter.manifest.expected?.includes(fixtureName)) {
    throw new Error(`Expected fixture is not declared by ${adapterId}: ${fixtureName}`);
  }
  return path.posix.join('src/site-adapters', adapter.manifest.id, 'expected', `${fixtureName}.json`);
}

export async function saveSiteAdapterExpected(
  input: SaveSiteAdapterExpectedInput,
  options: SaveSiteAdapterExpectedOptions = {}
): Promise<SaveSiteAdapterExpectedResult> {
  assertPlainObject(input.expected, 'expected');
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const relativePath = resolveOfficialExpectedRelativePath(input.adapterId, input.fixtureName);
  const decision = assertSiteAdapterRepairPath(relativePath, { workspaceRoot });
  const content = `${JSON.stringify(input.expected, null, 2)}\n`;

  if (options.writeFile) {
    await options.writeFile(decision.absolutePath, content);
  } else {
    await fs.writeFile(decision.absolutePath, content, 'utf8');
  }

  return {
    adapterId: input.adapterId,
    fixtureName: input.fixtureName,
    expectedPath: decision.relativePath,
    saved: true,
  };
}

export interface SaveExpectedAndRunInput extends SaveSiteAdapterExpectedInput {
  fixture: SiteAdapterFixture;
}
