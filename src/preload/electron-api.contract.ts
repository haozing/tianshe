import type { ElectronAPI as DeclaredElectronAPI } from '../types/electron';
import type { ElectronAPI as PreloadElectronAPI } from './index';

type NamespaceKey =
  | 'edition'
  | 'duckdb'
  | 'queryTemplate'
  | 'jsPlugin'
  | 'cloudAuth'
  | 'cloudSnapshot'
  | 'cloudPlugin'
  | 'cloudBrowserExtension';

type MissingKeys<Actual, Declared> = Exclude<keyof Actual, keyof Declared>;
type ExtraKeys<Actual, Declared> = Exclude<keyof Declared, keyof Actual>;

type AssertNoMissingKeys<Actual, Declared> = Record<MissingKeys<Actual, Declared>, never>;
type AssertNoExtraKeys<Actual, Declared> = Record<ExtraKeys<Actual, Declared>, never>;

const topLevelDeclaredKeysCoverPreload: AssertNoMissingKeys<
  PreloadElectronAPI,
  DeclaredElectronAPI
> = {};
const topLevelPreloadKeysCoverDeclared: AssertNoExtraKeys<PreloadElectronAPI, DeclaredElectronAPI> =
  {};

const declaredMatchesPreload: DeclaredElectronAPI = null as unknown as PreloadElectronAPI;
const preloadMatchesDeclared: PreloadElectronAPI = null as unknown as DeclaredElectronAPI;

type NamespaceChecks = {
  [K in NamespaceKey]: {
    missing: AssertNoMissingKeys<PreloadElectronAPI[K], DeclaredElectronAPI[K]>;
    extra: AssertNoExtraKeys<PreloadElectronAPI[K], DeclaredElectronAPI[K]>;
    declaredMatches: DeclaredElectronAPI[K];
    preloadMatches: PreloadElectronAPI[K];
  };
};

const namespaceChecks: NamespaceChecks = {
  edition: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['edition'],
    preloadMatches: null as unknown as DeclaredElectronAPI['edition'],
  },
  duckdb: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['duckdb'],
    preloadMatches: null as unknown as DeclaredElectronAPI['duckdb'],
  },
  queryTemplate: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['queryTemplate'],
    preloadMatches: null as unknown as DeclaredElectronAPI['queryTemplate'],
  },
  jsPlugin: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['jsPlugin'],
    preloadMatches: null as unknown as DeclaredElectronAPI['jsPlugin'],
  },
  cloudAuth: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['cloudAuth'],
    preloadMatches: null as unknown as DeclaredElectronAPI['cloudAuth'],
  },
  cloudSnapshot: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['cloudSnapshot'],
    preloadMatches: null as unknown as DeclaredElectronAPI['cloudSnapshot'],
  },
  cloudPlugin: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['cloudPlugin'],
    preloadMatches: null as unknown as DeclaredElectronAPI['cloudPlugin'],
  },
  cloudBrowserExtension: {
    missing: {},
    extra: {},
    declaredMatches: null as unknown as PreloadElectronAPI['cloudBrowserExtension'],
    preloadMatches: null as unknown as DeclaredElectronAPI['cloudBrowserExtension'],
  },
};

void topLevelDeclaredKeysCoverPreload;
void topLevelPreloadKeysCoverDeclared;
void declaredMatchesPreload;
void preloadMatchesDeclared;
void namespaceChecks;
