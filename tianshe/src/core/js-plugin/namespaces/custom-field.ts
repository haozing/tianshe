export type CustomFieldStatus = 'ENABLED' | 'DISABLED';
export type CustomFieldIndexRebuildMode = 'none' | 'sync' | 'async';

export class CustomFieldNamespace {
  constructor(private readonly pluginId: string) {}

  private unavailable(): never {
    void this.pluginId;
    throw new Error('Cloud custom fields are not available in the open-source edition');
  }

  async queryRows(): Promise<never> {
    return this.unavailable();
  }

  async upsertRow(): Promise<never> {
    return this.unavailable();
  }

  async deleteRows(): Promise<never> {
    return this.unavailable();
  }
}
