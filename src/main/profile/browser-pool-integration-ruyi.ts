import { RuyiBrowser } from '../../core/browser-ruyi';
import type { BrowserFactory } from '../../core/browser-pool/global-pool';
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
    });

    return {
      browser,
      engine: 'ruyi',
    };
  };
}
