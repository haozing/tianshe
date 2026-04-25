import type { z } from 'zod';
import { ErrorCode, createStructuredError } from '../../../../types/error-codes';
import { handleBrowserObserve, handleBrowserSearch, handleBrowserWaitFor } from './handlers/browser-handlers';
import { handleBrowserAct } from './handlers/workflow';
import type { ToolCallResult, ToolHandlerDependencies } from './handlers/types';
import { createErrorResult } from './handlers/utils';
import { browserAct, browserObserve, browserSearch, browserWaitFor } from './tool-definitions';

type BrowserObserveInput = z.input<typeof browserObserve.schema>;
type BrowserSearchInput = z.input<typeof browserSearch.schema>;
type BrowserWaitForInput = z.input<typeof browserWaitFor.schema>;
type BrowserActInput = z.input<typeof browserAct.schema>;
type BrowserActClickInput = Extract<BrowserActInput, { action: 'click' }>;
type BrowserActTypeInput = Extract<BrowserActInput, { action: 'type' }>;
type BrowserActPressInput = Extract<BrowserActInput, { action: 'press' }>;

type SearchTargetResolutionMode = 'single' | 'first';

type BrowserFastPathActInput =
  | BrowserActPressInput
  | (Omit<BrowserActClickInput, 'target'> & {
      action: 'click';
      target?: BrowserActClickInput['target'];
      targetFromSearch?: SearchTargetResolutionMode;
    })
  | (Omit<BrowserActTypeInput, 'target'> & {
      action: 'type';
      target?: BrowserActTypeInput['target'];
      targetFromSearch?: SearchTargetResolutionMode;
    });

export interface BrowserObserveSearchActFastPathPlan {
  observe?: BrowserObserveInput;
  search?: BrowserSearchInput;
  act?: BrowserFastPathActInput;
  waitFor?: BrowserWaitForInput;
}

export interface BrowserObserveSearchActFastPathResolvedTarget {
  source: 'explicit' | 'search-single' | 'search-first' | 'none';
  searchTotal: number | null;
  target: Record<string, unknown> | null;
}

export interface BrowserObserveSearchActFastPathResult {
  ok: boolean;
  stoppedAt: 'observe' | 'search' | 'act' | 'wait_for' | 'completed';
  observe?: ToolCallResult;
  search?: ToolCallResult;
  act?: ToolCallResult;
  waitFor?: ToolCallResult;
  resolvedActTarget: BrowserObserveSearchActFastPathResolvedTarget;
}

type SearchResultElement = {
  element?: {
    elementRef?: string;
    preferredSelector?: string;
  };
};

function getSearchData(result: ToolCallResult): {
  total: number;
  results: SearchResultElement[];
} | null {
  if (result.isError) {
    return null;
  }

  const structured = result.structuredContent as
    | {
        data?: {
          total?: unknown;
          results?: unknown;
        };
      }
    | undefined;
  const total = Number(structured?.data?.total ?? 0);
  const results = Array.isArray(structured?.data?.results)
    ? (structured?.data?.results as SearchResultElement[])
    : [];
  return {
    total: Number.isFinite(total) ? total : results.length,
    results,
  };
}

function getExplicitActTarget(
  act: BrowserFastPathActInput
): Record<string, unknown> | null {
  if (!('target' in act) || !act.target) {
    return null;
  }

  return act.target as Record<string, unknown>;
}

function buildTargetFromSearchResult(result: SearchResultElement): Record<string, unknown> | null {
  const element = result.element;
  if (!element) {
    return null;
  }

  if (typeof element.elementRef === 'string' && element.elementRef.trim()) {
    return {
      kind: 'element',
      ref: element.elementRef,
    };
  }

  if (typeof element.preferredSelector === 'string' && element.preferredSelector.trim()) {
    return {
      kind: 'element',
      selector: element.preferredSelector,
    };
  }

  return null;
}

function createFastPathError(
  message: string,
  context: Record<string, unknown>
): ToolCallResult {
  return createErrorResult(
    createStructuredError(ErrorCode.VALIDATION_ERROR, message, {
      details: 'The internal observe-search-act fast path could not resolve a stable element target.',
      suggestion:
        'Provide an explicit browser_act target or refine browser_search so it returns a single actionable element.',
      context,
    })
  );
}

function resolveActTarget(
  act: BrowserFastPathActInput,
  searchResult: ToolCallResult | undefined
): {
  request: BrowserActInput | null;
  resolvedTarget: BrowserObserveSearchActFastPathResolvedTarget;
  error?: ToolCallResult;
} {
  const explicitTarget = getExplicitActTarget(act);
  if (explicitTarget) {
    return {
      request: act as BrowserActInput,
      resolvedTarget: {
        source: 'explicit',
        searchTotal: null,
        target: explicitTarget,
      },
    };
  }

  if (act.action === 'press') {
    return {
      request: act,
      resolvedTarget: {
        source: 'explicit',
        searchTotal: null,
        target: act.target as Record<string, unknown>,
      },
    };
  }

  const mode = act.targetFromSearch ?? 'single';
  if (!searchResult) {
    return {
      request: null,
      resolvedTarget: {
        source: 'none',
        searchTotal: null,
        target: null,
      },
      error: createFastPathError(
        'browser_act targetFromSearch requires a preceding browser_search step.',
        {
          action: act.action,
          targetFromSearch: mode,
        }
      ),
    };
  }

  const searchData = getSearchData(searchResult);
  if (!searchData || searchData.results.length === 0) {
    return {
      request: null,
      resolvedTarget: {
        source: 'none',
        searchTotal: searchData?.total ?? 0,
        target: null,
      },
      error: createFastPathError(
        'browser_search returned no actionable result for the internal fast path.',
        {
          action: act.action,
          targetFromSearch: mode,
          searchTotal: searchData?.total ?? 0,
        }
      ),
    };
  }

  if (mode === 'single' && searchData.results.length !== 1) {
    return {
      request: null,
      resolvedTarget: {
        source: 'none',
        searchTotal: searchData.total,
        target: null,
      },
      error: createFastPathError(
        'browser_search returned multiple results; targetFromSearch="single" requires exactly one match.',
        {
          action: act.action,
          targetFromSearch: mode,
          searchTotal: searchData.total,
        }
      ),
    };
  }

  const selected = buildTargetFromSearchResult(searchData.results[0]);
  if (!selected) {
    return {
      request: null,
      resolvedTarget: {
        source: 'none',
        searchTotal: searchData.total,
        target: null,
      },
      error: createFastPathError(
        'browser_search returned a result without elementRef or preferredSelector.',
        {
          action: act.action,
          targetFromSearch: mode,
          searchTotal: searchData.total,
        }
      ),
    };
  }

  return {
    // targetFromSearch is an internal helper hint and must not leak into canonical browser_act params.
    request: {
      ...Object.fromEntries(
        Object.entries(act).filter(([key]) => key !== 'targetFromSearch')
      ),
      target: selected as BrowserActClickInput['target'] | BrowserActTypeInput['target'],
    } as BrowserActInput,
    resolvedTarget: {
      source: mode === 'single' ? 'search-single' : 'search-first',
      searchTotal: searchData.total,
      target: selected,
    },
  };
}

export async function executeBrowserObserveSearchActFastPath(
  plan: BrowserObserveSearchActFastPathPlan,
  deps: ToolHandlerDependencies
): Promise<BrowserObserveSearchActFastPathResult> {
  const result: BrowserObserveSearchActFastPathResult = {
    ok: true,
    stoppedAt: 'completed',
    resolvedActTarget: {
      source: 'none',
      searchTotal: null,
      target: null,
    },
  };

  if (plan.observe) {
    result.observe = await handleBrowserObserve(plan.observe as Record<string, unknown>, deps);
    if (result.observe.isError) {
      return {
        ...result,
        ok: false,
        stoppedAt: 'observe',
      };
    }
  }

  if (plan.search) {
    result.search = await handleBrowserSearch(plan.search as Record<string, unknown>, deps);
    if (result.search.isError) {
      return {
        ...result,
        ok: false,
        stoppedAt: 'search',
      };
    }
  }

  if (plan.act) {
    const resolved = resolveActTarget(plan.act, result.search);
    result.resolvedActTarget = resolved.resolvedTarget;
    if (resolved.error || !resolved.request) {
      result.act = resolved.error;
      return {
        ...result,
        ok: false,
        stoppedAt: 'act',
      };
    }

    result.act = await handleBrowserAct(resolved.request as Record<string, unknown>, deps);
    if (result.act.isError) {
      return {
        ...result,
        ok: false,
        stoppedAt: 'act',
      };
    }
  }

  if (plan.waitFor) {
    result.waitFor = await handleBrowserWaitFor(plan.waitFor as Record<string, unknown>, deps);
    if (result.waitFor.isError) {
      return {
        ...result,
        ok: false,
        stoppedAt: 'wait_for',
      };
    }
  }

  return result;
}
