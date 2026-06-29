import type { SiteAdapterFieldDiagnostic } from './types';

type SiteAdapterExpectationMatcher =
  | { __siteAdapterExpectation: 'present' }
  | { __siteAdapterExpectation: 'non-empty-string' }
  | { __siteAdapterExpectation: 'non-empty-array' }
  | { __siteAdapterExpectation: 'number-at-least'; min: number };

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

function isExpectationMatcher(value: unknown): value is SiteAdapterExpectationMatcher {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).__siteAdapterExpectation === 'string'
  );
}

function matchesExpectation(actual: unknown, expected: SiteAdapterExpectationMatcher): boolean {
  switch (expected.__siteAdapterExpectation) {
    case 'present':
      return actual !== undefined && actual !== null && actual !== '';
    case 'non-empty-string':
      return typeof actual === 'string' && actual.trim().length > 0;
    case 'non-empty-array':
      return Array.isArray(actual) && actual.length > 0;
    case 'number-at-least':
      return typeof actual === 'number' && Number.isFinite(actual) && actual >= expected.min;
  }
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
      ok: isExpectationMatcher(expectedValue)
        ? matchesExpectation(actualValue, expectedValue)
        : valuesEqual(actualValue, expectedValue),
      expected: expectedValue,
      actual: actualValue,
    };
  });
}
