export type LifecycleResourceKind =
  | 'capabilityInvocation'
  | 'mcpSession'
  | 'browserLease'
  | 'siteAdapterRun'
  | 'datasetWrite';

export interface LifecycleContractRule {
  resource: LifecycleResourceKind;
  abortSignal: 'required' | 'propagated' | 'caller-controlled' | 'not-applicable';
  timeout: 'required' | 'caller-controlled' | 'not-applicable';
  cleanup: string;
  invariant: string;
}

export const ORCHESTRATION_LIFECYCLE_CONTRACT_VERSION = '1.0.0';

export const ORCHESTRATION_LIFECYCLE_CONTRACT: readonly LifecycleContractRule[] = Object.freeze([
  {
    resource: 'capabilityInvocation',
    abortSignal: 'propagated',
    timeout: 'required',
    cleanup: 'Abort is non-retryable and waits for a bounded drain before marking the invocation unsafe.',
    invariant: 'Aborted capability calls must not retry or continue browser work after AbortSignal fires.',
  },
  {
    resource: 'mcpSession',
    abortSignal: 'required',
    timeout: 'required',
    cleanup: 'Closing a session aborts the active invocation and releases any browser handle.',
    invariant: 'Session close must not leave an active browser lease attached to the closed transport.',
  },
  {
    resource: 'browserLease',
    abortSignal: 'propagated',
    timeout: 'required',
    cleanup: 'Acquire/show failures release the browser handle with destroy=true.',
    invariant: 'A failed or aborted acquire must not leave an active profile/browser lease behind.',
  },
  {
    resource: 'siteAdapterRun',
    abortSignal: 'propagated',
    timeout: 'caller-controlled',
    cleanup: 'Runner records an aborted transition and stops extractor/verifier work.',
    invariant: 'Aborted Site Adapter runs must not continue to later procedure steps.',
  },
  {
    resource: 'datasetWrite',
    abortSignal: 'caller-controlled',
    timeout: 'caller-controlled',
    cleanup: 'High-risk staged writes commit rows and provenance in the same DuckDB transaction.',
    invariant: 'Failed staged writes must not leave partial rows or partial provenance.',
  },
]);

export function getLifecycleContractRule(
  resource: LifecycleResourceKind
): LifecycleContractRule {
  const rule = ORCHESTRATION_LIFECYCLE_CONTRACT.find((item) => item.resource === resource);
  if (!rule) {
    throw new Error(`Missing lifecycle contract rule for ${resource}`);
  }
  return rule;
}
