#!/usr/bin/env node

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../package.json');
const USER_DATA_FLAG = '--airpa-user-data-dir';
const HTTP_PORT_FLAG = '--airpa-http-port';
const HTTP_ENABLE_FLAG = '--airpa-enable-http';
const MCP_ENABLE_FLAG = '--airpa-enable-mcp';
const ISOLATE_USER_DATA_FLAG = '--airpa-isolate-user-data';

const hasArg = (args, flagName) =>
  args.some(
    (arg) => typeof arg === 'string' && (arg === flagName || arg.startsWith(`${flagName}=`))
  );

const sanitizeLaunchEnv = (inputEnv) => {
  const env = { ...(inputEnv || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
};

const getArgValue = (args, flagName) => {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      continue;
    }
    if (arg.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1).trim();
    }
  }
  return '';
};

const isTruthyEnvValue = (value) =>
  ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const resolveUserDataDirOverride = (
  env,
  platform = process.platform,
  packageName = packageJson.name || 'tiansheai'
) => {
  const explicit =
    typeof env.TIANSHEAI_USER_DATA_DIR === 'string' ? env.TIANSHEAI_USER_DATA_DIR.trim() : '';
  if (explicit) {
    return explicit;
  }

  if (platform === 'win32') {
    const appDataRoot = typeof env.APPDATA === 'string' ? env.APPDATA.trim() : '';
    if (appDataRoot) {
      return path.join(appDataRoot, packageName);
    }
  }

  return '';
};

const shouldIsolateUserDataDir = (args, env) =>
  hasArg(args, ISOLATE_USER_DATA_FLAG) || isTruthyEnvValue(env?.AIRPA_ISOLATE_USER_DATA);

const hasAppEntryArg = (args) =>
  args.some((arg) => {
    if (typeof arg !== 'string') {
      return false;
    }
    const normalized = arg.trim();
    if (!normalized || normalized.startsWith('-')) {
      return false;
    }
    return true;
  });

const resolveHttpPort = (args, env) => {
  const fromArgs = getArgValue(args, HTTP_PORT_FLAG);
  if (/^\d+$/.test(fromArgs)) {
    return fromArgs;
  }
  const fromEnv = typeof env.AIRPA_HTTP_PORT === 'string' ? env.AIRPA_HTTP_PORT.trim() : '';
  if (/^\d+$/.test(fromEnv)) {
    return fromEnv;
  }
  return '39090';
};

const resolveIsolatedUserDataDir = (
  args,
  env,
  packageName = packageJson.name || 'tiansheai'
) => {
  const httpPort = resolveHttpPort(args, env);
  return path.join(os.tmpdir(), `${packageName}-mcp-http-${httpPort}`);
};

const buildLaunchConfig = (options = {}) => {
  const env = sanitizeLaunchEnv(options.env || process.env);
  const args = [...(options.args || process.argv.slice(2))];
  const platform = options.platform || process.platform;

  if (!hasAppEntryArg(args)) {
    args.push('.');
  }

  if (!hasArg(args, USER_DATA_FLAG)) {
    const userDataDir = shouldIsolateUserDataDir(args, env)
      ? resolveIsolatedUserDataDir(args, env)
      : resolveUserDataDirOverride(env, platform);
    if (userDataDir) {
      args.push(`${USER_DATA_FLAG}=${userDataDir}`);
    }
  }

  if (!hasArg(args, HTTP_PORT_FLAG)) {
    const httpPort = typeof env.AIRPA_HTTP_PORT === 'string' ? env.AIRPA_HTTP_PORT.trim() : '';
    if (/^\d+$/.test(httpPort)) {
      args.push(`${HTTP_PORT_FLAG}=${httpPort}`);
    }
  }

  return { args, env };
};

const runLaunchElectron = (options = {}) => {
  const { args, env } = buildLaunchConfig(options);
  const electronBinary = options.electronBinary || require('electron');
  const spawnImpl = options.spawnImpl || spawn;
  const processRef = options.processRef || process;

  const child = spawnImpl(electronBinary, args, {
    stdio: 'inherit',
    env,
  });

  child.on('error', (error) => {
    console.error(`[launch-electron] Failed to start Electron: ${error.message}`);
    processRef.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      processRef.kill(processRef.pid, signal);
      return;
    }
    processRef.exit(code ?? 0);
  });

  return child;
};

module.exports = {
  USER_DATA_FLAG,
  HTTP_PORT_FLAG,
  HTTP_ENABLE_FLAG,
  MCP_ENABLE_FLAG,
  ISOLATE_USER_DATA_FLAG,
  hasArg,
  getArgValue,
  isTruthyEnvValue,
  sanitizeLaunchEnv,
  resolveUserDataDirOverride,
  shouldIsolateUserDataDir,
  hasAppEntryArg,
  resolveHttpPort,
  resolveIsolatedUserDataDir,
  buildLaunchConfig,
  runLaunchElectron,
};

if (require.main === module) {
  runLaunchElectron();
}
