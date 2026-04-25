import type { BrowserToolName } from '../tool-definitions';
import { getSelectorEngineScript } from '../../../../browser-automation/selector-generator';
import { parseValidateSelectorParams } from '../tool-contracts';
import { createOperationFailedError } from './mcp-surface-errors';
import type { ToolHandler } from './types';
import {
  buildTargetContext,
  resolveElementTarget,
  type ElementTargetInput,
} from './target-resolution';
import { checkBrowserDependency } from './shared';
import { createErrorResult, createJsonResult } from './utils';

export async function handleBrowserValidateSelector(
  args: Record<string, unknown>,
  deps: Parameters<ToolHandler>[1]
): ReturnType<ToolHandler> {
  checkBrowserDependency(deps.browser);
  const params = parseValidateSelectorParams(args);
  const targetInput: ElementTargetInput = {
    selector: params.selector,
    ref: params.ref,
  };
  try {
    const resolvedTarget = await resolveElementTarget(deps.browser, targetInput, {
      requireCurrentMatch: false,
    });
    const result = await deps.browser.evaluate(`
      ${getSelectorEngineScript().trim()};
      (function() {
        const selector = ${JSON.stringify(resolvedTarget.selector)};
        try {
          const engine = window.__selectorEngine;
          const elements = engine?.querySelectorAll
            ? engine.querySelectorAll(selector)
            : Array.from(document.querySelectorAll(selector));
          const count = elements.length;
          const elementInfos = Array.from(elements).slice(0, 5).map((el) => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className:
              el.className && typeof el.className === 'string'
                ? el.className.trim().slice(0, 50)
                : undefined,
            text: el.textContent?.trim().slice(0, 30) || undefined,
          }));

          return {
            valid: true,
            matchCount: count,
            isUnique: count === 1,
            elements: elementInfos,
          };
        } catch (error) {
          return {
            valid: false,
            matchCount: 0,
            isUnique: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })()
    `);

    const validationResult = result as {
      valid: boolean;
      matchCount: number;
      isUnique: boolean;
      elements?: Array<{ tag: string; id?: string; className?: string; text?: string }>;
      error?: string;
    };

    if (!validationResult.valid) {
      return createJsonResult({
        valid: false,
        error: validationResult.error || 'Selector syntax error',
        selector: resolvedTarget.selector,
        source: resolvedTarget.source,
        ref: resolvedTarget.ref || null,
        dialect: 'airpa-selector',
      });
    }

    const expectUnique = params.expectUnique !== false;
    const isExpectedResult = !expectUnique || validationResult.isUnique;

    let message: string;
    if (validationResult.matchCount === 0) {
      message = 'Selector matched no elements.';
    } else if (validationResult.isUnique) {
      message = 'Selector is valid and matched exactly one element.';
    } else {
      message = expectUnique
        ? `Selector matched ${validationResult.matchCount} elements, but a unique match was expected.`
        : `Selector is valid and matched ${validationResult.matchCount} elements.`;
    }

    return createJsonResult({
      valid: true,
      selector: resolvedTarget.selector,
      source: resolvedTarget.source,
      ref: resolvedTarget.ref || null,
      dialect: 'airpa-selector',
      matchCount: validationResult.matchCount,
      isUnique: validationResult.isUnique,
      meetsExpectation: isExpectedResult,
      selectorCandidates: resolvedTarget.selectorCandidates,
      message,
      elements: validationResult.elements,
    });
  } catch (error) {
    return createErrorResult(
      createOperationFailedError('Selector validation', error, {
        context: buildTargetContext(targetInput),
      })
    );
  }
}

export const selectorValidationHandlers: Partial<Record<BrowserToolName, ToolHandler>> = {
  browser_validate_selector: handleBrowserValidateSelector,
};
