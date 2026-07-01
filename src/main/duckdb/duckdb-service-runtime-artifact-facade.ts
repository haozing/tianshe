import type { RuntimeObservationArtifact } from './types';
import type { RuntimeObservationService } from './runtime-observation-service';
import {
  RuntimeArtifactFileStore,
  RuntimeArtifactFileStoreError,
  type RuntimeArtifactTrustedSaveTarget,
} from '../runtime-artifact-file-store';

export interface DuckDBServiceRuntimeArtifactFacade {
  getRuntimeArtifactFileStore(): RuntimeArtifactFileStore;
  getRuntimeArtifact(artifactId: string): Promise<RuntimeObservationArtifact | null>;
  openRuntimeArtifactFile(artifactId: string): Promise<{ success: true }>;
  revealRuntimeArtifactFile(artifactId: string): Promise<{ success: true }>;
  saveRuntimeArtifactFileAsFromTrustedDialog(
    artifactId: string,
    target: RuntimeArtifactTrustedSaveTarget
  ): Promise<{ success: true; bytesWritten: number; sha256: string }>;
  deleteRuntimeArtifactFile(artifactId: string): Promise<{ success: true; deleted: boolean }>;
}

type DuckDBServiceRuntimeArtifactFacadeThis = DuckDBServiceRuntimeArtifactFacade & {
  runtimeObservationService: RuntimeObservationService | null;
  runtimeArtifactFileStore: RuntimeArtifactFileStore | null;
};

async function requireRuntimeFileArtifact(
  service: DuckDBServiceRuntimeArtifactFacadeThis,
  artifactId: string
) {
  if (!service.runtimeObservationService) {
    throw new Error('RuntimeObservationService not initialized');
  }
  const artifact = await service.runtimeObservationService.getArtifactById(artifactId);
  if (!artifact) {
    throw new RuntimeArtifactFileStoreError(
      'not_found',
      `Runtime artifact not found: ${artifactId}`
    );
  }
  if (artifact.payload?.kind !== 'file') {
    throw new RuntimeArtifactFileStoreError(
      'invalid_storage_key',
      `Runtime artifact is not file-backed: ${artifactId}`
    );
  }
  return artifact.payload;
}

const duckDBServiceRuntimeArtifactFacadeMethods: DuckDBServiceRuntimeArtifactFacade &
  ThisType<DuckDBServiceRuntimeArtifactFacadeThis> = {
  getRuntimeArtifactFileStore(): RuntimeArtifactFileStore {
    if (!this.runtimeArtifactFileStore) {
      throw new Error('RuntimeArtifactFileStore not initialized');
    }
    return this.runtimeArtifactFileStore;
  },

  async getRuntimeArtifact(artifactId: string): Promise<RuntimeObservationArtifact | null> {
    if (!this.runtimeObservationService) {
      throw new Error('RuntimeObservationService not initialized');
    }
    return await this.runtimeObservationService.getArtifactById(artifactId);
  },

  async openRuntimeArtifactFile(artifactId: string): Promise<{ success: true }> {
    const payload = await requireRuntimeFileArtifact(this, artifactId);
    await this.getRuntimeArtifactFileStore().openFilePayload(payload);
    return { success: true };
  },

  async revealRuntimeArtifactFile(artifactId: string): Promise<{ success: true }> {
    const payload = await requireRuntimeFileArtifact(this, artifactId);
    await this.getRuntimeArtifactFileStore().revealFilePayload(payload);
    return { success: true };
  },

  async saveRuntimeArtifactFileAsFromTrustedDialog(
    artifactId: string,
    target: RuntimeArtifactTrustedSaveTarget
  ): Promise<{ success: true; bytesWritten: number; sha256: string }> {
    const payload = await requireRuntimeFileArtifact(this, artifactId);
    const result = await this
      .getRuntimeArtifactFileStore()
      .saveFilePayloadAsFromTrustedDialog(payload, target);
    return { success: true, ...result };
  },

  async deleteRuntimeArtifactFile(
    artifactId: string
  ): Promise<{ success: true; deleted: boolean }> {
    const payload = await requireRuntimeFileArtifact(this, artifactId);
    const deleted = await this.getRuntimeArtifactFileStore().deleteFilePayload(payload);
    if (deleted && this.runtimeObservationService) {
      await this.runtimeObservationService.deleteArtifactById(artifactId);
    }
    return { success: true, deleted };
  },
};

export function installDuckDBServiceRuntimeArtifactFacade(prototype: object): void {
  Object.assign(prototype, duckDBServiceRuntimeArtifactFacadeMethods);
}
