const fs = require("node:fs");
const path = require("node:path");

const CANONICAL_APP_DIRECTORY = "赤狐管家";
const LEGACY_BETA_APP_DIRECTORY = "赤狐管家内测";

function channelUserDataPath(appDataPath, appDirectory, dataEpoch) {
  return path.join(path.resolve(String(appDataPath || "")), appDirectory, dataEpoch);
}

function copyDirectory(sourcePath, targetPath) {
  fs.mkdirSync(targetPath, { recursive: false });
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const source = path.join(sourcePath, entry.name);
    const target = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(source, target);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
}

function prepareCanonicalUserData(options = {}) {
  const overridePath = String(options.overridePath || "").trim();
  if (overridePath) {
    return { path: path.resolve(overridePath), migrated: false, source: "override" };
  }

  const rawAppDataPath = String(options.appDataPath || "").trim();
  const dataEpoch = String(options.dataEpoch || "").trim();
  if (!rawAppDataPath || !dataEpoch) throw new Error("Canonical user data path requires appDataPath and dataEpoch");
  const appDataPath = path.resolve(rawAppDataPath);

  const canonicalPath = channelUserDataPath(appDataPath, CANONICAL_APP_DIRECTORY, dataEpoch);
  const legacyBetaPath = channelUserDataPath(appDataPath, LEGACY_BETA_APP_DIRECTORY, dataEpoch);
  if (fs.existsSync(canonicalPath) || !fs.existsSync(legacyBetaPath)) {
    return { path: canonicalPath, migrated: false, source: fs.existsSync(canonicalPath) ? "canonical" : "new" };
  }

  const stagingPath = `${canonicalPath}.migrating-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    copyDirectory(legacyBetaPath, stagingPath);
    fs.renameSync(stagingPath, canonicalPath);
    options.logger?.info?.(`[user-data] copied legacy beta profile to ${canonicalPath}`);
    return { path: canonicalPath, migrated: true, source: "legacy-beta", legacyBetaPath };
  } catch (error) {
    options.logger?.warn?.(`[user-data] legacy beta profile copy failed; continuing with the original profile: ${error?.message || error}`);
    return { path: legacyBetaPath, migrated: false, source: "legacy-beta-fallback", migrationError: error };
  }
}

module.exports = {
  CANONICAL_APP_DIRECTORY,
  LEGACY_BETA_APP_DIRECTORY,
  channelUserDataPath,
  prepareCanonicalUserData
};
