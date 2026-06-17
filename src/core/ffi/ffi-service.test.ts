import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'D:\\user-data'),
  },
}));

vi.mock('koffi', () => ({
  load: vi.fn(() => ({
    func: vi.fn(),
  })),
  register: vi.fn(),
  struct: vi.fn(),
}));

import { FFIService } from './ffi-service';

describe('FFIService diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the original library loadedAt timestamp in listLibraries', async () => {
    const service = new FFIService({ callerId: 'test-plugin' });

    await service.loadLibrary('kernel32.dll');
    const firstList = await service.listLibraries();

    vi.setSystemTime(9_000);
    const secondList = await service.listLibraries();

    expect(firstList).toHaveLength(1);
    expect(secondList).toHaveLength(1);
    expect(firstList[0].loadedAt).toBe(1_000);
    expect(secondList[0].loadedAt).toBe(1_000);

    service.dispose();
  });
});
