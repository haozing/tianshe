const { EventEmitter } = require('node:events');
const path = require('node:path');
const {
  USER_DATA_FLAG,
  HTTP_PORT_FLAG,
  ISOLATE_USER_DATA_FLAG,
  hasAppEntryArg,
  shouldIsolateUserDataDir,
  resolveIsolatedUserDataDir,
  buildLaunchConfig,
  runLaunchElectron,
} = require('./launch-electron.js');

const WINDOWS_APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
const OPEN_USER_DATA_DIR = path.join(WINDOWS_APPDATA, '@tianshe/client-open');

describe('launch-electron', () => {
  it('sanitizes the parent env and appends default launch flags', () => {
    const { args, env } = buildLaunchConfig({
      args: ['.', '--trace-warnings'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AIRPA_HTTP_PORT: '39090',
        APPDATA: WINDOWS_APPDATA,
      },
      platform: 'win32',
    });

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(args).toEqual(
      expect.arrayContaining([
        '.',
        '--trace-warnings',
        `${USER_DATA_FLAG}=${OPEN_USER_DATA_DIR}`,
        `${HTTP_PORT_FLAG}=39090`,
      ])
    );
  });

  it('defaults to the real user data dir for HTTP/MCP launches', () => {
    const { args } = buildLaunchConfig({
      args: ['.', '--airpa-enable-http', '--airpa-enable-mcp', '--airpa-http-port=39091'],
      env: {
        APPDATA: WINDOWS_APPDATA,
      },
      platform: 'win32',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '.',
        '--airpa-enable-http',
        '--airpa-enable-mcp',
        '--airpa-http-port=39091',
        `${USER_DATA_FLAG}=${OPEN_USER_DATA_DIR}`,
      ])
    );
  });

  it('isolates user data dir when explicitly requested by flag', () => {
    const { args } = buildLaunchConfig({
      args: [
        '.',
        '--airpa-enable-http',
        '--airpa-enable-mcp',
        '--airpa-http-port=39091',
        ISOLATE_USER_DATA_FLAG,
      ],
      env: {
        APPDATA: WINDOWS_APPDATA,
      },
      platform: 'win32',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '.',
        '--airpa-enable-http',
        '--airpa-enable-mcp',
        '--airpa-http-port=39091',
        ISOLATE_USER_DATA_FLAG,
        `${USER_DATA_FLAG}=${resolveIsolatedUserDataDir(
          ['--airpa-enable-http', '--airpa-enable-mcp', '--airpa-http-port=39091'],
          { APPDATA: WINDOWS_APPDATA }
        )}`,
      ])
    );
  });

  it('isolates user data dir when explicitly requested by env', () => {
    expect(
      shouldIsolateUserDataDir(['.', '--airpa-enable-http'], { AIRPA_ISOLATE_USER_DATA: 'true' })
    ).toBe(true);
  });

  it('detects whether an explicit app entry is present', () => {
    expect(hasAppEntryArg(['.', '--airpa-enable-mcp'])).toBe(true);
    expect(hasAppEntryArg(['https://example.com'])).toBe(true);
    expect(hasAppEntryArg(['--airpa-enable-http', '--airpa-enable-mcp'])).toBe(false);
  });

  it('appends the current workspace when the caller forgets the app entry', () => {
    const { args } = buildLaunchConfig({
      args: ['--airpa-enable-http', '--airpa-enable-mcp', '--airpa-http-port=39091'],
      env: {
        APPDATA: WINDOWS_APPDATA,
      },
      platform: 'win32',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--airpa-enable-http',
        '--airpa-enable-mcp',
        '--airpa-http-port=39091',
        '.',
      ])
    );
  });

  it('spawns Electron without ELECTRON_RUN_AS_NODE even when inherited from the parent env', () => {
    const child = new EventEmitter();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const processRef = {
      pid: 123,
      exit: vi.fn(),
      kill: vi.fn(),
    };

    runLaunchElectron({
      args: ['.', '--airpa-enable-http', '--airpa-enable-mcp'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
      electronBinary: 'electron.exe',
      spawnImpl,
      processRef,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnImpl.mock.calls[0];
    expect(binary).toBe('electron.exe');
    expect(args).toEqual(
      expect.arrayContaining([
        '.',
        '--airpa-enable-http',
        '--airpa-enable-mcp',
      ])
    );
    expect(args.some((arg) => arg.startsWith(`${USER_DATA_FLAG}=`))).toBe(false);
    expect(options).toEqual(
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.not.objectContaining({
          ELECTRON_RUN_AS_NODE: expect.anything(),
        }),
      })
    );

    child.emit('exit', 0, null);
    expect(processRef.exit).toHaveBeenCalledWith(0);
  });

  it('spawns Electron with isolated user data when explicitly requested', () => {
    const child = new EventEmitter();
    const spawnImpl = vi.fn().mockReturnValue(child);

    runLaunchElectron({
      args: ['.', '--airpa-enable-http', '--airpa-enable-mcp', ISOLATE_USER_DATA_FLAG],
      env: {},
      electronBinary: 'electron.exe',
      spawnImpl,
      processRef: {
        pid: 123,
        exit: vi.fn(),
        kill: vi.fn(),
      },
    });

    const [, args] = spawnImpl.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '.',
        '--airpa-enable-http',
        '--airpa-enable-mcp',
        ISOLATE_USER_DATA_FLAG,
        `${USER_DATA_FLAG}=${resolveIsolatedUserDataDir(
          ['--airpa-enable-http', '--airpa-enable-mcp'],
          {}
        )}`,
      ])
    );
  });
});
