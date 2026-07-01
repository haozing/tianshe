export type {
  BrowserRuntimeCreateResult,
  BrowserRuntimeProbeResult,
  BrowserRuntimeProvider,
  ResolveRuntimeInput,
  ResolvedBrowserRuntime,
} from './types';
export { BrowserRuntimeRegistry, createBrowserRuntimeRegistry } from './provider-registry';
export type {
  BrowserRuntimeInstallState,
  BrowserRuntimeStore,
  BrowserRuntimeStoreSnapshot,
  BrowserRuntimeStatus,
} from './runtime-manager';
export {
  BrowserRuntimeManager,
  InMemoryBrowserRuntimeStore,
  createBrowserRuntimeManager,
} from './runtime-manager';
export {
  buildEffectiveRuntimeDescriptorMap,
  getKnownEffectiveRuntimeDescriptor,
} from './effective-descriptor';
export {
  BROWSER_CAPABILITY_CONTRACTS,
  BROWSER_MINIMAL_CORE_METHODS,
  assertBrowserRuntimeDescriptorContract,
  createBrowserRuntimeCapabilityMatrix,
  getBrowserCapabilityContract,
  getMissingBrowserCapabilityContractMethods,
  validateBrowserCapabilityContracts,
  validateBrowserRuntimeDescriptorAgainstContract,
  type BrowserCapabilityContract,
  type BrowserCapabilityContractValidationIssue,
  type BrowserCapabilitySemanticCheck,
  type BrowserRuntimeCapabilityMatrixRow,
} from './capability-contract';
export {
  createBrowserRuntimePlan,
  type BrowserRuntimePlan,
  type BrowserRuntimePlanDecision,
  type ProfileCandidate,
  type RuntimeCandidate,
  type RuntimePlannerInput,
  type RuntimePlannerLoginState,
  type RuntimePlannerProfile,
} from './runtime-planner';
export {
  getRuntimeWindowControlContract,
  getWindowControlContract,
  type BrowserWindowControlCapability,
  type BrowserWindowControlCapabilityDescriptor,
  type BrowserWindowControlContract,
  type BrowserWindowControlSupport,
} from './window-control-contract';
export {
  ProfileSessionGateway,
  ProfileSessionGatewayError,
  createProfileSessionGateway,
  type ProfileSession,
  type ProfileSessionGatewayAcquireOptions,
  type ProfileSessionGatewayAcquireResult,
  type ProfileSessionGatewayErrorCode,
  type ProfileSessionGatewayExecutionContext,
  type ProfileSessionGatewayIntent,
  type ProfileSessionGatewayOptions,
  type ProfileSessionGatewayRequestOptions,
  type ProfileSessionGatewayWithSessionOptions,
} from './profile-session-gateway';
export {
  STATIC_BROWSER_RUNTIME_DESCRIPTORS,
  applyRuntimeCapabilitySupport,
  browserRuntimeSupports,
  cloneBrowserRuntimeDescriptor,
  getStaticRuntimeDescriptor,
} from '../browser-pool/runtime-capability-registry';
