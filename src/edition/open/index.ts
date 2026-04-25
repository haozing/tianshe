import { getTiansheEditionPublicInfo } from '../selection';
import type { TiansheEdition } from '../types';

const publicInfo = getTiansheEditionPublicInfo('open');

export const openEdition: TiansheEdition = {
  name: 'open',
  capabilities: publicInfo.capabilities,
  cloudAuth: {
    enabled: false,
    registerMainHandlers: () => undefined,
  },
  cloudSnapshot: {
    enabled: false,
    markAccountBundleDirty: () => undefined,
    registerMainHandlers: () => undefined,
  },
  cloudCatalog: {
    enabled: false,
    registerMainHandlers: () => undefined,
  },
  toPublicInfo: () => publicInfo,
};
