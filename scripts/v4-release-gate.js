#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CANARY_SUITES,
  buildVitestInvocation: buildBrowserCanaryVitestInvocation,
  buildVitestPlan: buildBrowserCanaryVitestPlan,
  parseArgs: parseBrowserCanaryArgs,
} = require('./browser-canary');
const {
  SITE_ADAPTER_CANARY_EVIDENCE_PATH,
  SITE_ADAPTER_CANARY_SUITES,
  buildVitestInvocation: buildSiteAdapterCanaryVitestInvocation,
  parseArgs: parseSiteAdapterCanaryArgs,
} = require('./site-adapter-canary');
const {
  REQUIRED_APP_ASAR_FILES,
  REQUIRED_UNPACKED_PATHS,
  NATIVE_PROBE_PATHS,
} = require('./package-smoke');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'evidence', 'v4-release-gate', 'latest.json');
const SNAPSHOT_PATH = path.join(ROOT, 'docs', 'generated', 'v4-governance-snapshot.json');
const BROWSER_CANARY_EVIDENCE_PATH = path.join(
  ROOT,
  'docs',
  'evidence',
  'browser-canary',
  'latest.json'
);
const ALLOWED_PUBLIC_DEBUG_SURFACE_NAMES = new Set(['browser_debug_state']);
const ALLOWED_READONLY_WRITE_SCOPE_NAMES = new Set(['dataset_stage_write_plan']);
const FORBIDDEN_PUBLIC_SURFACE_PATTERN =
  /playwright|cdp|devtools|debugger|debug|evaluate|raw|repair_apply|site_adapter_debug|extractor_debug|interactor_debug/i;
const VALID_SIDE_EFFECT_LEVELS = new Set(['none', 'low', 'high']);
const VALID_RUNTIME_STABILITY_LEVELS = new Set(['stable', 'experimental', 'planned']);
const CONFIRMATION_INPUT_FIELDS = new Set(['confirmRisk', 'confirmDelete']);
const PRODUCTION_CORE_RUNTIME_CAPABILITIES = [
  'cookies.read',
  'cookies.write',
  'storage.dom',
  'snapshot.page',
  'input.native',
  'text.dom',
  'network.capture',
  'console.capture',
];
const LAB_RUNTIME_IDS = new Set(['chromium-cloak-playwright']);
const STAGED_DATASET_WRITE_CAPABILITIES = new Set([
  'dataset_stage_write_plan',
  'dataset_commit_write_plan',
]);
const FORBIDDEN_PUBLIC_DATASET_ROW_MUTATION_PATTERNS = [
  /^dataset_(insert|update|upsert)_records?$/i,
  /^dataset_(batch_)?(insert|update|upsert)(_records|_rows)?$/i,
  /^dataset_(hard_)?delete_(records|rows)$/i,
  /^dataset_(batch_)?delete_(records|rows)$/i,
];

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function firstExisting(candidates = []) {
  return candidates.find(fileExists) || null;
}

function cloakCacheCandidates() {
  const home = os.homedir();
  const cacheRoot = home ? path.join(home, '.cloakbrowser') : '';
  if (!cacheRoot || !fs.existsSync(cacheRoot)) {
    return [];
  }
  try {
    return fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      .map((entry) => path.join(cacheRoot, entry.name, process.platform === 'win32' ? 'chrome.exe' : 'chrome'));
  } catch {
    return [];
  }
}

function commonRuntimeCandidates() {
  const candidates = {
    chrome: [],
    firefox: [],
    electron: [],
    cloak: [],
  };
  if (process.platform === 'win32') {
    candidates.chrome.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    );
    candidates.firefox.push(
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
    );
    if (process.env.LOCALAPPDATA) {
      candidates.chrome.push(
        path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.chrome.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.firefox.push('/Applications/Firefox.app/Contents/MacOS/firefox');
  } else {
    candidates.chrome.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
    candidates.firefox.push('/usr/bin/firefox');
  }
  try {
    const electronExecutable = require('electron');
    if (typeof electronExecutable === 'string') {
      candidates.electron.push(electronExecutable);
    }
  } catch {
    // Electron is an optional canary runtime in release checks; absence is reported below.
  }
  try {
    const cloakbrowser = require('cloakbrowser');
    const binaryInfo =
      cloakbrowser && typeof cloakbrowser.binaryInfo === 'function'
        ? cloakbrowser.binaryInfo()
        : null;
    const cloakExecutable =
      binaryInfo && typeof binaryInfo === 'object'
        ? binaryInfo.path || binaryInfo.executablePath || binaryInfo.binaryPath
        : null;
    if (typeof cloakExecutable === 'string') {
      candidates.cloak.push(cloakExecutable);
    }
  } catch {
    // CloakBrowser may be ESM-only or its binary may not be installed yet.
  }
  candidates.cloak.push(...cloakCacheCandidates());
  return candidates;
}

function runtimeCandidates(root, options = {}) {
  const common = options.includeSystemPaths === false
    ? { chrome: [], firefox: [], electron: [], cloak: [] }
    : commonRuntimeCandidates();
  return {
    chrome: [
      path.join(root, 'client', 'chrome', 'chrome.exe'),
      path.join(root, 'client', 'chrome', 'chrome'),
      path.join(root, 'chrome', 'chrome.exe'),
      path.join(root, 'chrome', 'chrome'),
      process.env.AIRPA_CHROME_PATH,
      ...common.chrome,
    ].filter(Boolean),
    firefox: [
      path.join(root, 'client', 'firefox', 'firefox.exe'),
      path.join(root, 'client', 'firefox', 'firefox'),
      path.join(root, 'firefox', 'firefox.exe'),
      path.join(root, 'firefox', 'firefox'),
      process.env.AIRPA_FIREFOX_PATH,
      process.env.TIANSHI_FIREFOX_PATH,
      process.env.TIANSHE_FIREFOX_PATH,
      ...common.firefox,
    ].filter(Boolean),
    electron: [
      process.env.AIRPA_ELECTRON_PATH,
      process.env.TIANSHE_ELECTRON_PATH,
      ...common.electron,
    ].filter(Boolean),
    cloak: [
      path.join(root, 'client', 'cloakbrowser', 'chrome.exe'),
      path.join(root, 'client', 'cloakbrowser', 'chrome'),
      path.join(root, 'client', 'cloak', 'chrome.exe'),
      path.join(root, 'client', 'cloak', 'chrome'),
      path.join(root, 'cloakbrowser', 'chrome.exe'),
      path.join(root, 'cloakbrowser', 'chrome'),
      path.join(root, 'cloak', 'chrome.exe'),
      path.join(root, 'cloak', 'chrome'),
      path.join(root, 'runtimes', 'cloakbrowser', 'chrome.exe'),
      path.join(root, 'runtimes', 'cloakbrowser', 'chrome'),
      process.env.AIRPA_CLOAKBROWSER_PATH,
      process.env.AIRPA_CLOAK_BROWSER_PATH,
      process.env.TIANSHE_CLOAKBROWSER_PATH,
      process.env.TIANSHE_CLOAK_BROWSER_PATH,
      ...common.cloak,
    ].filter(Boolean),
  };
}

function checkRuntimeInstall(root = ROOT, options = {}) {
  const candidates = runtimeCandidates(root, options);
  const chromePath = firstExisting(candidates.chrome);
  const firefoxPath = firstExisting(candidates.firefox);
  const electronPath = firstExisting(candidates.electron);
  const cloakPath = firstExisting(candidates.cloak);
  const runtimes = [
    {
      id: 'chrome',
      installed: Boolean(chromePath),
      path: chromePath,
      candidates: candidates.chrome,
      remediation:
        'Install or unpack the Chrome runtime to chrome/chrome.exe, or set AIRPA_CHROME_PATH.',
    },
    {
      id: 'firefox',
      installed: Boolean(firefoxPath),
      path: firefoxPath,
      candidates: candidates.firefox,
      remediation:
        'Install or unpack the Firefox runtime to firefox/firefox.exe, or set AIRPA_FIREFOX_PATH/TIANSHE_FIREFOX_PATH.',
    },
    {
      id: 'electron',
      installed: Boolean(electronPath),
      path: electronPath,
      candidates: candidates.electron,
      remediation: 'Install npm dependencies so the electron package exposes an executable.',
    },
    {
      id: 'cloak',
      installed: Boolean(cloakPath),
      path: cloakPath,
      candidates: candidates.cloak,
      remediation:
        'Install CloakBrowser with `npx cloakbrowser install`, launch once to download it, or set AIRPA_CLOAKBROWSER_PATH.',
    },
  ];
  const missing = runtimes.filter((runtime) => !runtime.installed);
  return {
    status: missing.length === 0 ? 'ok' : 'environment_gap',
    runtimes,
    missing: missing.map((runtime) => ({
      id: runtime.id,
      remediation: runtime.remediation,
      candidates: runtime.candidates,
    })),
  };
}

function readGovernanceSnapshot(snapshotPath = SNAPSHOT_PATH) {
  if (!fileExists(snapshotPath)) {
    return {
      status: 'missing',
      path: path.relative(ROOT, snapshotPath).replace(/\\/g, '/'),
      remediation: 'Run npm run v4:snapshots before release.',
    };
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const capabilityMatrix = Array.isArray(snapshot.runtimeDescriptor?.capabilityMatrix)
    ? snapshot.runtimeDescriptor.capabilityMatrix
    : [];
  const capabilityNames = Array.isArray(snapshot.runtimeDescriptor?.browserCapabilityNames)
    ? snapshot.runtimeDescriptor.browserCapabilityNames
    : [];
  const expectedRuntimeCount = 4;
  const hasRuntimeCapabilityMatrix =
    capabilityNames.length > 0 &&
    capabilityMatrix.length >= capabilityNames.length * expectedRuntimeCount;
  const cloakResponseBody = capabilityMatrix.find(
    (row) =>
      row?.runtimeId === 'chromium-cloak-playwright' &&
      row?.capabilityName === 'network.responseBody'
  );
  const cloakDynamicDescriptor =
    cloakResponseBody?.supported === true && cloakResponseBody?.source === 'runtime';
  const defaultSurfaceRejectsRawPlaywright =
    snapshot.mcpPublicSurface?.defaultSurfaceRejectsRawPlaywright === true;
  const publicSurfacePolicy = evaluatePublicSurfacePolicy(snapshot);
  const sideEffectPolicy = evaluateSideEffectPolicy(snapshot);
  const datasetProvenancePolicy = evaluateDatasetProvenancePolicy(snapshot);
  const runtimeMaturityPolicy = evaluateRuntimeMaturityPolicy(snapshot);
  const repairScopeMatrixOk = snapshot.repairScope?.siteAdapterRegistryMatrix?.ok === true;
  return {
    status:
      publicSurfacePolicy.status === 'ok' &&
      sideEffectPolicy.status === 'ok' &&
      datasetProvenancePolicy.status === 'ok' &&
      runtimeMaturityPolicy.status === 'ok' &&
      hasRuntimeCapabilityMatrix &&
      cloakDynamicDescriptor &&
      repairScopeMatrixOk
        ? 'ok'
        : 'failed',
    path: path.relative(ROOT, snapshotPath).replace(/\\/g, '/'),
    generatedAt: snapshot.generatedAt,
    publicCapabilityTotal: snapshot.mcpPublicSurface?.total,
    siteCapabilities: snapshot.capabilityCatalog?.siteCapabilityNames || [],
    defaultSurfaceRejectsRawPlaywright,
    publicSurfacePolicy,
    sideEffectPolicy,
    datasetProvenancePolicy,
    runtimeMaturityPolicy,
    hasRuntimeCapabilityMatrix,
    cloakDynamicDescriptor,
    repairScopeMatrixOk,
  };
}

function evaluatePublicSurfacePolicy(snapshot) {
  const publicNames = Array.isArray(snapshot.mcpPublicSurface?.names)
    ? snapshot.mcpPublicSurface.names
    : [];
  const rawPlaywrightSurfaceNames = Array.isArray(
    snapshot.mcpPublicSurface?.rawPlaywrightSurfaceNames
  )
    ? snapshot.mcpPublicSurface.rawPlaywrightSurfaceNames
    : publicNames.filter((name) => /playwright|evaluate/i.test(String(name || '')));
  const forbiddenPublicSurfaceNames = publicNames.filter((name) => {
    const normalized = String(name || '');
    return (
      FORBIDDEN_PUBLIC_SURFACE_PATTERN.test(normalized) &&
      !ALLOWED_PUBLIC_DEBUG_SURFACE_NAMES.has(normalized)
    );
  });
  const allowedDebugSurfaceNames = publicNames.filter((name) =>
    ALLOWED_PUBLIC_DEBUG_SURFACE_NAMES.has(String(name || ''))
  );
  const status =
    rawPlaywrightSurfaceNames.length === 0 && forbiddenPublicSurfaceNames.length === 0
      ? 'ok'
      : 'failed';
  return {
    status,
    rawPlaywrightSurfaceNames,
    forbiddenPublicSurfaceNames,
    allowedDebugSurfaceNames,
    allowlist: Array.from(ALLOWED_PUBLIC_DEBUG_SURFACE_NAMES).sort(),
  };
}

function hasWriteScope(capability) {
  return Array.isArray(capability.requiredScopes)
    ? capability.requiredScopes.some((scope) => /\.write$/.test(String(scope || '')))
    : false;
}

function hasConfirmationField(capability) {
  return Array.isArray(capability.inputFields)
    ? capability.inputFields.some((field) => CONFIRMATION_INPUT_FIELDS.has(String(field || '')))
    : false;
}

function hasConfirmationPolicy(capability) {
  if (capability?.sideEffectLevel === 'high' || capability?.destructiveHint === true) {
    return true;
  }
  const conditions = capability?.confirmationPolicy?.requiredWhen;
  return Array.isArray(conditions) && conditions.length > 0;
}

function hasInputField(capability, fieldName) {
  return Array.isArray(capability?.inputFields)
    ? capability.inputFields.includes(fieldName)
    : false;
}

function hasRequiredScope(capability, scopeName) {
  return Array.isArray(capability?.requiredScopes)
    ? capability.requiredScopes.includes(scopeName)
    : false;
}

function evaluateSideEffectPolicy(snapshot) {
  const publicCapabilities = Array.isArray(snapshot.capabilityCatalog?.publicCapabilities)
    ? snapshot.capabilityCatalog.publicCapabilities
    : null;
  if (!publicCapabilities) {
    return {
      status: 'failed',
      missingSnapshotData: true,
      remediation: 'Run npm run v4:snapshots with capability policy metadata support.',
      missingPolicy: [],
      missingScopes: [],
      highRiskMissingWriteScope: [],
      highRiskMissingConfirmationPolicy: [],
      forbiddenConfirmationFields: [],
      datasetCommitMissingConfirmation: [],
      writeScopeMarkedReadOnly: [],
    };
  }

  const missingPolicy = publicCapabilities
    .filter((capability) => !VALID_SIDE_EFFECT_LEVELS.has(String(capability.sideEffectLevel || '')))
    .map((capability) => capability.name);
  const missingScopes = publicCapabilities
    .filter(
      (capability) =>
        !Array.isArray(capability.requiredScopes) || capability.requiredScopes.length === 0
    )
    .map((capability) => capability.name);
  const highRisk = publicCapabilities.filter(
    (capability) => capability.sideEffectLevel === 'high'
  );
  const highRiskMissingWriteScope = highRisk
    .filter((capability) => !hasWriteScope(capability))
    .map((capability) => capability.name);
  const highRiskMissingConfirmationPolicy = highRisk
    .filter((capability) => !hasConfirmationPolicy(capability))
    .map((capability) => capability.name);
  const forbiddenConfirmationFields = publicCapabilities
    .filter((capability) => hasConfirmationField(capability))
    .map((capability) => capability.name);
  const datasetCommitMissingConfirmationPolicy = publicCapabilities
    .filter(
      (capability) =>
        capability.name === 'dataset_commit_write_plan' ||
        (Array.isArray(capability.inputFields) &&
          capability.inputFields.includes('commitDatasetWrite'))
    )
    .filter((capability) => !hasConfirmationPolicy(capability))
    .map((capability) => capability.name);
  const writeScopeMarkedReadOnly = publicCapabilities
    .filter(
      (capability) =>
        capability.sideEffectLevel === 'none' &&
        hasWriteScope(capability) &&
        !ALLOWED_READONLY_WRITE_SCOPE_NAMES.has(String(capability.name || ''))
    )
    .map((capability) => capability.name);
  const status =
    missingPolicy.length === 0 &&
    missingScopes.length === 0 &&
    highRiskMissingWriteScope.length === 0 &&
    highRiskMissingConfirmationPolicy.length === 0 &&
    forbiddenConfirmationFields.length === 0 &&
    datasetCommitMissingConfirmationPolicy.length === 0 &&
    writeScopeMarkedReadOnly.length === 0
      ? 'ok'
      : 'failed';

  return {
    status,
    publicCapabilityTotal: publicCapabilities.length,
    missingPolicy,
    missingScopes,
    highRiskMissingWriteScope,
    highRiskMissingConfirmationPolicy,
    highRiskMissingConfirmation: highRiskMissingConfirmationPolicy,
    forbiddenConfirmationFields,
    datasetCommitMissingConfirmationPolicy,
    datasetCommitMissingConfirmation: datasetCommitMissingConfirmationPolicy,
    writeScopeMarkedReadOnly,
    allowedReadOnlyWriteScopeNames: Array.from(ALLOWED_READONLY_WRITE_SCOPE_NAMES).sort(),
  };
}

function evaluateDatasetProvenancePolicy(snapshot) {
  const publicCapabilities = Array.isArray(snapshot.capabilityCatalog?.publicCapabilities)
    ? snapshot.capabilityCatalog.publicCapabilities
    : null;
  if (!publicCapabilities) {
    return {
      status: 'failed',
      missingSnapshotData: true,
      remediation: 'Run npm run v4:snapshots with public capability input metadata support.',
      forbiddenPublicRowMutationNames: [],
      missingStagedCapabilities: [],
      stageWritePlanMissingProvenance: [],
      commitWritePlanMissingPlanInput: [],
      commitWritePlanMissingProvenance: [],
      commitWritePlanMissingConfirmationPolicy: [],
      forbiddenConfirmationFields: [],
      siteDatasetWriteCapabilities: [],
      siteDatasetWriteMissingStagedCommit: [],
      siteDatasetWriteMissingConfirmationPolicy: [],
    };
  }

  const byName = new Map(
    publicCapabilities.map((capability) => [String(capability.name || ''), capability])
  );
  const forbiddenPublicRowMutationNames = publicCapabilities
    .map((capability) => String(capability.name || ''))
    .filter((name) =>
      FORBIDDEN_PUBLIC_DATASET_ROW_MUTATION_PATTERNS.some((pattern) => pattern.test(name))
    );
  const missingStagedCapabilities = [...STAGED_DATASET_WRITE_CAPABILITIES].filter(
    (name) => !byName.has(name)
  );
  const stageCapability = byName.get('dataset_stage_write_plan');
  const commitCapability = byName.get('dataset_commit_write_plan');
  const stageWritePlanMissingProvenance =
    stageCapability && !hasInputField(stageCapability, 'provenance')
      ? ['dataset_stage_write_plan']
      : [];
  const commitWritePlanMissingPlanInput =
    commitCapability && !hasInputField(commitCapability, 'plan')
      ? ['dataset_commit_write_plan']
      : [];
  const commitWritePlanMissingProvenance =
    commitCapability && !hasInputField(commitCapability, 'provenance')
      ? ['dataset_commit_write_plan']
      : [];
  const commitWritePlanMissingConfirmationPolicy =
    commitCapability && !hasConfirmationPolicy(commitCapability)
      ? ['dataset_commit_write_plan']
      : [];
  const forbiddenConfirmationFields = publicCapabilities
    .filter((capability) => hasConfirmationField(capability))
    .map((capability) => capability.name);
  const siteDatasetWriteCapabilities = publicCapabilities.filter(
    (capability) =>
      hasRequiredScope(capability, 'dataset.write') &&
      hasInputField(capability, 'datasetId') &&
      !String(capability.name || '').startsWith('dataset_')
  );
  const siteDatasetWriteMissingStagedCommit = siteDatasetWriteCapabilities
    .filter((capability) => !hasInputField(capability, 'commitDatasetWrite'))
    .map((capability) => capability.name);
  const siteDatasetWriteMissingConfirmationPolicy = siteDatasetWriteCapabilities
    .filter((capability) => !hasConfirmationPolicy(capability))
    .map((capability) => capability.name);
  const status =
    forbiddenPublicRowMutationNames.length === 0 &&
    missingStagedCapabilities.length === 0 &&
    stageWritePlanMissingProvenance.length === 0 &&
    commitWritePlanMissingPlanInput.length === 0 &&
    commitWritePlanMissingProvenance.length === 0 &&
    commitWritePlanMissingConfirmationPolicy.length === 0 &&
    forbiddenConfirmationFields.length === 0 &&
    siteDatasetWriteMissingStagedCommit.length === 0 &&
    siteDatasetWriteMissingConfirmationPolicy.length === 0
      ? 'ok'
      : 'failed';

  return {
    status,
    publicCapabilityTotal: publicCapabilities.length,
    forbiddenPublicRowMutationNames,
    missingStagedCapabilities,
    stageWritePlanMissingProvenance,
    commitWritePlanMissingPlanInput,
    commitWritePlanMissingProvenance,
    commitWritePlanMissingConfirmationPolicy,
    commitWritePlanMissingConfirmation: commitWritePlanMissingConfirmationPolicy,
    forbiddenConfirmationFields,
    siteDatasetWriteCapabilities: siteDatasetWriteCapabilities.map((capability) => capability.name),
    siteDatasetWriteMissingStagedCommit,
    siteDatasetWriteMissingConfirmationPolicy,
    siteDatasetWriteMissingConfirmation: siteDatasetWriteMissingConfirmationPolicy,
  };
}

function rowKey(row) {
  return `${String(row?.runtimeId || 'unknown')}:${String(row?.capabilityName || 'unknown')}`;
}

function countRowsBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function evaluateRuntimeMaturityPolicy(snapshot) {
  const capabilityMatrix = Array.isArray(snapshot.runtimeDescriptor?.capabilityMatrix)
    ? snapshot.runtimeDescriptor.capabilityMatrix
    : null;
  const capabilityNames = Array.isArray(snapshot.runtimeDescriptor?.browserCapabilityNames)
    ? snapshot.runtimeDescriptor.browserCapabilityNames
    : [];
  if (!capabilityMatrix) {
    return {
      status: 'failed',
      missingSnapshotData: true,
      remediation: 'Run npm run v4:snapshots with runtime capability matrix support.',
      invalidStability: [],
      supportedPlanned: [],
      productionCoreMissingStableRuntime: [...PRODUCTION_CORE_RUNTIME_CAPABILITIES],
      labRuntimeDynamicStable: [],
    };
  }

  const rows = capabilityMatrix.map((row) => ({
    runtimeId: String(row?.runtimeId || ''),
    capabilityName: String(row?.capabilityName || ''),
    supported: row?.supported === true,
    stability: String(row?.stability || ''),
    source: String(row?.source || ''),
    semanticChecks: Array.isArray(row?.semanticChecks) ? row.semanticChecks : [],
  }));
  const expectedRows = capabilityNames.length * 4;
  const hasFullMatrix = capabilityNames.length > 0 && rows.length >= expectedRows;
  const invalidStability = rows
    .filter((row) => !VALID_RUNTIME_STABILITY_LEVELS.has(row.stability))
    .map(rowKey);
  const supportedPlanned = rows
    .filter((row) => row.supported && row.stability === 'planned')
    .map(rowKey);
  const supportedWithoutSemanticChecks = rows
    .filter((row) => row.supported && row.semanticChecks.length === 0)
    .map(rowKey);
  const productionCoreCoverage = PRODUCTION_CORE_RUNTIME_CAPABILITIES.map((capabilityName) => {
    const stableRuntimeIds = rows
      .filter(
        (row) =>
          row.capabilityName === capabilityName &&
          row.supported &&
          row.stability === 'stable'
      )
      .map((row) => row.runtimeId)
      .sort();
    return { capabilityName, stableRuntimeIds };
  });
  const productionCoreMissingStableRuntime = productionCoreCoverage
    .filter((item) => item.stableRuntimeIds.length === 0)
    .map((item) => item.capabilityName);
  const labRuntimeDynamicStable = rows
    .filter(
      (row) =>
        LAB_RUNTIME_IDS.has(row.runtimeId) &&
        row.source === 'runtime' &&
        row.supported &&
        row.stability === 'stable'
    )
    .map(rowKey);
  const labRuntimeDynamicExperimental = rows
    .filter(
      (row) =>
        LAB_RUNTIME_IDS.has(row.runtimeId) &&
        row.source === 'runtime' &&
        row.supported &&
        row.stability === 'experimental'
    )
    .map(rowKey);
  const status =
    hasFullMatrix &&
    invalidStability.length === 0 &&
    supportedPlanned.length === 0 &&
    supportedWithoutSemanticChecks.length === 0 &&
    productionCoreMissingStableRuntime.length === 0 &&
    labRuntimeDynamicStable.length === 0
      ? 'ok'
      : 'failed';

  return {
    status,
    totalRows: rows.length,
    expectedRows,
    hasFullMatrix,
    stabilityCounts: countRowsBy(rows, (row) => row.stability || 'missing'),
    supportedStabilityCounts: countRowsBy(
      rows.filter((row) => row.supported),
      (row) => row.stability || 'missing'
    ),
    invalidStability,
    supportedPlanned,
    supportedWithoutSemanticChecks,
    productionCoreCapabilities: [...PRODUCTION_CORE_RUNTIME_CAPABILITIES],
    productionCoreCoverage,
    productionCoreMissingStableRuntime,
    labRuntimeIds: Array.from(LAB_RUNTIME_IDS).sort(),
    labRuntimeDynamicStable,
    labRuntimeDynamicExperimental,
  };
}

function readBrowserCanaryEvidence(evidencePath = BROWSER_CANARY_EVIDENCE_PATH) {
  if (!fileExists(evidencePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    return {
      status: 'failed',
      path: path.relative(ROOT, evidencePath).replace(/\\/g, '/'),
      error: 'Failed to parse browser canary evidence JSON.',
    };
  }
}

function evidenceCoversAllSuites(evidence) {
  if (!evidence || evidence.runtime !== 'all' || !Array.isArray(evidence.suites)) {
    return false;
  }
  const suites = new Set(evidence.suites);
  return CANARY_SUITES.every((suite) => suites.has(suite.id));
}

function buildCanaryGate(runtimeInstall = checkRuntimeInstall(), options = {}) {
  const dryRunOptions = parseBrowserCanaryArgs(['--dry-run']);
  const dryRun = buildBrowserCanaryVitestInvocation(dryRunOptions);
  const dryRunPlan = buildBrowserCanaryVitestPlan(dryRunOptions);
  const latestEvidence = readBrowserCanaryEvidence(options.evidencePath);
  const hasPassingAllEvidence =
    latestEvidence?.status === 'passed' && evidenceCoversAllSuites(latestEvidence);
  const hasFailedAllEvidence =
    latestEvidence?.status === 'failed' && evidenceCoversAllSuites(latestEvidence);
  const status =
    runtimeInstall.status === 'environment_gap'
      ? 'environment_gap'
      : hasPassingAllEvidence
        ? 'passed'
        : hasFailedAllEvidence
          ? 'failed'
          : 'configured';
  return {
    status,
    suites: CANARY_SUITES.map((suite) => ({
      id: suite.id,
      env: suite.env,
      file: suite.file,
    })),
    coverage: [
      'browser pool acquire/release/recreate',
      'electron-webcontents hidden partition cookie/localStorage persistence',
      'extension runtime business flow',
      'firefox-bidi runtime business flow',
      'cloak runtime pool acquire/release/recreate when AIRPA_RUN_CLOAK_CANARY is enabled',
      'profile cookie/localStorage persistence across acquire and recreate',
    ],
    environmentGaps:
      runtimeInstall.status === 'environment_gap' ? runtimeInstall.missing : [],
    dryRun: {
      command: dryRun.command,
      args: dryRun.args,
      invocations: dryRunPlan.invocations.map((invocation) => ({
        id: invocation.id,
        suiteIds: invocation.suiteIds,
        command: invocation.command,
        args: invocation.args,
      })),
      suites: dryRun.suites.map((suite) => suite.id),
    },
    latestEvidence: latestEvidence
      ? {
          status: latestEvidence.status,
          runtime: latestEvidence.runtime,
          generatedAt: latestEvidence.generatedAt,
          suites: latestEvidence.suites,
          command: latestEvidence.command,
          args: latestEvidence.args,
          invocations: latestEvidence.invocations,
          code: latestEvidence.code,
        }
      : null,
    evidenceCommand:
      'npm run test:browser-canary -- --runtime all',
  };
}

function readSiteAdapterCanaryEvidence(evidencePath = SITE_ADAPTER_CANARY_EVIDENCE_PATH) {
  if (!fileExists(evidencePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    return {
      status: 'failed',
      path: path.relative(ROOT, evidencePath).replace(/\\/g, '/'),
      error: 'Failed to parse site adapter canary evidence JSON.',
    };
  }
}

function siteAdapterEvidenceCoversAllSuites(evidence) {
  if (!evidence || !Array.isArray(evidence.suites)) {
    return false;
  }
  const suites = new Set(evidence.suites);
  return SITE_ADAPTER_CANARY_SUITES.every((suite) => suites.has(suite.id));
}

function buildSiteAdapterCanaryGate(options = {}) {
  const dryRun = buildSiteAdapterCanaryVitestInvocation(
    parseSiteAdapterCanaryArgs(['--dry-run'])
  );
  const latestEvidence = readSiteAdapterCanaryEvidence(
    options.evidencePath || SITE_ADAPTER_CANARY_EVIDENCE_PATH
  );
  const hasAllSuites = siteAdapterEvidenceCoversAllSuites(latestEvidence);
  const hasPassingAllEvidence = latestEvidence?.status === 'passed' && hasAllSuites;
  const hasFailedEvidence = latestEvidence?.status === 'failed';
  const status = hasPassingAllEvidence
    ? 'passed'
    : hasFailedEvidence
      ? 'failed'
      : latestEvidence
        ? 'incomplete'
        : 'missing';

  return {
    status,
    suites: SITE_ADAPTER_CANARY_SUITES.map((suite) => ({
      id: suite.id,
      file: suite.file,
      coverage: suite.coverage,
    })),
    coverage: Array.from(new Set(SITE_ADAPTER_CANARY_SUITES.flatMap((suite) => suite.coverage))),
    dryRun: {
      command: dryRun.command,
      args: dryRun.args,
      suites: dryRun.suites.map((suite) => suite.id),
    },
    latestEvidence: latestEvidence
      ? {
          status: latestEvidence.status,
          suite: latestEvidence.suite,
          generatedAt: latestEvidence.generatedAt,
          suites: latestEvidence.suites,
          command: latestEvidence.command,
          args: latestEvidence.args,
          code: latestEvidence.code,
          hasAllSuites,
        }
      : null,
    evidenceCommand: 'npm run test:site-adapter-canary -- --suite all',
    remediation: hasPassingAllEvidence
      ? null
      : 'Run npm run test:site-adapter-canary -- --suite all before npm run v4:release-gate.',
  };
}

function buildPackageGate() {
  return {
    status: 'configured',
    evidenceCommand: 'npm run test:package-smoke',
    requiredAppAsarFiles: [...REQUIRED_APP_ASAR_FILES],
    requiredUnpackedPaths: [...REQUIRED_UNPACKED_PATHS],
    nativeProbePaths: [...NATIVE_PROBE_PATHS],
  };
}

function pathStatus(root, relativePath) {
  return {
    path: relativePath,
    exists: fs.existsSync(path.join(root, relativePath)),
  };
}

function buildAdapterGate(root = ROOT) {
  const adapters = [
    {
      id: 'books-to-scrape',
      capability: 'books_to_scrape.extract_product',
      requiredChecks: [
        'manifest schema',
        'import boundary',
        'fixture runner',
        'browser-snapshot runtime canary',
        'low-risk procedure runner',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/books-to-scrape/books-to-scrape.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/books-to-scrape/adapter.ts',
        'src/site-adapters/books-to-scrape/procedures/save-search-draft.ts',
        'src/site-adapters/books-to-scrape/fixtures/product-page.json',
        'src/site-adapters/books-to-scrape/expected/product-page.json',
      ],
    },
    {
      id: 'github-profile',
      capability: 'github.extract_profile_summary',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'login handoff',
        'login verifier evidence',
        'low-risk login Procedure runner',
        'low-risk issue draft Procedure runner',
        'high-risk issue Procedure confirmation gate',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/github-profile/github-profile.test.ts',
        'npx vitest run src/core/ai-dev/capabilities/site-capability-catalog.test.ts',
      ],
      paths: [
        'src/site-adapters/github-profile/adapter.ts',
        'src/site-adapters/github-profile/procedures/open-profile-settings.ts',
        'src/site-adapters/github-profile/procedures/prepare-issue-draft.ts',
        'src/site-adapters/github-profile/procedures/create-issue.ts',
        'src/site-adapters/github-profile/fixtures/profile-settings.json',
        'src/site-adapters/github-profile/expected/profile-settings.json',
      ],
    },
    {
      id: 'quotes-to-scrape',
      capability: 'quotes_to_scrape.extract_quote_list',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'quality fields',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/official-readonly-adapters.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/quotes-to-scrape/adapter.ts',
        'src/site-adapters/quotes-to-scrape/fixtures/quotes-page-1.json',
        'src/site-adapters/quotes-to-scrape/expected/quotes-page-1.json',
      ],
    },
    {
      id: 'hacker-news',
      capability: 'hacker_news.extract_story_list',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'quality fields',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/official-readonly-adapters.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/hacker-news/adapter.ts',
        'src/site-adapters/hacker-news/fixtures/front-page.json',
        'src/site-adapters/hacker-news/expected/front-page.json',
      ],
    },
    {
      id: 'wikipedia-article',
      capability: 'wikipedia.extract_article_summary',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'quality fields',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/official-readonly-adapters.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/wikipedia-article/adapter.ts',
        'src/site-adapters/wikipedia-article/fixtures/ada-lovelace.json',
        'src/site-adapters/wikipedia-article/expected/ada-lovelace.json',
      ],
    },
    {
      id: 'open-library',
      capability: 'open_library.extract_search_results',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'low-risk procedure runner',
        'quality fields',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/open-library/open-library.test.ts',
        'npx vitest run src/site-adapters/official-readonly-adapters.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/open-library/adapter.ts',
        'src/site-adapters/open-library/procedures/prepare-search-draft.ts',
        'src/site-adapters/open-library/fixtures/database-search.json',
        'src/site-adapters/open-library/expected/database-search.json',
      ],
    },
    {
      id: 'npm-package',
      capability: 'npm.extract_package_summary',
      requiredChecks: [
        'manifest schema',
        'fixture runner',
        'quality fields',
        'repairScope allow/deny',
      ],
      evidenceCommands: [
        'npx vitest run src/site-adapters/official-readonly-adapters.test.ts',
        'npx vitest run src/core/ai-dev/capabilities/site-capability-catalog.test.ts',
        'npx vitest run src/core/site-adapter-runtime/repair/repair-scope.test.ts',
      ],
      paths: [
        'src/site-adapters/npm-package/adapter.ts',
        'src/site-adapters/npm-package/fixtures/vite-package.json',
        'src/site-adapters/npm-package/expected/vite-package.json',
      ],
    },
  ].map((adapter) => ({
    ...adapter,
    paths: adapter.paths.map((relativePath) => pathStatus(root, relativePath)),
  }));

  return {
    status: adapters.every((adapter) => adapter.paths.every((item) => item.exists))
      ? 'configured'
      : 'failed',
    adapters,
  };
}

function buildProcedureGate(snapshotPath = SNAPSHOT_PATH) {
  if (!fileExists(snapshotPath)) {
    return {
      status: 'failed',
      path: path.relative(ROOT, snapshotPath).replace(/\\/g, '/'),
      remediation: 'Run npm run v4:snapshots before evaluating official procedures.',
      total: 0,
      procedures: [],
      missingImplementation: [],
      missingVerification: [],
      missingRequiredScopes: [],
      evidenceCommands: [
        'npx vitest run src/core/site-adapter-runtime/procedure.test.ts src/site-adapters/books-to-scrape/books-to-scrape.test.ts src/site-adapters/open-library/open-library.test.ts',
      ],
    };
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const adapters = Array.isArray(snapshot.siteAdapterRegistry?.adapters)
    ? snapshot.siteAdapterRegistry.adapters
    : [];
  const procedures = adapters.flatMap((adapter) =>
    Array.isArray(adapter.procedures)
      ? adapter.procedures.map((procedure) => ({
          adapterId: String(adapter.id || ''),
          id: String(procedure.id || ''),
          sideEffectLevel: String(procedure.sideEffectLevel || ''),
          requiredScopes: Array.isArray(procedure.requiredScopes)
            ? procedure.requiredScopes.map((scope) => String(scope || '')).filter(Boolean)
            : [],
          verification:
            typeof procedure.verification === 'string' && procedure.verification.trim()
              ? procedure.verification
              : null,
          implemented: procedure.implemented === true,
        }))
      : []
  );
  const missingImplementation = procedures
    .filter((procedure) => !procedure.implemented)
    .map((procedure) => `${procedure.adapterId}.${procedure.id}`);
  const missingVerification = procedures
    .filter((procedure) => !procedure.verification)
    .map((procedure) => `${procedure.adapterId}.${procedure.id}`);
  const missingRequiredScopes = procedures
    .filter((procedure) => procedure.requiredScopes.length === 0)
    .map((procedure) => `${procedure.adapterId}.${procedure.id}`);
  const invalidSideEffectLevel = procedures
    .filter((procedure) => !['low', 'high'].includes(procedure.sideEffectLevel))
    .map((procedure) => `${procedure.adapterId}.${procedure.id}`);
  const status =
    procedures.length > 0 &&
    missingImplementation.length === 0 &&
    missingVerification.length === 0 &&
    missingRequiredScopes.length === 0 &&
    invalidSideEffectLevel.length === 0
      ? 'configured'
      : 'failed';

  return {
    status,
    path: path.relative(ROOT, snapshotPath).replace(/\\/g, '/'),
    total: procedures.length,
    procedures,
    missingImplementation,
    missingVerification,
    missingRequiredScopes,
    invalidSideEffectLevel,
    requiredChecks: [
      'manifest procedure declared',
      'runtime procedure implemented',
      'sideEffectLevel low/high',
      'requiredScopes present',
      'verification policy present',
      'runner replay/resume evidence',
      'persistent resume store evidence',
      'repair publish target canary gate',
    ],
    evidenceCommands: [
      'npx vitest run src/core/site-adapter-runtime/procedure.test.ts src/core/site-adapter-runtime/procedure-resume-store.test.ts src/core/site-adapter-runtime/runner.test.ts src/site-adapters/books-to-scrape/books-to-scrape.test.ts src/site-adapters/open-library/open-library.test.ts src/site-adapters/github-profile/github-profile.test.ts',
    ],
  };
}

function buildReleaseGateReport(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const runtimeInstall = checkRuntimeInstall(root);
  const governanceSnapshot = readGovernanceSnapshot(options.snapshotPath || SNAPSHOT_PATH);
  const canary = buildCanaryGate(runtimeInstall, {
    evidencePath: options.browserCanaryEvidencePath || BROWSER_CANARY_EVIDENCE_PATH,
  });
  const packageGate = buildPackageGate();
  const adapterGate = buildAdapterGate(root);
  const procedureGate = buildProcedureGate(options.snapshotPath || SNAPSHOT_PATH);
  const siteAdapterCanaryGate = buildSiteAdapterCanaryGate({
    evidencePath: options.siteAdapterCanaryEvidencePath || SITE_ADAPTER_CANARY_EVIDENCE_PATH,
  });
  const blocking = [
    governanceSnapshot.status === 'failed' ? 'governance_snapshot_failed' : null,
    canary.status === 'failed' ? 'real_canary_failed' : null,
    adapterGate.status === 'failed' ? 'adapter_gate_failed' : null,
    procedureGate.status === 'failed' ? 'procedure_gate_failed' : null,
    siteAdapterCanaryGate.status !== 'passed'
      ? 'site_adapter_canary_missing_or_failed'
      : null,
  ].filter(Boolean);
  const environmentGaps = runtimeInstall.status === 'environment_gap' ? runtimeInstall.missing : [];
  const readyStatus =
    blocking.length > 0
      ? 'failed'
      : environmentGaps.length === 0 && canary.status === 'passed'
        ? 'ready'
        : 'ready_with_environment_notes';

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: readyStatus,
    blocking,
    environmentGaps,
    gates: {
      runtimeInstall,
      governanceSnapshot,
      realCanary: canary,
      packageResource: packageGate,
      adapterRelease: adapterGate,
      procedureRelease: procedureGate,
      siteAdapterCanary: siteAdapterCanaryGate,
    },
  };
}

function writeReport(report, outputPath = OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

function main() {
  const report = buildReleaseGateReport();
  const outputPath = writeReport(report);
  process.stdout.write(
    `[v4-release-gate] wrote ${path.relative(ROOT, outputPath).replace(/\\/g, '/')}\n`
  );
  if (report.status === 'failed') {
    process.exitCode = 1;
  }
}

module.exports = {
  OUTPUT_PATH,
  buildAdapterGate,
  buildCanaryGate,
  buildPackageGate,
  buildProcedureGate,
  buildReleaseGateReport,
  buildSiteAdapterCanaryGate,
  checkRuntimeInstall,
  evaluateDatasetProvenancePolicy,
  evaluateRuntimeMaturityPolicy,
  evaluateSideEffectPolicy,
  readBrowserCanaryEvidence,
  readGovernanceSnapshot,
  readSiteAdapterCanaryEvidence,
  writeReport,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[v4-release-gate] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
