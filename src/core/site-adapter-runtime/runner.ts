import type {
  BrowserInterface,
  BrowserPageContentCapability,
  SnapshotOptions,
} from '../../types/browser-interface';
import { validateSiteAdapterModule } from './manifest';
import {
  runReadOnlySiteAdapterFixture,
  runReadOnlySiteAdapterRuntimeCanary,
  type ReadOnlySiteAdapterFixtureRunOptions,
} from './read-only-runner';
import {
  runSiteAdapterProcedure,
  type SiteAdapterProcedureDefinition,
  type SiteAdapterProcedureRunOptions,
} from './procedure';
import type {
  SiteAdapterFixture,
  SiteAdapterFixtureRunResult,
  SiteAdapterModule,
  SiteAdapterSupportedRunner,
} from './types';

export const DEFAULT_BROWSER_EVALUATE_SNAPSHOT_SCRIPT = `
(() => {
  const elements = Array.from(document.querySelectorAll('body *')).map((element, index) => ({
    ref: String(index + 1),
    tag: element.tagName.toLowerCase(),
    text: (element.textContent || '').trim().slice(0, 500),
    attributes: Array.from(element.attributes || []).reduce((acc, attribute) => {
      acc[attribute.name] = attribute.value;
      return acc;
    }, {}),
  }));
  return {
    url: window.location.href,
    title: document.title,
    elements,
  };
})()
`.trim();

export type SiteAdapterRunnerKind = SiteAdapterSupportedRunner;

interface SiteAdapterRunnerBaseRequest {
  adapter: SiteAdapterModule;
}

export interface SiteAdapterFixtureRunnerRequest extends SiteAdapterRunnerBaseRequest {
  runner: 'fixture';
  fixture: SiteAdapterFixture;
  options?: ReadOnlySiteAdapterFixtureRunOptions;
}

export interface SiteAdapterBrowserSnapshotRunnerRequest extends SiteAdapterRunnerBaseRequest {
  runner: 'browser-snapshot';
  browser: Pick<BrowserInterface, 'snapshot'>;
  fixtureName: string;
  expected: Record<string, unknown>;
  input?: Record<string, unknown>;
  snapshotOptions?: SnapshotOptions;
  options?: ReadOnlySiteAdapterFixtureRunOptions;
}

export interface SiteAdapterBrowserEvaluateRunnerRequest extends SiteAdapterRunnerBaseRequest {
  runner: 'browser-evaluate';
  browser: Pick<BrowserPageContentCapability, 'evaluate'>;
  fixtureName: string;
  expected: Record<string, unknown>;
  input?: Record<string, unknown>;
  evaluateScript?: string;
  options?: ReadOnlySiteAdapterFixtureRunOptions;
}

export interface SiteAdapterProcedureRunnerRequest extends SiteAdapterRunnerBaseRequest {
  runner: 'procedure';
  procedureId: string;
  browser: BrowserInterface;
  options?: SiteAdapterProcedureRunOptions;
}

export type SiteAdapterRunnerRunRequest =
  | SiteAdapterFixtureRunnerRequest
  | SiteAdapterBrowserSnapshotRunnerRequest
  | SiteAdapterBrowserEvaluateRunnerRequest
  | SiteAdapterProcedureRunnerRequest;

export type SiteAdapterReadRunnerRunRequest =
  | SiteAdapterFixtureRunnerRequest
  | SiteAdapterBrowserSnapshotRunnerRequest
  | SiteAdapterBrowserEvaluateRunnerRequest;

export type SiteAdapterReadRunnerRunResult = SiteAdapterFixtureRunResult & {
  runner: 'fixture' | 'browser-snapshot' | 'browser-evaluate';
};

export interface SiteAdapterProcedureRunnerRunResult {
  runner: 'procedure';
  adapterId: string;
  procedureId: string;
  ok: boolean;
  runState: Awaited<ReturnType<typeof runSiteAdapterProcedure>>['runState'];
  actionTrace: Awaited<ReturnType<typeof runSiteAdapterProcedure>>['actionTrace'];
  transitions: Awaited<ReturnType<typeof runSiteAdapterProcedure>>['transitions'];
  artifactRefs: string[];
}

export type SiteAdapterRunnerRunResult =
  | SiteAdapterReadRunnerRunResult
  | SiteAdapterProcedureRunnerRunResult;

function assertRunnerSupported(adapter: SiteAdapterModule, runner: SiteAdapterSupportedRunner): void {
  const supportedRunners = adapter.manifest.supportedRunners;
  if (supportedRunners && !supportedRunners.includes(runner)) {
    throw new Error(
      `Site adapter ${adapter.manifest.id} does not support runner ${runner}`
    );
  }
}

function resolveProcedure(
  adapter: SiteAdapterModule,
  procedureId: string
): SiteAdapterProcedureDefinition {
  const procedure = adapter.procedures?.find((item) => item.id === procedureId);
  if (!procedure) {
    throw new Error(`Site adapter ${adapter.manifest.id} is missing procedure ${procedureId}`);
  }
  return procedure as SiteAdapterProcedureDefinition;
}

export function runSiteAdapter(
  request: SiteAdapterReadRunnerRunRequest
): Promise<SiteAdapterReadRunnerRunResult>;
// eslint-disable-next-line no-redeclare
export function runSiteAdapter(
  request: SiteAdapterProcedureRunnerRequest
): Promise<SiteAdapterProcedureRunnerRunResult>;
// eslint-disable-next-line no-redeclare
export async function runSiteAdapter(
  request: SiteAdapterRunnerRunRequest
): Promise<SiteAdapterRunnerRunResult> {
  validateSiteAdapterModule(request.adapter);
  assertRunnerSupported(request.adapter, request.runner);

  if (request.runner === 'fixture') {
    const result = await runReadOnlySiteAdapterFixture(
      request.adapter,
      request.fixture,
      request.options
    );
    return { ...result, runner: request.runner };
  }

  if (request.runner === 'browser-snapshot') {
    const result = await runReadOnlySiteAdapterRuntimeCanary(request.adapter, {
      browser: request.browser,
      fixtureName: request.fixtureName,
      expected: request.expected,
      input: request.input,
      snapshotOptions: request.snapshotOptions,
      ...(request.options || {}),
    });
    return { ...result, runner: request.runner };
  }

  if (request.runner === 'browser-evaluate') {
    const snapshot = await request.browser.evaluate<unknown>(
      request.evaluateScript || DEFAULT_BROWSER_EVALUATE_SNAPSHOT_SCRIPT
    );
    const result = await runReadOnlySiteAdapterFixture(
      request.adapter,
      {
        name: request.fixtureName,
        snapshot,
        input: request.input,
        expected: request.expected,
      },
      request.options
    );
    return { ...result, runner: request.runner };
  }

  const procedure = resolveProcedure(request.adapter, request.procedureId);
  const result = await runSiteAdapterProcedure(procedure, request.browser, request.options);
  return {
    runner: request.runner,
    adapterId: request.adapter.manifest.id,
    procedureId: procedure.id,
    ok: result.ok,
    runState: result.runState,
    actionTrace: result.actionTrace,
    transitions: result.transitions,
    artifactRefs: [],
  };
}

export const SiteAdapterRunner = {
  run: runSiteAdapter,
};
