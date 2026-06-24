import type { SiteAdapterProcedureDefinition } from '../../../core/site-adapter-runtime';

export const openProfileSettingsProcedure: SiteAdapterProcedureDefinition = {
  id: 'open-profile-settings',
  adapterId: 'github-profile',
  sideEffectLevel: 'low',
  steps: [
    {
      id: 'open-profile-settings',
      action: 'navigate',
      url: 'https://github.com/settings/profile',
      waitUntil: 'domcontentloaded',
      verify: {
        id: 'profile-settings-visible',
        action: 'verifyText',
        selector: 'body',
        text: 'Public profile',
      },
    },
    {
      id: 'wait-profile-name-field',
      action: 'waitForSelector',
      selector: 'input[name="user[profile_name]"]',
      timeout: 10000,
    },
  ],
};
