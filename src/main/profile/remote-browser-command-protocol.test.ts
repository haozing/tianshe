import { describe, expect, it } from 'vitest';
import {
  COMMON_REMOTE_BROWSER_COMMANDS,
  EXTENSION_REMOTE_BROWSER_COMMANDS,
  REMOTE_BROWSER_COMMAND,
  RUYI_REMOTE_BROWSER_COMMANDS,
} from './remote-browser-command-protocol';

describe('remote browser command protocol', () => {
  it('keeps the shared command catalog in one place', () => {
    expect(COMMON_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.goto);
    expect(COMMON_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.dialogHandle);
    expect(COMMON_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.tabsCreate);
  });

  it('tracks engine-specific command surfaces separately', () => {
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.networkStart);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.dialogArm);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(
      REMOTE_BROWSER_COMMAND.networkInterceptEnable
    );
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(
      REMOTE_BROWSER_COMMAND.emulationIdentitySet
    );
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(
      REMOTE_BROWSER_COMMAND.emulationViewportSet
    );
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.emulationClear);

    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(
      REMOTE_BROWSER_COMMAND.networkInterceptEnable
    );
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.emulationIdentitySet);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.emulationViewportSet);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.emulationClear);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.storageGetItem);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.touchTap);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.downloadList);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).toContain(REMOTE_BROWSER_COMMAND.pdfSave);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.networkStart);
    expect(RUYI_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.dialogArm);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.storageGetItem);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.touchTap);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.downloadList);
    expect(EXTENSION_REMOTE_BROWSER_COMMANDS).not.toContain(REMOTE_BROWSER_COMMAND.pdfSave);
  });
});
