import { normalizeTiansheEditionName, resolveTiansheEditionName } from './selection';
import type { TiansheEdition } from './types';
import { openEdition } from './open';

export type { TiansheEdition } from './types';
export {
  getTiansheEditionPublicInfo,
  normalizeTiansheEditionName,
  resolveTiansheEditionName,
} from './selection';

export function resolveTiansheEdition(rawName?: unknown): TiansheEdition {
  const name =
    rawName === undefined ? resolveTiansheEditionName() : normalizeTiansheEditionName(rawName);
  if (name !== 'open') {
    return openEdition;
  }
  return openEdition;
}
