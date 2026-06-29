import { RuyiBrowser } from '../../core/browser-ruyi';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
import { getStaticRuntimeDescriptor } from '../../core/browser-pool/runtime-capability-registry';
import { getOcrPool } from '../../core/system-automation/ocr';
import { RuyiFirefoxClient } from './ruyi-firefox-client';
import { prepareRuyiFirefoxLaunch } from './ruyi-runtime-shared';

export function createRuyiBrowserFactory(): BrowserFactory {
  return async (session) => {
    const prepared = prepareRuyiFirefoxLaunch(session, { startHidden: true });
    const client = await RuyiFirefoxClient.launch(prepared);

    const browser = new RuyiBrowser({
      client,
      closeInternal: async () => {
        await client.close();
      },
      ocrProviderFactory: {
        create: async () => getOcrPool(),
      },
    });

    return {
      browser,
      runtimeId: 'firefox-bidi',
      runtimeDescriptor: getStaticRuntimeDescriptor('firefox-bidi'),
      resolvedRuntime: {
        runtimeId: 'firefox-bidi',
        source: session.runtimeSourceOverride ?? { type: 'managed-download', channel: 'firefox' },
        executablePath: prepared.browserPath,
      },
    };
  };
}
