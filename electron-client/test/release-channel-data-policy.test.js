const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CANONICAL_APP_DIRECTORY,
  LEGACY_BETA_APP_DIRECTORY,
  channelUserDataPath,
  prepareCanonicalUserData
} = require("../src/main/data-directory-policy");

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chihu-channel-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("stable and beta packages use one desktop identity", () => {
  const stable = fs.readFileSync(path.resolve(__dirname, "../electron-builder.yml"), "utf8");
  const beta = fs.readFileSync(path.resolve(__dirname, "../electron-builder.beta.yml"), "utf8");
  for (const source of [stable, beta]) {
    assert.match(source, /^appId: com\.chihu\.guanjia$/m);
    assert.match(source, /^productName: 赤狐管家$/m);
    assert.match(source, /^\s+shortcutName: 赤狐管家$/m);
    assert.match(source, /^\s+include: build\/installer\.nsh$/m);
  }
  assert.match(beta, /^\s+chihuReleaseChannel: beta$/m);
  assert.doesNotMatch(beta, /com\.chihu\.guanjia\.beta|赤狐管家内测/);
});

test("installer removes only the legacy beta installation identity", () => {
  const installer = fs.readFileSync(path.resolve(__dirname, "../build/installer.nsh"), "utf8");
  assert.match(installer, /f6426e21-e21c-5be8-9879-1b8b34f76b94/);
  assert.match(installer, /DeleteRegKey HKCU/);
  assert.match(installer, /DeleteRegKey HKLM/);
  assert.doesNotMatch(installer, /RMDir\s+\/r|AppData|freemium-v2/);
});

test("both channels resolve to the canonical profile", () => {
  const appData = path.join("C:\\Users", "tester", "AppData", "Roaming");
  const expected = path.join(path.resolve(appData), CANONICAL_APP_DIRECTORY, "freemium-v2");
  assert.equal(channelUserDataPath(appData, CANONICAL_APP_DIRECTORY, "freemium-v2"), expected);
});

test("a legacy beta-only profile is copied without deleting the source", (t) => {
  const appDataPath = temporaryRoot(t);
  const legacyPath = channelUserDataPath(appDataPath, LEGACY_BETA_APP_DIRECTORY, "freemium-v2");
  fs.mkdirSync(path.join(legacyPath, "data"), { recursive: true });
  fs.writeFileSync(path.join(legacyPath, "data", "chihu-business.sqlite3"), "legacy-data");

  const result = prepareCanonicalUserData({ appDataPath, dataEpoch: "freemium-v2" });
  assert.equal(result.migrated, true);
  assert.equal(result.path, channelUserDataPath(appDataPath, CANONICAL_APP_DIRECTORY, "freemium-v2"));
  assert.equal(fs.readFileSync(path.join(result.path, "data", "chihu-business.sqlite3"), "utf8"), "legacy-data");
  assert.equal(fs.readFileSync(path.join(legacyPath, "data", "chihu-business.sqlite3"), "utf8"), "legacy-data");
});

test("existing canonical data is never overwritten by legacy beta data", (t) => {
  const appDataPath = temporaryRoot(t);
  const canonicalPath = channelUserDataPath(appDataPath, CANONICAL_APP_DIRECTORY, "freemium-v2");
  const legacyPath = channelUserDataPath(appDataPath, LEGACY_BETA_APP_DIRECTORY, "freemium-v2");
  fs.mkdirSync(path.join(canonicalPath, "data"), { recursive: true });
  fs.mkdirSync(path.join(legacyPath, "data"), { recursive: true });
  fs.writeFileSync(path.join(canonicalPath, "data", "chihu-business.sqlite3"), "canonical-data");
  fs.writeFileSync(path.join(legacyPath, "data", "chihu-business.sqlite3"), "legacy-data");

  const result = prepareCanonicalUserData({ appDataPath, dataEpoch: "freemium-v2" });
  assert.equal(result.migrated, false);
  assert.equal(result.source, "canonical");
  assert.equal(fs.readFileSync(path.join(canonicalPath, "data", "chihu-business.sqlite3"), "utf8"), "canonical-data");
});

test("an explicit user data override remains authoritative", (t) => {
  const appDataPath = temporaryRoot(t);
  const overridePath = path.join(appDataPath, "explicit-profile");
  const result = prepareCanonicalUserData({ appDataPath, dataEpoch: "freemium-v2", overridePath });
  assert.deepEqual(result, { path: path.resolve(overridePath), migrated: false, source: "override" });
});
