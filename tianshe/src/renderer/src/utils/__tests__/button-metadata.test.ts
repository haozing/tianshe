import { describe, expect, it } from 'vitest';
import {
  buildButtonMetadataForPersistence,
  normalizeButtonMetadata,
} from '../../../../utils/button-metadata';

describe('button metadata helpers', () => {
  it('normalizes legacy button colors into canonical variants', () => {
    expect(normalizeButtonMetadata({ buttonColor: 'green' }).buttonVariant).toBe('success');
    expect(normalizeButtonMetadata({ buttonColor: 'red' }).buttonVariant).toBe('danger');
    expect(normalizeButtonMetadata({ buttonColor: 'black' }).buttonVariant).toBe('default');
  });

  it('treats plugin bindings as configured and prefers parameterBindings over legacy mapping', () => {
    const normalized = normalizeButtonMetadata({
      pluginId: 'plugin-1',
      methodId: 'run',
      parameterMapping: { id: '$rowid' },
      parameterBindings: [{ parameterName: 'id', bindingType: 'rowid' }],
    });

    expect(normalized.isConfigured).toBe(true);
    expect(normalized.mappingCount).toBe(1);
  });

  it('persists canonical button metadata and drops legacy transport fields', () => {
    const persisted = buildButtonMetadataForPersistence({
      pluginId: 'plugin-1',
      methodId: 'run',
      buttonColor: 'blue',
      automationId: 'legacy-flow',
      parameterMapping: { id: '$rowid' },
    });

    expect(persisted.buttonVariant).toBe('primary');
    expect(persisted.buttonColor).toBeUndefined();
    expect(persisted.automationId).toBeUndefined();
    expect(persisted.parameterMapping).toBeUndefined();
  });
});
