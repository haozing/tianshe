export type SubmitConcurrencyDecision = "hold_at_2" | "eligible_for_canary_3" | "continue_canary_3" | "rollback_to_2";

export interface SubmitConcurrencyRunSnapshot {
  runId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary: Record<string, number>;
}

export interface SubmitConcurrencyEvaluation {
  version: "opportunity-submit-concurrency-evaluation-v1";
  decision: SubmitConcurrencyDecision;
  reasons: string[];
  evaluatedRunIds: string[];
  stableRunCount: number;
  evidence: Record<string, number>;
}

const MIN_BASELINE_HTTP_REQUESTS = 10;
const MAX_BASELINE_THROTTLE_RATIO = 0.05;
const MAX_INTERVAL_FACTOR = 1.25;
const MIN_THROUGHPUT_RETENTION_RATIO = 0.9;

function metric(run: SubmitConcurrencyRunSnapshot, key: string) {
  const value = Number(run.summary?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function throttleRatio(run: SubmitConcurrencyRunSnapshot) {
  return metric(run, "httpRequestAttemptCount") > 0
    ? metric(run, "throttleCount") / metric(run, "httpRequestAttemptCount")
    : 0;
}

function globalThrottleRatio(run: SubmitConcurrencyRunSnapshot) {
  return metric(run, "httpRequestAttemptCount") > 0
    ? metric(run, "globalThrottleCount") / metric(run, "httpRequestAttemptCount")
    : 0;
}

function stableBaselineIssues(run: SubmitConcurrencyRunSnapshot) {
  const issues: string[] = [];
  const stores = metric(run, "totalStoreCount");
  const requests = metric(run, "httpRequestAttemptCount");
  const initialIntervalMs = metric(run, "submitPacingInitialIntervalMs") || 15000;
  const minimumRequests = Math.max(MIN_BASELINE_HTTP_REQUESTS, stores * 2);
  if (run.status !== "ok") issues.push("run_not_ok");
  if (metric(run, "submitTaskConcurrency") !== 2) issues.push("baseline_concurrency_not_2");
  if (stores < 2) issues.push("multi_store_evidence_missing");
  if (requests < minimumRequests) issues.push("http_request_sample_too_small");
  if (metric(run, "inputCoveragePartialCount") > 0) issues.push("input_coverage_partial");
  if (metric(run, "deferredCount") > 0) issues.push("deferred_work_remaining");
  if (metric(run, "retryableRemainingCount") > 0) issues.push("retryable_work_remaining");
  if (metric(run, "retryExhaustedCount") > 0) issues.push("retry_exhausted");
  if (metric(run, "unknownCount") > 0) issues.push("unknown_results");
  if (metric(run, "manualReconcileCount") > 0) issues.push("manual_reconcile_required");
  if (metric(run, "authorizationWaitingCount") > 0) issues.push("authorization_waiting");
  if (metric(run, "contractMismatchCount") > 0) issues.push("contract_mismatch");
  if (metric(run, "globalRateMode") !== 0) issues.push("global_rate_protective");
  if (metric(run, "globalThrottleCount") > 0) issues.push("global_throttle_observed");
  if (throttleRatio(run) > MAX_BASELINE_THROTTLE_RATIO) issues.push("throttle_ratio_too_high");
  if (metric(run, "averageStoreIntervalMs") > initialIntervalMs * MAX_INTERVAL_FACTOR) issues.push("average_store_interval_too_high");
  if (metric(run, "effectiveCompletionPerMinute") <= 0) issues.push("effective_throughput_missing");
  return issues;
}

function sortedTerminalRuns(runs: SubmitConcurrencyRunSnapshot[]) {
  return runs
    .filter((run) => run.status !== "running")
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
}

export function evaluateSubmitConcurrencyReadiness(
  currentRun: SubmitConcurrencyRunSnapshot,
  previousRuns: SubmitConcurrencyRunSnapshot[] = []
): SubmitConcurrencyEvaluation {
  const terminalRuns = sortedTerminalRuns([...previousRuns, currentRun]);
  const baselineRuns = terminalRuns.filter((run) => metric(run, "submitTaskConcurrency") === 2);
  const latestBaselineRuns = baselineRuns.slice(-2);
  const currentConcurrency = metric(currentRun, "submitTaskConcurrency") || 2;
  const baselineGlobalThrottleRatio = latestBaselineRuns.length
    ? latestBaselineRuns.reduce((sum, run) => sum + globalThrottleRatio(run), 0) / latestBaselineRuns.length
    : 0;
  const currentGlobalThrottleRatio = globalThrottleRatio(currentRun);
  const evidence: Record<string, number> = {
    currentConcurrency,
    baselineRunCount: latestBaselineRuns.length,
    currentThrottleRatio: throttleRatio(currentRun),
    currentGlobalThrottleRatio,
    baselineGlobalThrottleRatio,
    currentAverageStoreIntervalMs: metric(currentRun, "averageStoreIntervalMs"),
    currentEffectiveCompletionPerMinute: metric(currentRun, "effectiveCompletionPerMinute"),
    maxBaselineThrottleRatio: MAX_BASELINE_THROTTLE_RATIO,
    maxIntervalFactor: MAX_INTERVAL_FACTOR,
    minThroughputRetentionRatio: MIN_THROUGHPUT_RETENTION_RATIO
  };

  if (currentRun.status === "running") {
    return {
      version: "opportunity-submit-concurrency-evaluation-v1",
      decision: "hold_at_2",
      reasons: ["current_run_incomplete"],
      evaluatedRunIds: [],
      stableRunCount: 0,
      evidence
    };
  }

  if (currentConcurrency >= 3) {
    const currentIssues = stableBaselineIssues({
      ...currentRun,
      summary: { ...currentRun.summary, submitTaskConcurrency: 2 }
    }).filter((issue) => issue !== "http_request_sample_too_small");
    const globalThrottleIncreased = metric(currentRun, "globalRateMode") !== 0
      || (metric(currentRun, "globalThrottleCount") > 0 && currentGlobalThrottleRatio > baselineGlobalThrottleRatio);
    const rollbackReasons = [
      ...(globalThrottleIncreased ? ["global_throttle_increased"] : []),
      ...currentIssues.map((issue) => `canary_${issue}`)
    ];
    return {
      version: "opportunity-submit-concurrency-evaluation-v1",
      decision: rollbackReasons.length ? "rollback_to_2" : "continue_canary_3",
      reasons: rollbackReasons.length ? rollbackReasons : ["canary_stable"],
      evaluatedRunIds: [...latestBaselineRuns.map((run) => run.runId), currentRun.runId],
      stableRunCount: rollbackReasons.length ? 0 : 1,
      evidence
    };
  }

  if (latestBaselineRuns.length < 2) {
    return {
      version: "opportunity-submit-concurrency-evaluation-v1",
      decision: "hold_at_2",
      reasons: ["two_completed_baseline_runs_required"],
      evaluatedRunIds: latestBaselineRuns.map((run) => run.runId),
      stableRunCount: latestBaselineRuns.filter((run) => stableBaselineIssues(run).length === 0).length,
      evidence
    };
  }

  const issues = latestBaselineRuns.flatMap((run) => stableBaselineIssues(run).map((issue) => `${run.runId}:${issue}`));
  const firstThroughput = metric(latestBaselineRuns[0], "effectiveCompletionPerMinute");
  const secondThroughput = metric(latestBaselineRuns[1], "effectiveCompletionPerMinute");
  const throughputRetentionRatio = firstThroughput > 0 ? secondThroughput / firstThroughput : 0;
  evidence.throughputRetentionRatio = throughputRetentionRatio;
  if (throughputRetentionRatio < MIN_THROUGHPUT_RETENTION_RATIO) issues.push("effective_throughput_regressed");
  return {
    version: "opportunity-submit-concurrency-evaluation-v1",
    decision: issues.length ? "hold_at_2" : "eligible_for_canary_3",
    reasons: issues.length ? issues : ["two_stable_baseline_runs"],
    evaluatedRunIds: latestBaselineRuns.map((run) => run.runId),
    stableRunCount: latestBaselineRuns.filter((run) => stableBaselineIssues(run).length === 0).length,
    evidence
  };
}
