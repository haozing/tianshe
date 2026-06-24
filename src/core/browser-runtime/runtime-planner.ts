import type {
  BrowserCapabilityName,
  BrowserRuntimeDescriptor,
} from '../../types/browser-interface';
import { BROWSER_CAPABILITY_NAMES } from '../../types/browser-interface';
import type { BrowserRuntimeId } from '../../types/browser-runtime';
import { BROWSER_RUNTIME_IDS, isBrowserRuntimeId } from '../../types/browser-runtime';
import {
  browserRuntimeSupports,
  cloneBrowserRuntimeDescriptor,
} from '../browser-pool/runtime-capability-registry';
import { getKnownEffectiveRuntimeDescriptor } from './effective-descriptor';

export type BrowserRuntimePlanDecision =
  | 'ready'
  | 'needs_profile_switch'
  | 'needs_runtime_install'
  | 'needs_manual_login'
  | 'blocked';

export interface RuntimePlannerProfile {
  id: string;
  name?: string;
  runtimeId?: string;
  status?: string;
  isSystem?: boolean;
}

export interface RuntimePlannerLoginState {
  profileId: string;
  site: string;
  status: string;
  verified?: boolean;
  verifiedAt?: string | null;
  reason?: string | null;
}

export interface RuntimePlannerInput {
  requiredCapabilities?: BrowserCapabilityName[];
  preferredProfileId?: string;
  site?: string;
  needsVisible?: boolean;
  allowNewProfile?: boolean;
  currentRuntimeId?: BrowserRuntimeId;
  currentProfileId?: string;
  bindingLocked?: boolean;
  profiles?: RuntimePlannerProfile[];
  loginStates?: RuntimePlannerLoginState[];
  runtimeDescriptors?: Partial<Record<BrowserRuntimeId, BrowserRuntimeDescriptor>>;
}

export interface RuntimeCandidate {
  runtimeId: BrowserRuntimeId;
  descriptor: BrowserRuntimeDescriptor;
  supported: boolean;
  missingCapabilities: BrowserCapabilityName[];
  visibilityMode: BrowserRuntimeDescriptor['visibilityMode'];
  profileMode: BrowserRuntimeDescriptor['profileMode'];
  reasons: string[];
}

export interface ProfileCandidate {
  profileId: string;
  name?: string;
  runtimeId?: BrowserRuntimeId;
  supported: boolean;
  loginStatus?: string;
  loginVerified?: boolean;
  reasons: string[];
}

export interface BrowserRuntimePlan {
  decision: BrowserRuntimePlanDecision;
  recommendedRuntimeId?: BrowserRuntimeId;
  recommendedProfileId?: string;
  candidateRuntimes: RuntimeCandidate[];
  candidateProfiles: ProfileCandidate[];
  requiredCapabilities: BrowserCapabilityName[];
  reasons: string[];
  recommendedAction: string;
  bindingLocked: boolean;
}

const normalizeCapabilityNames = (
  requiredCapabilities: readonly BrowserCapabilityName[] | undefined
): BrowserCapabilityName[] => {
  const valid = new Set<string>(BROWSER_CAPABILITY_NAMES);
  return Array.from(
    new Set((requiredCapabilities || []).filter((name) => valid.has(name)))
  ) as BrowserCapabilityName[];
};

const normalizeRuntimeId = (value: string | undefined): BrowserRuntimeId | undefined =>
  isBrowserRuntimeId(value) ? value : undefined;

const getRuntimeDescriptors = (
  overrides: RuntimePlannerInput['runtimeDescriptors']
): Record<BrowserRuntimeId, BrowserRuntimeDescriptor> =>
  Object.fromEntries(
    BROWSER_RUNTIME_IDS.map((runtimeId) => [
      runtimeId,
      overrides?.[runtimeId] || cloneBrowserRuntimeDescriptor(getKnownEffectiveRuntimeDescriptor(runtimeId)),
    ])
  ) as Record<BrowserRuntimeId, BrowserRuntimeDescriptor>;

const matchesSite = (state: RuntimePlannerLoginState, site: string | undefined): boolean =>
  !site || state.site.trim().toLowerCase() === site.trim().toLowerCase();

const isHealthyLogin = (state: RuntimePlannerLoginState | undefined): boolean =>
  state?.verified === true && state.status === 'logged_in';

export function createBrowserRuntimePlan(input: RuntimePlannerInput): BrowserRuntimePlan {
  const requiredCapabilities = normalizeCapabilityNames(input.requiredCapabilities);
  const descriptors = getRuntimeDescriptors(input.runtimeDescriptors);
  const reasons: string[] = [];
  const bindingLocked = input.bindingLocked === true;

  const candidateRuntimes: RuntimeCandidate[] = Object.values(descriptors).map((descriptor) => {
    const missingCapabilities = requiredCapabilities.filter(
      (capabilityName) => !browserRuntimeSupports(descriptor, capabilityName)
    );
    const visibleSupported =
      input.needsVisible !== true || descriptor.visibilityMode !== 'headless';
    const supported = missingCapabilities.length === 0 && visibleSupported;
    return {
      runtimeId: descriptor.runtimeId,
      descriptor,
      supported,
      missingCapabilities,
      visibilityMode: descriptor.visibilityMode,
      profileMode: descriptor.profileMode,
      reasons: [
        ...(missingCapabilities.length
          ? [`missing capabilities: ${missingCapabilities.join(', ')}`]
          : []),
        ...(!visibleSupported ? ['visible browser handoff requires a non-headless runtime'] : []),
      ],
    };
  });

  const supportedRuntimeIds = new Set(
    candidateRuntimes
      .filter((candidate) => candidate.supported)
      .map((candidate) => candidate.runtimeId)
  );
  const loginStates = input.loginStates || [];
  const candidateProfiles: ProfileCandidate[] = (input.profiles || []).map((profile) => {
    const runtimeId = normalizeRuntimeId(profile.runtimeId);
    const loginState = loginStates.find(
      (state) => state.profileId === profile.id && matchesSite(state, input.site)
    );
    const supported = Boolean(runtimeId && supportedRuntimeIds.has(runtimeId));
    return {
      profileId: profile.id,
      ...(profile.name ? { name: profile.name } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      supported,
      ...(loginState ? { loginStatus: loginState.status } : {}),
      ...(loginState ? { loginVerified: loginState.verified === true } : {}),
      reasons: [
        ...(!runtimeId ? ['profile runtime is unknown'] : []),
        ...(runtimeId && !supportedRuntimeIds.has(runtimeId)
          ? [`profile runtime ${runtimeId} does not satisfy required capabilities`]
          : []),
        ...(input.site && !loginState ? [`no login state recorded for ${input.site}`] : []),
        ...(input.site && loginState && !isHealthyLogin(loginState)
          ? [`login state is ${loginState.status}`]
          : []),
      ],
    };
  });

  const currentRuntimeId = input.currentRuntimeId;
  const currentProfileId = input.currentProfileId;
  const currentRuntimeCandidate = currentRuntimeId
    ? candidateRuntimes.find((candidate) => candidate.runtimeId === currentRuntimeId)
    : undefined;
  const currentProfileCandidate = currentProfileId
    ? candidateProfiles.find((candidate) => candidate.profileId === currentProfileId)
    : undefined;

  if (bindingLocked) {
    if (currentRuntimeCandidate?.supported && (!input.site || isHealthyLoginForProfile(currentProfileId, input))) {
      return {
        decision: 'ready',
        recommendedRuntimeId: currentRuntimeId,
        ...(currentProfileId ? { recommendedProfileId: currentProfileId } : {}),
        candidateRuntimes,
        candidateProfiles,
        requiredCapabilities,
        reasons: ['Current locked session binding satisfies the requested plan.'],
        recommendedAction: 'Continue using the current locked MCP session binding.',
        bindingLocked,
      };
    }

    reasons.push('Current MCP session binding is locked and cannot switch profile or runtime.');
    if (currentRuntimeCandidate && !currentRuntimeCandidate.supported) {
      reasons.push(...currentRuntimeCandidate.reasons);
    }
    if (input.site && currentProfileCandidate && !isHealthyLoginForProfile(currentProfileId, input)) {
      reasons.push(`Current profile needs manual login for ${input.site}.`);
    }
    return {
      decision: 'blocked',
      ...(currentRuntimeId ? { recommendedRuntimeId: currentRuntimeId } : {}),
      ...(currentProfileId ? { recommendedProfileId: currentProfileId } : {}),
      candidateRuntimes,
      candidateProfiles,
      requiredCapabilities,
      reasons,
      recommendedAction:
        'Create a new MCP session before changing profile, runtime, visibility, or login state.',
      bindingLocked,
    };
  }

  if (currentRuntimeCandidate?.supported && (!input.site || isHealthyLoginForProfile(currentProfileId, input))) {
    return {
      decision: 'ready',
      recommendedRuntimeId: currentRuntimeCandidate.runtimeId,
      ...(currentProfileId ? { recommendedProfileId: currentProfileId } : {}),
      candidateRuntimes,
      candidateProfiles,
      requiredCapabilities,
      reasons: ['Current session runtime/profile can satisfy the requested plan.'],
      recommendedAction: 'Call session_prepare with the current binding or proceed to browser work.',
      bindingLocked,
    };
  }

  if (supportedRuntimeIds.size === 0) {
    return {
      decision: 'needs_runtime_install',
      candidateRuntimes,
      candidateProfiles,
      requiredCapabilities,
      reasons: ['No known runtime currently satisfies the requested capability set.'],
      recommendedAction: 'Install or enable a runtime that supports the required browser capabilities.',
      bindingLocked,
    };
  }

  const preferredProfile = input.preferredProfileId
    ? candidateProfiles.find((profile) => profile.profileId === input.preferredProfileId)
    : undefined;
  const compatibleLoggedInProfile = candidateProfiles.find(
    (profile) =>
      profile.supported &&
      (!input.site || (profile.loginVerified === true && profile.loginStatus === 'logged_in'))
  );
  const compatibleProfile = preferredProfile?.supported
    ? preferredProfile
    : compatibleLoggedInProfile || candidateProfiles.find((profile) => profile.supported);
  const compatibleRuntime = candidateRuntimes.find((runtime) => runtime.supported);

  if (input.site && compatibleProfile && compatibleProfile.loginStatus !== 'logged_in') {
    return {
      decision: 'needs_manual_login',
      recommendedRuntimeId: compatibleProfile.runtimeId || compatibleRuntime?.runtimeId,
      recommendedProfileId: compatibleProfile.profileId,
      candidateRuntimes,
      candidateProfiles,
      requiredCapabilities,
      reasons: [
        `Compatible profile ${compatibleProfile.profileId} needs verified login for ${input.site}.`,
        ...compatibleProfile.reasons,
      ],
      recommendedAction:
        'Call profile_ensure_logged_in and request human handoff before browser work that depends on this site login.',
      bindingLocked,
    };
  }

  if (compatibleProfile) {
    return {
      decision: 'needs_profile_switch',
      recommendedRuntimeId: compatibleProfile.runtimeId || compatibleRuntime?.runtimeId,
      recommendedProfileId: compatibleProfile.profileId,
      candidateRuntimes,
      candidateProfiles,
      requiredCapabilities,
      reasons: [`Switch to compatible profile ${compatibleProfile.profileId}.`],
      recommendedAction: 'Call session_prepare with the recommended profile before acquiring a browser.',
      bindingLocked,
    };
  }

  return {
    decision: input.allowNewProfile === true ? 'needs_profile_switch' : 'blocked',
    recommendedRuntimeId: compatibleRuntime?.runtimeId,
    candidateRuntimes,
    candidateProfiles,
    requiredCapabilities,
    reasons: [
      input.allowNewProfile === true
        ? 'No existing compatible profile was found; a new profile can be created for the recommended runtime.'
        : 'No existing compatible profile was found and allowNewProfile is false.',
    ],
    recommendedAction:
      input.allowNewProfile === true
        ? 'Create or choose a profile using the recommended runtime, then call session_prepare.'
        : 'Choose an existing compatible profile or allow new profile creation before retrying.',
    bindingLocked,
  };
}

function isHealthyLoginForProfile(
  profileId: string | undefined,
  input: RuntimePlannerInput
): boolean {
  if (!input.site) {
    return true;
  }
  if (!profileId) {
    return false;
  }
  return isHealthyLogin(
    (input.loginStates || []).find(
      (state) => state.profileId === profileId && matchesSite(state, input.site)
    )
  );
}
