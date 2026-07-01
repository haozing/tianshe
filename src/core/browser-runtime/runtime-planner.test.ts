import { describe, expect, it } from 'vitest';
import { createBrowserRuntimePlan } from './runtime-planner';

describe('browser runtime planner', () => {
  it('returns ready when the current runtime and login state satisfy the request', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['snapshot.page', 'text.dom'],
      currentRuntimeId: 'chromium-extension-relay',
      currentProfileId: 'profile-1',
      site: 'example.com',
      profiles: [
        {
          id: 'profile-1',
          name: 'Shop Profile',
          runtimeId: 'chromium-extension-relay',
          loginStateRevision: 1,
        },
      ],
      loginStates: [
        {
          profileId: 'profile-1',
          site: 'example.com',
          runtimeIdSnapshot: 'chromium-extension-relay',
          profileRevision: 1,
          status: 'logged_in',
          verified: true,
        },
      ],
    });

    expect(plan).toMatchObject({
      decision: 'ready',
      recommendedRuntimeId: 'chromium-extension-relay',
      recommendedProfileId: 'profile-1',
    });
  });

  it('requires manual login when stored login revision is stale', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['snapshot.page'],
      currentRuntimeId: 'chromium-extension-relay',
      currentProfileId: 'profile-1',
      site: 'example.com',
      profiles: [
        {
          id: 'profile-1',
          runtimeId: 'chromium-extension-relay',
          loginStateRevision: 2,
        },
      ],
      loginStates: [
        {
          profileId: 'profile-1',
          site: 'example.com',
          runtimeIdSnapshot: 'chromium-extension-relay',
          profileRevision: 1,
          status: 'logged_in',
          verified: true,
        },
      ],
    });

    expect(plan.decision).toBe('needs_manual_login');
    expect(plan.recommendedProfileId).toBe('profile-1');
  });

  it('requires manual login when stored login runtime snapshot differs from the profile runtime', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['snapshot.page'],
      currentRuntimeId: 'chromium-extension-relay',
      currentProfileId: 'profile-1',
      site: 'example.com',
      profiles: [
        {
          id: 'profile-1',
          runtimeId: 'chromium-extension-relay',
          loginStateRevision: 1,
        },
      ],
      loginStates: [
        {
          profileId: 'profile-1',
          site: 'example.com',
          runtimeIdSnapshot: 'electron-webcontents',
          profileRevision: 1,
          status: 'logged_in',
          verified: true,
        },
      ],
    });

    expect(plan.decision).toBe('needs_manual_login');
    expect(plan.candidateProfiles[0]).toMatchObject({
      profileId: 'profile-1',
      loginVerified: false,
    });
  });

  it('recommends a compatible runtime/profile when the current runtime misses a capability', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['network.responseBody'],
      currentRuntimeId: 'electron-webcontents',
      currentProfileId: 'electron-profile',
      profiles: [
        { id: 'electron-profile', runtimeId: 'electron-webcontents' },
        { id: 'extension-profile', runtimeId: 'chromium-extension-relay' },
      ],
    });

    expect(plan.decision).toBe('needs_profile_switch');
    expect(plan.recommendedRuntimeId).toBe('chromium-extension-relay');
    expect(plan.recommendedProfileId).toBe('extension-profile');
    expect(
      plan.candidateRuntimes.find((candidate) => candidate.runtimeId === 'electron-webcontents')
        ?.missingCapabilities
    ).toEqual(['network.responseBody']);
  });

  it('does not switch profile or runtime when the current binding is locked', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['network.responseBody'],
      currentRuntimeId: 'electron-webcontents',
      currentProfileId: 'electron-profile',
      bindingLocked: true,
      profiles: [
        { id: 'electron-profile', runtimeId: 'electron-webcontents' },
        { id: 'extension-profile', runtimeId: 'chromium-extension-relay' },
      ],
    });

    expect(plan).toMatchObject({
      decision: 'blocked',
      recommendedRuntimeId: 'electron-webcontents',
      recommendedProfileId: 'electron-profile',
      bindingLocked: true,
    });
    expect(plan.recommendedAction).toContain('Create a new MCP session');
  });

  it('uses known effective runtime descriptors for Cloak experimental capabilities', () => {
    const plan = createBrowserRuntimePlan({
      requiredCapabilities: ['download.manage', 'dialog.promptText'],
      currentRuntimeId: 'electron-webcontents',
      currentProfileId: 'electron-profile',
      profiles: [
        { id: 'electron-profile', runtimeId: 'electron-webcontents' },
        { id: 'cloak-profile', runtimeId: 'chromium-cloak-playwright' },
      ],
    });

    expect(plan.decision).toBe('needs_profile_switch');
    expect(plan.recommendedRuntimeId).toBe('chromium-cloak-playwright');
    expect(plan.recommendedProfileId).toBe('cloak-profile');
    expect(
      plan.candidateRuntimes.find((candidate) => candidate.runtimeId === 'chromium-cloak-playwright')
        ?.missingCapabilities
    ).toEqual([]);
  });
});
