import type { SiteAdapterModule } from '../../core/site-adapter-runtime';
import { githubProfileExtractor } from './extractors/profile';
import { createIssueProcedure } from './procedures/create-issue';
import { openProfileSettingsProcedure } from './procedures/open-profile-settings';
import { prepareIssueDraftProcedure } from './procedures/prepare-issue-draft';
import { githubProfileVerifier } from './verifiers/profile';

export const githubProfileAdapter: SiteAdapterModule = {
  manifest: {
    id: 'github-profile',
    name: 'GitHub Profile',
    version: '1.0.0',
    site: 'github.com',
    siteId: 'github',
    sideEffectLevel: 'high',
    capabilities: [
      'github.extract_profile_summary',
      'github.prepare_issue_draft',
      'github.create_issue',
    ],
    supportedRunners: ['fixture', 'browser-snapshot', 'procedure'],
    riskLevel: 'high',
    requiredScopes: ['browser.read', 'browser.write', 'profile.read'],
    repairScope: {
      roots: ['src/site-adapters/github-profile', 'site-adapters/github-profile'],
      allowedSubpaths: ['extractors', 'verifiers', 'fixtures', 'expected', 'procedures'],
    },
    fixtures: ['profile-settings'],
    expected: ['profile-settings'],
    extractors: [
      {
        id: 'profile-summary',
        outputFields: [
          'displayName',
          'bio',
          'company',
          'blog',
          'sourceUrl',
          'confidence',
          'missingFields',
          'selectorHits',
          'pageFingerprint',
        ],
      },
    ],
    verifiers: [
      {
        id: 'profile-required-fields',
        description: 'Checks that the logged-in profile page exposed public profile fields.',
      },
    ],
    procedures: [
      {
        id: openProfileSettingsProcedure.id,
        description:
          'Open the logged-in GitHub profile settings page and verify the editable profile form is visible.',
        sideEffectLevel: openProfileSettingsProcedure.sideEffectLevel,
        requiredScopes: ['browser.read', 'profile.read'],
        verification:
          'Requires the Public profile text and profile name field to be visible before completion.',
      },
      {
        id: prepareIssueDraftProcedure.id,
        description:
          'Prepare a GitHub issue draft in a selected repository after verified login without submitting it.',
        sideEffectLevel: prepareIssueDraftProcedure.sideEffectLevel,
        requiredScopes: ['browser.write', 'profile.read'],
        verification:
          'Requires the new issue form to be visible and verifies the drafted title and body before completion.',
      },
      {
        id: createIssueProcedure.id,
        description:
          'Create a GitHub issue in a selected repository after verified login and explicit destructive confirmation.',
        sideEffectLevel: createIssueProcedure.sideEffectLevel,
        requiredScopes: ['browser.write', 'profile.read'],
        verification:
          'Requires the new issue form to be visible, verifies title/body entry, and confirms the submitted issue page contains the issue title.',
      },
    ],
  },
  extractors: [githubProfileExtractor],
  verifiers: [githubProfileVerifier],
  procedures: [openProfileSettingsProcedure, prepareIssueDraftProcedure, createIssueProcedure],
};
