import {
  createStructuredError,
  ErrorCode,
  type StructuredError,
} from '../../../types/error-codes';
import type {
  OrchestrationProfileGateway,
  OrchestrationProfileInfo,
  OrchestrationProfileResolveResult,
} from '../orchestration/types';

const asText = (value: unknown): string => String(value == null ? '' : value).trim();
const normalize = (value: unknown): string => asText(value).toLowerCase();

const toCandidate = (profile: OrchestrationProfileInfo): Record<string, unknown> => ({
  id: asText(profile.id),
  name: asText(profile.name),
  engine: asText(profile.engine),
  status: asText(profile.status),
  ...(asText(profile.partition) ? { partition: asText(profile.partition) } : {}),
});

export interface ProfileResolutionInspection {
  status: 'resolved' | 'not_found' | 'ambiguous';
  query: string;
  matchedBy?: 'id' | 'name';
  profile?: OrchestrationProfileInfo;
  result?: OrchestrationProfileResolveResult;
  candidates: OrchestrationProfileInfo[];
}

export const inspectProfileResolution = async (
  gateway: OrchestrationProfileGateway,
  query: string,
  candidateLimit = 5
): Promise<ProfileResolutionInspection> => {
  const normalizedQuery = asText(query);
  const normalizedNeedle = normalize(query);
  const profiles = await gateway.listProfiles();
  const normalizedProfiles = profiles.map((profile) => ({
    profile,
    id: normalize(profile.id),
    name: normalize(profile.name),
  }));

  const exactId = normalizedProfiles.find((entry) => entry.id === normalizedNeedle);
  if (exactId) {
    return {
      status: 'resolved',
      query: normalizedQuery,
      matchedBy: 'id',
      profile: exactId.profile,
      result: {
        query: normalizedQuery,
        matchedBy: 'id',
        profile: exactId.profile,
      },
      candidates: [exactId.profile],
    };
  }

  const exactNameMatches = normalizedProfiles
    .filter((entry) => entry.name === normalizedNeedle)
    .map((entry) => entry.profile);
  if (exactNameMatches.length === 1) {
    return {
      status: 'resolved',
      query: normalizedQuery,
      matchedBy: 'name',
      profile: exactNameMatches[0],
      result: {
        query: normalizedQuery,
        matchedBy: 'name',
        profile: exactNameMatches[0],
      },
      candidates: exactNameMatches,
    };
  }
  if (exactNameMatches.length > 1) {
    return {
      status: 'ambiguous',
      query: normalizedQuery,
      matchedBy: 'name',
      candidates: exactNameMatches.slice(0, candidateLimit),
    };
  }

  const resolved = await gateway.resolveProfile(normalizedQuery);
  if (resolved?.profile) {
    return {
      status: 'resolved',
      query: normalizedQuery,
      matchedBy: resolved.matchedBy,
      profile: resolved.profile,
      result: resolved,
      candidates: [resolved.profile],
    };
  }

  const fuzzyCandidates = normalizedProfiles
    .filter((entry) => entry.id.includes(normalizedNeedle) || entry.name.includes(normalizedNeedle))
    .map((entry) => entry.profile)
    .slice(0, candidateLimit);
  return {
    status: fuzzyCandidates.length > 1 ? 'ambiguous' : 'not_found',
    query: normalizedQuery,
    candidates: fuzzyCandidates,
  };
};

export const createProfileResolutionError = (
  inspection: ProfileResolutionInspection,
  options: {
    notFoundMessage: string;
    ambiguousMessage?: string;
    recommendedNextTools?: string[];
    authoritativeFields?: string[];
    context?: Record<string, unknown>;
  }
): StructuredError => {
  const isAmbiguous = inspection.status === 'ambiguous';
  const candidates = inspection.candidates.map(toCandidate);
  return createStructuredError(
    ErrorCode.NOT_FOUND,
    isAmbiguous
      ? options.ambiguousMessage || `Profile query is ambiguous: ${inspection.query}`
      : options.notFoundMessage,
    {
      suggestion: isAmbiguous
        ? 'Choose one of the candidate profile ids and retry.'
        : 'Use one of the candidate profile ids, or call profile_list to inspect more profiles.',
      reasonCode: isAmbiguous ? 'profile_query_ambiguous' : 'profile_query_not_matched',
      retryable: true,
      recommendedNextTools: options.recommendedNextTools || ['profile_list', 'profile_resolve'],
      authoritativeFields: options.authoritativeFields,
      candidates,
      nextActionHints: isAmbiguous
        ? ['Retry with one exact profile id from candidates.']
        : ['Retry with an exact profile id, or inspect more profiles first.'],
      context: {
        query: inspection.query,
        ...(options.context || {}),
      },
    }
  );
};
