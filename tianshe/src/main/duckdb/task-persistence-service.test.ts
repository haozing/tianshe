import { describe, expect, it } from 'vitest';
import { TaskPersistenceService } from './task-persistence-service';

describe('TaskPersistenceService', () => {
  it('is explicitly marked as legacy persistence and not a scheduler runner', () => {
    const service = new TaskPersistenceService({} as any);

    expect(service.runtimeRole).toBe('legacy-persistence-only');
  });
});
