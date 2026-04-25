import { describe, expect, it } from 'vitest';
import { validateManifest } from './loader';

describe('validateManifest', () => {
  it('rejects browser extension manifests with a targeted hint', () => {
    expect(() =>
      validateManifest({
        manifest_version: 3,
        name: 'Sample Extension',
        version: '1.0.0',
        background: {
          service_worker: 'background.js',
        },
      })
    ).toThrow(/Chrome\/Edge browser extension manifest/);
  });

  it('keeps the generic error for normal invalid plugin manifests', () => {
    expect(() =>
      validateManifest({
        name: 'Broken Plugin',
        version: '1.0.0',
        author: 'Airpa',
        main: 'index.js',
      })
    ).toThrow('Manifest.id is required and must be a string');
  });
});
