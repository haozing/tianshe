declare module 'cloakbrowser' {
  export function launchPersistentContext(options: Record<string, unknown>): Promise<unknown>;
  export function binaryInfo(): unknown;
  export function ensureBinary(): Promise<unknown>;
}
