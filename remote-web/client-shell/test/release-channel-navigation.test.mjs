import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  releaseChannelFromRemoteOrigin,
  remoteUrlForReleaseChannel
} from "../src/bridge/releaseChannel.ts";

test("detects the actual release channel from signed manifest origins", () => {
  assert.equal(releaseChannelFromRemoteOrigin("http://chihu.facaishe.cn/remote-web/current/new-remote-web/"), "stable");
  assert.equal(releaseChannelFromRemoteOrigin("http://chihu.facaishe.cn/remote-web/beta/current/new-remote-web/"), "beta");
  assert.equal(releaseChannelFromRemoteOrigin("https://cos.example/remote-web/beta/releases/release-1/new-remote-web/"), "beta");
  assert.equal(releaseChannelFromRemoteOrigin("https://cos.example/unrelated/index.html"), null);
});

test("builds canonical channel entry urls instead of preserving release path fragments", () => {
  const betaRelease = "https://cos.example/remote-web/beta/releases/release-1/new-remote-web/index.html?stale=1#route";
  assert.equal(
    remoteUrlForReleaseChannel("stable", betaRelease),
    "https://cos.example/remote-web/current/new-remote-web/index.html"
  );
  assert.equal(
    remoteUrlForReleaseChannel("beta", "http://chihu.facaishe.cn/remote-web/current/new-remote-web/"),
    "http://chihu.facaishe.cn/remote-web/beta/current/new-remote-web/index.html"
  );
});

test("settings use the actual manifest channel without a persistent header label", async () => {
  const source = await readFile(new URL("../src/components/ShellHeader.tsx", import.meta.url), "utf8");
  assert.match(source, /actualReleaseChannel=\{actualReleaseChannel\}/);
  assert.match(source, /releaseChannelLabel\(displayedReleaseChannel\)/);
  assert.doesNotMatch(source, /releaseChannelLabel\(draft\.releaseChannel\)/);
  assert.doesNotMatch(source, /"内测环境"/);
  assert.doesNotMatch(source, /"正式环境"/);
});
