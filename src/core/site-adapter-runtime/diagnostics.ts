import type { SiteAdapterFieldDiagnostic } from './types';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function getPathValue(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function createSiteAdapterFieldDiagnostics(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): SiteAdapterFieldDiagnostic[] {
  return Object.entries(expected).map(([path, expectedValue]) => {
    const actualValue = getPathValue(actual, path);
    return {
      path,
      ok: valuesEqual(actualValue, expectedValue),
      expected: expectedValue,
      actual: actualValue,
    };
  });
}
