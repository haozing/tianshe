import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_BROWSER_COMMAND,
  RUYI_REMOTE_BROWSER_COMMANDS,
} from '../../main/profile/remote-browser-command-protocol';

const projectRoot = process.cwd();

const readSource = (relativePath: string): string =>
  fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expectClassMethod = (source: string, className: string, methodName: string): void => {
  const pattern = new RegExp(
    String.raw`(?:^|\n)\s{2}(?:static\s+)?(?:async\s+)?${escapeRegExp(methodName)}(?:\s*<[^>{}]+>)?\s*\(`
  );
  expect(source, `${className}.${methodName} must remain available`).toMatch(pattern);
};

describe('runtime/profile contract baselines', () => {
  it('keeps the Ruyi Firefox remote command surface wired through dispatch()', () => {
    const source = readSource('src/main/profile/ruyi-firefox-client.ts');
    const ruyiCommandValues = new Set<string>(RUYI_REMOTE_BROWSER_COMMANDS);
    const ruyiCommandKeys = Object.entries(REMOTE_BROWSER_COMMAND)
      .filter(([, value]) => ruyiCommandValues.has(value))
      .map(([key]) => key);

    for (const commandKey of ruyiCommandKeys) {
      expect(
        source,
        `RuyiFirefoxClient.dispatch() must handle REMOTE_BROWSER_COMMAND.${commandKey}`
      ).toContain(`case REMOTE_BROWSER_COMMAND.${commandKey}:`);
    }

    for (const methodName of [
      'launch',
      'isClosed',
      'getObservationBrowserId',
      'onEvent',
      'dispatch',
      'close',
    ]) {
      expectClassMethod(source, 'RuyiFirefoxClient', methodName);
    }
  });

  it('keeps helpers.profile public methods available while namespace internals are split', () => {
    const source = readSource('src/core/js-plugin/namespaces/profile.ts');

    for (const methodName of [
      'describeRuntime',
      'listRuntimes',
      'withLease',
      'list',
      'get',
      'create',
      'update',
      'delete',
      'isAvailable',
      'getStats',
      'listGroups',
      'launch',
      'getUsage',
      'launchPopup',
      'generateFingerprint',
      'getPresets',
      'getPresetConfig',
      'applyPreset',
      'randomizeFingerprint',
      'regenerateFingerprint',
      'validateFingerprint',
      'getDefaultFingerprint',
    ]) {
      expectClassMethod(source, 'ProfileNamespace', methodName);
    }
  });

  it('keeps ProfileService facade methods stable while storage internals are split', () => {
    const source = readSource('src/main/duckdb/profile-service.ts');

    for (const methodName of [
      'sweepDeferredPartitionCleanup',
      'initTable',
      'create',
      'get',
      'getDefault',
      'list',
      'update',
      'delete',
      'deleteWithCascade',
      'updateStatus',
      'incrementUsage',
      'isAvailable',
      'resetAllActiveStatus',
      'getStats',
    ]) {
      expectClassMethod(source, 'ProfileService', methodName);
    }
  });

  it('keeps SyncLocalApplyService external apply contract stable', () => {
    const source = readSource('src/main/sync/sync-local-apply-service.ts');

    expectClassMethod(source, 'SyncLocalApplyService', 'applyChange');
    expect(source).toContain('export interface SyncLocalApplyResult');

    for (const fieldName of ['applied', 'skipped', 'localId', 'reason']) {
      expect(source, `SyncLocalApplyResult.${fieldName} must remain available`).toMatch(
        new RegExp(String.raw`\b${fieldName}\??:\s*`)
      );
    }
  });
});
