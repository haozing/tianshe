import assert from "node:assert/strict";
import test from "node:test";

import { responseHeaderText, retryAfterMs, submitRetryWaitMs } from "../src/domain/doudian/opportunity/submitRetryPolicy.ts";

test("submit retry honors Retry-After and applies progressive 429 backoff", () => {
  assert.equal(responseHeaderText({ "Retry-After": "45" }, "retry-after"), "45");
  assert.equal(retryAfterMs({ "retry-after": "45" }, 0), 45_000);
  assert.equal(submitRetryWaitMs({ baseDelayMs: 10_000, attemptIndex: 0, status: 429, jitterMs: 0 }), 30_000);
  assert.equal(submitRetryWaitMs({ baseDelayMs: 10_000, attemptIndex: 1, status: 429, jitterMs: 0 }), 60_000);
  assert.equal(submitRetryWaitMs({ baseDelayMs: 10_000, attemptIndex: 0, status: 429, headers: { "Retry-After": "45" }, nowMs: 0, jitterMs: 0 }), 45_000);
  assert.equal(submitRetryWaitMs({ baseDelayMs: 10_000, attemptIndex: 0, status: 502, jitterMs: 0 }), 10_000);
});
