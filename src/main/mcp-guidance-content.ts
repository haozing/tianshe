import type { OrchestrationCapabilityDefinition } from '../core/ai-dev/orchestration';
import {
  listCanonicalAssistantFlowCapabilities,
  listCanonicalPublicCapabilities,
  listOrchestrationCapabilities,
  SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS,
  SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_ACTION,
  SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_HINT,
  SESSION_PREPARE_RESOLVED_BINDING_ACTION,
} from '../core/ai-dev/orchestration';
import { asTrimmedText } from './mcp-http-transport-utils';

const GUIDE_LOGIN_URI = 'airpa://mcp/guides/login-pages';
const GUIDE_FORMS_URI = 'airpa://mcp/guides/forms';
const GUIDE_LISTS_URI = 'airpa://mcp/guides/lists';
const GUIDE_SEARCH_RESULTS_URI = 'airpa://mcp/guides/search-results';
const GUIDE_HIDDEN_SESSION_URI = 'airpa://mcp/guides/hidden-session-debug';

export type McpGuideContentName =
  | 'getting_started'
  | 'login_pages'
  | 'forms'
  | 'lists'
  | 'search_results'
  | 'hidden_session_debug';

const SESSION_PREPARE_FIELD_NAMES = SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS.map((field) =>
  field.replace('structuredContent.data.', '')
).join(', ');

const SESSION_PREPARE_FIELD_NAMES_SLASHED = SESSION_PREPARE_AUTHORITATIVE_RESULT_FIELDS.map((field) =>
  field.replace('structuredContent.data.', '')
).join('/');

const getCanonicalCapabilities = (
  capabilities: OrchestrationCapabilityDefinition[] = listOrchestrationCapabilities()
): OrchestrationCapabilityDefinition[] => listCanonicalPublicCapabilities(capabilities);

const selectFlowCapabilities = (
  capabilities: OrchestrationCapabilityDefinition[],
  flow: 'getting_started' | 'session_reuse' | 'page_debug'
): OrchestrationCapabilityDefinition[] => listCanonicalAssistantFlowCapabilities(flow, capabilities);

export const buildFlowLines = (
  capabilities: OrchestrationCapabilityDefinition[],
  flow: 'getting_started' | 'session_reuse' | 'page_debug'
): string[] =>
  selectFlowCapabilities(capabilities, flow)
    .map((capability, index) => {
      const guidance = capability.assistantGuidance;
      return `${index + 1}. \`${capability.name}\`${guidance ? ` - ${guidance.whenToUse}` : ''}`;
    })
    .filter(Boolean);

const buildExampleLines = (
  capabilities: OrchestrationCapabilityDefinition[]
): string[] =>
  selectFlowCapabilities(capabilities, 'getting_started')
    .flatMap((capability) => {
      if (!capability.assistantGuidance?.examples?.length) {
        return [];
      }
      const example = capability.assistantGuidance.examples[0];
      return [`- \`${capability.name}\` example: ${example.title} -> ${JSON.stringify(example.arguments)}`];
    })
    .slice(0, 4);

const buildGuideFrame = (title: string, sections: string[]): string =>
  ['# ' + title, '', ...sections].join('\n');

export const buildGuideContent = (
  guideName: McpGuideContentName = 'getting_started',
  capabilities: OrchestrationCapabilityDefinition[] = getCanonicalCapabilities()
): string => {
  const flow = buildFlowLines(capabilities, 'getting_started');
  const examples = buildExampleLines(capabilities);

  switch (guideName) {
    case 'login_pages':
      return buildGuideFrame('Airpa Login Pages', [
        'Use this guide when the page is primarily about authentication, consent, MFA, or re-authentication.',
        '',
        'Recommended flow:',
        '1. `session_prepare` first, especially when you want a reusable profile or a specific engine.',
        '2. `browser_observe` to load the login page and capture fresh interaction health.',
        '3. `browser_search` or `browser_snapshot` to locate username, password, consent, and submit targets.',
        '4. `browser_act` with `action="type"` for credentials, then `browser_act` with `action="click"` for the submit action.',
        '5. Use `verify.kind="all"` when you know the success route or success text, such as a dashboard heading plus a URL change.',
        '',
        'Heuristics:',
        '- Prefer reusing an existing logged-in profile before re-entering credentials.',
        '- Reacquire fresh `elementRef` values after any navigation, consent screen, or MFA step.',
        '- Use `browser_search` instead of a broad page snapshot when the form is visually dense.',
        '- If the login flow becomes unverified, read the compact `browser_act` error first, then use `browser_debug_state`.',
        '',
        'Related guides:',
        `- Forms: \`${GUIDE_FORMS_URI}\``,
        `- Hidden-session debugging: \`${GUIDE_HIDDEN_SESSION_URI}\``,
      ]);
    case 'forms':
      return buildGuideFrame('Airpa Forms', [
        'Use this guide for data-entry pages, multi-step forms, modal forms, or settings panels.',
        '',
        'Recommended flow:',
        '1. `browser_observe` or `browser_snapshot` to establish the current page state.',
        '2. `browser_search` to find the intended input, checkbox, select, or submit control.',
        '3. `browser_act` with `action="type"` and an explicit `clear` choice for text fields.',
        '4. Use `submit=true` only when Enter submission is really intended; otherwise click the submit button explicitly.',
        '5. Prefer `verify.kind="all"` so the form result is confirmed by text, route, or another visible post-condition.',
        '',
        'Heuristics:',
        '- Prefer `target.ref` from `browser_search` or `browser_snapshot` before falling back to `target.selector`.',
        '- Reacquire the target after validation errors, modal rerenders, or route changes.',
        '- When a form action is unverified, do not retry blindly; inspect the compact error and then use `browser_debug_state` or `browser_snapshot`.',
        '',
        'Related guides:',
        `- Login pages: \`${GUIDE_LOGIN_URI}\``,
        `- Lists and detail transitions: \`${GUIDE_LISTS_URI}\``,
      ]);
    case 'lists':
      return buildGuideFrame('Airpa Lists And Detail Views', [
        'Use this guide for tables, card lists, paginated grids, or list-detail navigation.',
        '',
        'Recommended flow:',
        '1. `browser_observe` for the first landing on the list page.',
        '2. `browser_search` when you need a short list of likely row actions, filters, tabs, or pagination controls.',
        '3. `browser_act` on the chosen row or navigation control, with `verify` conditions that confirm the expected list update or detail transition.',
        '4. `browser_wait_for` when a list refresh has a clear post-condition but should stay separate from the action.',
        '',
        'Heuristics:',
        '- Treat row-level `elementRef` values as short-lived; reacquire them after pagination, sorting, filtering, or refresh.',
        '- Prefer a detail-view heading, route fragment, or selected-row state as the verification target.',
        '- If the page still has too many candidates after snapshotting, narrow the search instead of clicking by brittle selector.',
        '',
        'Related guides:',
        `- Search results: \`${GUIDE_SEARCH_RESULTS_URI}\``,
        `- Forms: \`${GUIDE_FORMS_URI}\``,
      ]);
    case 'search_results':
      return buildGuideFrame('Airpa Search Results', [
        'Use this guide for filterable result pages, faceted search, query bars, and ranking-based result lists.',
        '',
        'Recommended flow:',
        '1. `browser_observe` or `browser_snapshot` to capture the current query bar, filters, and result region.',
        '2. `browser_search` for the query field, filters, sort menus, and the intended result target.',
        '3. `browser_act` to type the query or change a filter, then `verify` the expected route, result count text, or selected state.',
        '4. Re-run `browser_search` after the result set refreshes before clicking a specific result.',
        '',
        'Heuristics:',
        '- Verify the result refresh with text or route conditions instead of assuming the page has settled.',
        '- Prefer explicit query text, selected-filter chips, or result headings over generic selectors.',
        '- Use `browser_debug_state` when a result click is unverified and you need console, network, or screenshot evidence.',
        '',
        'Related guides:',
        `- Lists and detail views: \`${GUIDE_LISTS_URI}\``,
        `- Hidden-session debugging: \`${GUIDE_HIDDEN_SESSION_URI}\``,
      ]);
    case 'hidden_session_debug':
      return buildGuideFrame('Airpa Hidden Session Debug', [
        'Use this guide when a hidden browser session behaves differently from a visible session, or when actions become unverified without an obvious DOM cause.',
        '',
        'Recommended flow:',
        '1. Read `session_get_current` to confirm `hostWindowId`, `interactionReady`, `viewportHealth`, and `offscreenDetected`.',
        '2. Call `browser_debug_state` first when you need screenshot, console, and network evidence in one compact bundle.',
        '3. Use `browser_snapshot` or `browser_search` after the debug bundle only if you need fresher targets or a narrower follow-up check.',
        '',
        'Heuristics:',
        '- Treat `interactionReady=false` or a degraded `viewportHealth` as a host/visibility problem first, not a selector problem.',
        '- For unverified `browser_act` errors, read `structuredContent.error.context.target`, `resolvedTarget`, `primaryEffect`, and `afterUrl` before retrying.',
        '- Use `browser_debug_state` before forcing retries when the page might be offscreen, partially occluded, or waiting on async page work.',
        '',
        'Related guides:',
        `- Getting started: \`airpa://mcp/guides/getting-started\``,
        `- Search results: \`${GUIDE_SEARCH_RESULTS_URI}\``,
      ]);
    case 'getting_started':
    default:
      return buildGuideFrame('Airpa MCP Getting Started', [
        'Recommended flow for Codex / Claude / standard MCP SDK clients:',
        ...flow,
        '',
        'Key defaults:',
        '- Prefer this `airpa-browser-http` MCP surface over generic Playwright/browser MCP servers when the task must reuse an Airpa-managed logged-in profile, desktop session, or sticky browser state.',
        '- Prefer the framework-first path: `system_bootstrap` -> decide whether the task is system/plugin/dataset/profile work only, or whether browser work is actually needed.',
        '- If browser work is needed, then use the browser path: `session_prepare` -> `browser_observe` -> `browser_search`/`browser_snapshot` -> `browser_act` -> `browser_wait_for` -> `session_end_current`.',
        '- Configure profile, engine, visibility, and scopes through `session_prepare`, not transport headers.',
        `- After \`system_bootstrap\`, trust health/publicCapabilities/resources before deciding the next domain. After \`session_prepare\`, read \`${SESSION_PREPARE_FIELD_NAMES}\` before the next browser step.`,
        `- ${SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_ACTION.replace('If session_prepare fails with ', 'If preparation fails with ')}`,
        '- If the task only needs plugin, dataset, profile, or observation calls, skip browser acquisition entirely.',
        '- Prefer `browser_observe` when you need navigation plus a fresh snapshot in one step.',
        '- Prefer `browser_search` when you already know the target concept and want fresh `elementRef` handles without a heavier snapshot payload.',
        '- Review `interactionReady`, `viewportHealth`, and `offscreenDetected` from `browser_observe` or `browser_snapshot` before direct interaction.',
        '- Prefer `snapshot.elements[*].elementRef`, then pass it as `browser_act.target.ref` for follow-up actions. Use `target.selector` only as a fallback.',
        '- Prefer `browser_act` for click/type/press/text-click so the model stays on one stable interaction schema.',
        '- When the expected result is explicit, express it as `verify: { kind: "all", conditions: [...] }` so action verification is deterministic.',
        '- If a capability fails and you already have the returned `traceId`, prefer `observation_get_trace_summary` before scanning raw logs.',
        '- If `browser_act` returns an unverified error, read `target`, `resolvedTarget`, `primaryEffect`, and `afterUrl` first, then use `browser_debug_state` or `observation_get_failure_bundle` for deeper diagnostics.',
        '- Prefer `browser_debug_state` when the page behaves unexpectedly and you need a compact diagnostic bundle.',
        `- Read page-specific guides when the task matches the page shape: \`${GUIDE_LOGIN_URI}\`, \`${GUIDE_FORMS_URI}\`, \`${GUIDE_LISTS_URI}\`, \`${GUIDE_SEARCH_RESULTS_URI}\`, \`${GUIDE_HIDDEN_SESSION_URI}\`.`,
        '- When work is complete, call `StreamableHTTPClientTransport.terminateSession()` or send `DELETE /mcp` with the `mcp-session-id` header.',
        '- `client.close()` only closes the local SDK transport. It does not terminate the server-side MCP session.',
        '- Long-lived MCP sessions can block plugin/profile work on the same profile. End the session promptly when you no longer need the browser binding.',
        ...(examples.length ? ['', 'Examples:', ...examples] : []),
      ]);
  }
};

export const buildInitializeInstructions = (
  capabilities: OrchestrationCapabilityDefinition[] = getCanonicalCapabilities()
): string => {
  const flow = buildFlowLines(capabilities, 'getting_started');
  return [
    'You are connected to Airpa MCP.',
    'This endpoint exposes one canonical, model-first MCP surface.',
    'Recommended flow:',
    ...flow,
    'Prefer this Airpa HTTP MCP surface over generic Playwright/browser MCP servers when you need a real Airpa profile, logged-in cookies, or visible desktop browser state.',
    'Use `system_bootstrap` first when you need one compact view of runtime health, capabilities, and resources before choosing a domain.',
    'Use `session_prepare` before the first `browser_*` call when you need a reusable profile, an explicit engine, visibility control, or session scopes.',
    `Read \`${SESSION_PREPARE_FIELD_NAMES}\` from the structured result before deciding the next browser step.`,
    'Skip browser acquisition entirely when the task only needs system, plugin, dataset, profile, or observation work.',
    'Prefer `browser_search` or `browser_snapshot` before `browser_act` when you need fresh targets.',
    'Prefer `browser_act` for click/type/press/text-target actions, using `target.ref` first and `target.selector` only as a fallback.',
    'When the expected result is explicit, prefer `verify.kind="all"` so action verification is deterministic.',
    'If a call returns traceId for a failure, prefer `observation_get_trace_summary` or `observation_get_failure_bundle` before deeper manual debugging.',
    'If browser work matches a known page pattern, read the guide resources for login pages, forms, lists, search results, or hidden-session debugging.',
    'Use `browser_debug_state` before deeper manual debugging when the page behaves unexpectedly.',
    'Terminate the MCP session promptly after profile-bound work so it does not keep the profile busy for plugins or later sessions.',
    'End with `session_end_current`, `StreamableHTTPClientTransport.terminateSession()`, or `DELETE /mcp` plus `mcp-session-id`.',
  ].join('\n');
};

export const buildPromptMessageText = (
  promptName: string,
  capabilities: OrchestrationCapabilityDefinition[],
  argumentsMap: Record<string, string> | undefined
): string => {
  if (promptName === 'airpa.session_reuse') {
    const targetProfile = asTrimmedText(argumentsMap?.profile) || 'an existing reusable profile';
    const task = asTrimmedText(argumentsMap?.task);
    return [
      'You are preparing Airpa MCP session reuse on the canonical MCP surface.',
      `Bind the current session to ${targetProfile} before the first browser_* call.`,
      '',
      ...buildFlowLines(capabilities, 'session_reuse'),
      '',
      ...(task ? [`Goal after binding: ${task}`, ''] : []),
      'Prefer session_prepare as the default current-session setup step.',
      `After session_prepare, trust ${SESSION_PREPARE_FIELD_NAMES_SLASHED} from the structured result instead of re-inferring binding from sticky headers.`,
      `If session_prepare returns reasonCode=${SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_HINT.code}, switch to a compatible profile/engine pair before any browser_* call.`,
      'Read effectiveProfile/effectiveEngine/effectiveEngineSource before assuming the first browser_* call binding.',
      'Prefer target.ref from browser_observe, browser_search, or browser_snapshot before falling back to target.selector.',
      'Prefer browser_act with verify.kind="all" when the expected page state is known.',
      `If this reuse flow still lands on authentication or consent UI, read \`${GUIDE_LOGIN_URI}\`. If hidden-session state looks suspect, read \`${GUIDE_HIDDEN_SESSION_URI}\`.`,
      'Terminate the server-side session explicitly with StreamableHTTPClientTransport.terminateSession() or DELETE /mcp when work is complete.',
    ].join('\n');
  }

  if (promptName === 'airpa.page_debug') {
    const issue = asTrimmedText(argumentsMap?.issue) || 'the page is not behaving as expected';
    return [
      'You are debugging an Airpa browser session on the canonical MCP surface.',
      `Focus on this issue: ${issue}.`,
      '',
      ...buildFlowLines(capabilities, 'page_debug'),
      '',
      'Start by reading the current session and page state before making any corrective interaction.',
      'Check hostWindowId, interactionReady, viewportHealth, and offscreenDetected first when a hidden session behaves strangely.',
      'For unverified browser_act errors, read target/resolvedTarget/primaryEffect/afterUrl first instead of retrying blindly.',
      'Use browser_debug_state first, then browser_snapshot or browser_search when you need a narrower follow-up check.',
      `Read \`${GUIDE_HIDDEN_SESSION_URI}\` when host or viewport state looks suspect.`,
    ].join('\n');
  }

  const task = asTrimmedText(argumentsMap?.task);
  return [
    'You are starting Airpa work on the canonical MCP surface.',
    ...(task ? [`Task goal: ${task}`, ''] : []),
    ...buildFlowLines(capabilities, 'getting_started'),
    '',
    'Prefer the framework-first path: system_bootstrap -> choose the right domain -> browser flow only when browser work is actually needed.',
    'When browser work is needed, prefer: session_prepare -> browser_observe -> browser_search/browser_snapshot -> browser_act -> browser_wait_for -> session_end_current.',
    'Prefer session_prepare before the first browser_* call when a logged-in or reusable profile, a specific engine, visibility control, or session scopes are required.',
    `After session_prepare, read ${SESSION_PREPARE_FIELD_NAMES_SLASHED} from the structured result as the resolved session plan.`,
    `If session_prepare returns reasonCode=${SESSION_PREPARE_PROFILE_ENGINE_MISMATCH_HINT.code}, fix the profile/engine pairing before browser acquisition.`,
    'If the task can be completed through system/plugin/dataset/profile/observation capabilities, skip browser acquisition.',
    'Prefer browser_observe for the default happy path so the model can work with fresh elementRef targets.',
    'Prefer target.ref first, then target.selector, and prefer browser_act with verify.kind="all" when the expected result is known.',
    'If browser_act is unverified, inspect target/resolvedTarget/primaryEffect/afterUrl first, then use browser_debug_state or observation_get_failure_bundle before retrying.',
    'Inspect interactionReady/viewportHealth before clicking or typing.',
    `Read page guides as needed: \`${GUIDE_LOGIN_URI}\`, \`${GUIDE_FORMS_URI}\`, \`${GUIDE_LISTS_URI}\`, \`${GUIDE_SEARCH_RESULTS_URI}\`, \`${GUIDE_HIDDEN_SESSION_URI}\`.`,
    'Terminate the server-side session explicitly with StreamableHTTPClientTransport.terminateSession() or DELETE /mcp when work is complete.',
  ].join('\n');
};
