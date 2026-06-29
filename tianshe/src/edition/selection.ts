export type TiansheEditionName = 'open' | 'cloud';

export interface TiansheEditionCapabilities {
  cloudAuth: boolean;
  cloudSnapshot: boolean;
  cloudCatalog: boolean;
}

export interface TiansheEditionPublicInfo {
  name: TiansheEditionName;
  capabilities: TiansheEditionCapabilities;
}

const DEFAULT_EDITION: TiansheEditionName = 'open';

export function normalizeTiansheEditionName(_raw: unknown): TiansheEditionName {
  return DEFAULT_EDITION;
}

export function resolveTiansheEditionName(): TiansheEditionName {
  return DEFAULT_EDITION;
}

export function getTiansheEditionPublicInfo(
  name: TiansheEditionName = resolveTiansheEditionName()
): TiansheEditionPublicInfo {
  const normalizedName = normalizeTiansheEditionName(name);
  return {
    name: normalizedName,
    capabilities: {
      cloudAuth: false,
      cloudSnapshot: false,
      cloudCatalog: false,
    },
  };
}
