import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyReleaseChannelPolicy } from "../../scripts/apply-release-channel-policy.mjs";

const adapter = {
  policies: {
    opportunityReport: {
      submitThrottleRecoveryEnabled: false,
      submitHistoryPrewarmEnabled: false,
      submitPipelineStreamingEnabled: false
    }
  }
};

test("release channel policy enables recovery only for beta packages", () => {
  const stable = applyReleaseChannelPolicy(adapter, "stable");
  const beta = applyReleaseChannelPolicy(adapter, "beta");

  assert.equal(stable.policies.opportunityReport.submitThrottleRecoveryEnabled, false);
  assert.equal(beta.policies.opportunityReport.submitThrottleRecoveryEnabled, true);
  assert.equal(stable.policies.opportunityReport.submitHistoryPrewarmEnabled, false);
  assert.equal(beta.policies.opportunityReport.submitHistoryPrewarmEnabled, false);
  assert.equal(stable.policies.opportunityReport.submitPipelineStreamingEnabled, false);
  assert.equal(beta.policies.opportunityReport.submitPipelineStreamingEnabled, true);
  assert.equal(adapter.policies.opportunityReport.submitThrottleRecoveryEnabled, false);
});

test("publisher applies the channel policy before re-signing the remote package", async () => {
  const source = await readFile(new URL("../../../scripts/publish-oss.mjs", import.meta.url), "utf8");
  const overlayIndex = source.indexOf("apply-release-channel-policy.mjs");
  const manifestIndex = source.indexOf("update-release-manifest.mjs", overlayIndex);

  assert.ok(overlayIndex > 0);
  assert.ok(manifestIndex > overlayIndex);
  assert.match(source, /buildRemote\(config, args\.skipBuild, args\.beta\)/);
  assert.match(source, /assertRemoteChannelBuild\(config, args\.beta\)/);
  assert.match(source, /"--channel", beta \? "beta" : "stable"/);
  assert.match(source, /historyPrewarmEnabled \|\| streamingEnabled !== beta/);
});
