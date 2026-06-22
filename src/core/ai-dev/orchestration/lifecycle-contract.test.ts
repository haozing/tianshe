import { describe, expect, it } from 'vitest';
import {
  getLifecycleContractRule,
  ORCHESTRATION_LIFECYCLE_CONTRACT,
  ORCHESTRATION_LIFECYCLE_CONTRACT_VERSION,
} from './lifecycle-contract';

describe('orchestration lifecycle contract', () => {
  it('defines one executable lifecycle rule per governed resource', () => {
    expect(ORCHESTRATION_LIFECYCLE_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ORCHESTRATION_LIFECYCLE_CONTRACT.map((rule) => rule.resource).sort()).toEqual([
      'browserLease',
      'capabilityInvocation',
      'datasetWrite',
      'mcpSession',
      'siteAdapterRun',
    ]);

    for (const rule of ORCHESTRATION_LIFECYCLE_CONTRACT) {
      expect(rule.cleanup).toBeTruthy();
      expect(rule.invariant).toBeTruthy();
      expect(['required', 'propagated', 'caller-controlled', 'not-applicable']).toContain(
        rule.abortSignal
      );
    }
  });

  it('codifies the P1 invariants for abort, lease release, and staged dataset writes', () => {
    expect(getLifecycleContractRule('capabilityInvocation')).toMatchObject({
      abortSignal: 'propagated',
      timeout: 'required',
    });
    expect(getLifecycleContractRule('browserLease').invariant).toContain('lease');
    expect(getLifecycleContractRule('datasetWrite').invariant).toContain('partial provenance');
    expect(getLifecycleContractRule('siteAdapterRun')).toMatchObject({
      abortSignal: 'propagated',
    });
  });
});
