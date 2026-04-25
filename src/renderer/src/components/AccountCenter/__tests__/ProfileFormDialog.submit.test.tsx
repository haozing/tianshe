import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileFormDialog } from '../ProfileFormDialog';
import {
  getDefaultFingerprint,
  mergeFingerprintConfig,
} from '../../../../../constants/fingerprint-defaults';

const storeState = vi.hoisted(() => ({
  profiles: [],
  groups: [],
  loadGroups: vi.fn(),
  createGroup: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock('../../../stores/profileStore', () => ({
  useProfileStore: (selector?: (state: typeof storeState) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}));

function findSubmitButton() {
  return screen
    .getAllByRole('button')
    .find((button) => ['创建', '保存'].some((label) => (button.textContent || '').includes(label)));
}

describe('ProfileFormDialog submit payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.profiles = [];
    storeState.createProfile.mockResolvedValue({ id: 'profile-1' });
    storeState.updateProfile.mockResolvedValue(true);
  });

  it('calls profile mutation callback after a successful create', async () => {
    const onProfileMutationApplied = vi.fn().mockResolvedValue(undefined);

    render(
      <ProfileFormDialog
        open
        onOpenChange={vi.fn()}
        profileId={null}
        onClose={vi.fn()}
        onProfileMutationApplied={onProfileMutationApplied}
      />
    );

    const nameInput = document.getElementById('name') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    fireEvent.change(nameInput as HTMLInputElement, { target: { value: 'mutation-profile' } });

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.createProfile).toHaveBeenCalledTimes(1);
      expect(onProfileMutationApplied).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps fingerprint and performance controls behind the advanced settings tab', async () => {
    render(<ProfileFormDialog open onOpenChange={vi.fn()} profileId={null} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));

    const fingerprintButton = screen.getByRole('button', { name: /指纹配置/ });
    const performanceButton = screen.getByRole('button', { name: /性能/ });

    expect(fingerprintButton).toHaveAttribute('aria-expanded', 'false');
    expect(performanceButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('GPU 厂商')).not.toBeInTheDocument();

    fireEvent.click(fingerprintButton);

    await waitFor(() => {
      expect(fingerprintButton).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('GPU 厂商')).toBeInTheDocument();
    });
  });

  it('preserves native fingerprint source and identity fields when editing an extension profile', async () => {
    storeState.profiles = [
      {
        id: 'profile-ext-1',
        name: 'extension-profile',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-1',
        proxy: null,
        fingerprint: {
          ...mergeFingerprintConfig(getDefaultFingerprint(), {
            identity: {
              region: {
                timezone: 'Asia/Hong_Kong',
              },
            },
            source: {
              mode: 'generated',
              fileFormat: 'txt',
            },
          }),
          source: {
            mode: 'generated',
            fileFormat: 'json' as never,
          },
        },
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog open onOpenChange={vi.fn()} profileId="profile-ext-1" onClose={vi.fn()} />
    );

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: {
        source: {
          mode: string;
          fileFormat: string;
        };
        identity: {
          region: {
            timezone: string;
          };
        };
      };
    };
    expect(payload.fingerprint.source).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
    expect(payload.fingerprint.identity.region).toMatchObject({
      timezone: 'Asia/Hong_Kong',
    });
  });

  it('strips non-stable extension fingerprint fields on submit', async () => {
    storeState.profiles = [
      {
        id: 'profile-ext-3',
        name: 'extension-stable-only',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-3',
        proxy: null,
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('extension'), {
          identity: {
            hardware: {
              platformVersion: '15.0.0',
              fontSystem: 'windows',
            },
            display: {
              pixelRatio: 1.5,
            },
            graphics: {
              canvasSeed: 39,
              webaudio: 0.0001,
              webgl: {
                maxTextureSize: 16384,
                supportedExt: ['WEBGL_debug_renderer_info'],
              },
            },
            typography: {
              fonts: ['Arial'],
            },
            network: {
              localWebrtcIpv4: '10.0.0.5',
            },
            speech: {
              localNames: ['Microsoft Haruka Desktop - Japanese'],
            },
            input: {
              touchSupport: true,
              maxTouchPoints: 5,
            },
          },
        }),
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog open onOpenChange={vi.fn()} profileId="profile-ext-3" onClose={vi.fn()} />
    );

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: ReturnType<typeof getDefaultFingerprint>;
    };
    expect(payload.fingerprint.identity.hardware.platformVersion).toBeUndefined();
    expect(payload.fingerprint.identity.hardware.fontSystem).toBeUndefined();
    expect(payload.fingerprint.identity.display.pixelRatio).toBeUndefined();
    expect(payload.fingerprint.identity.graphics?.webgl).toMatchObject({
      maskedVendor: expect.any(String),
      maskedRenderer: expect.any(String),
      unmaskedVendor: expect.any(String),
      unmaskedRenderer: expect.any(String),
    });
    expect(payload.fingerprint.identity.graphics?.webgl?.maxTextureSize).toBeUndefined();
    expect(payload.fingerprint.identity.graphics?.webgl?.supportedExt).toBeUndefined();
    expect(payload.fingerprint.identity.typography).toBeUndefined();
    expect(payload.fingerprint.identity.network).toBeUndefined();
    expect(payload.fingerprint.identity.speech).toBeUndefined();
    expect(payload.fingerprint.identity.input).toEqual({
      touchSupport: false,
      maxTouchPoints: 0,
    });
  });

  it('backfills missing extension WebGL contract fields before submit', async () => {
    const base = getDefaultFingerprint('extension');
    const webgl = base.identity.graphics?.webgl;
    storeState.profiles = [
      {
        id: 'profile-ext-legacy-webgl',
        name: 'extension-legacy-webgl',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-legacy-webgl',
        proxy: null,
        fingerprint: {
          ...base,
          identity: {
            ...base.identity,
            graphics: webgl
              ? {
                  webgl: {
                    maskedVendor: webgl.maskedVendor,
                    maskedRenderer: webgl.maskedRenderer,
                  },
                }
              : undefined,
          },
        },
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog
        open
        onOpenChange={vi.fn()}
        profileId="profile-ext-legacy-webgl"
        onClose={vi.fn()}
      />
    );

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: ReturnType<typeof getDefaultFingerprint>;
    };
    expect(payload.fingerprint.identity.graphics?.webgl).toMatchObject({
      maskedVendor: webgl?.maskedVendor,
      maskedRenderer: webgl?.maskedRenderer,
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      glslVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      unmaskedVendor: webgl?.maskedVendor,
      unmaskedRenderer: webgl?.maskedRenderer,
    });
  });

  it('derives primary language and webdriver from simplified extension controls on submit', async () => {
    storeState.profiles = [
      {
        id: 'profile-ext-derived-fields',
        name: 'extension-derived-fields',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-derived-fields',
        proxy: null,
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('extension'), {
          identity: {
            region: {
              primaryLanguage: 'zh-CN',
              languages: ['en-US', 'en'],
            },
            automationSignals: {
              webdriver: 1,
            },
          },
        }),
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog
        open
        onOpenChange={vi.fn()}
        profileId="profile-ext-derived-fields"
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));
    fireEvent.click(screen.getByRole('button', { name: /指纹配置/ }));

    await screen.findByText('语言列表');
    const languagesSection = screen.getByText('语言列表').closest('div');
    const languagesField = languagesSection?.querySelector('textarea');
    expect(languagesField).not.toBeNull();
    fireEvent.change(languagesField as HTMLTextAreaElement, { target: { value: 'ja-JP\nja' } });

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: ReturnType<typeof getDefaultFingerprint>;
      fingerprintCore: {
        locale: {
          languages: string[];
        };
        browserProfile: {
          browser: string;
        };
      };
      fingerprintSource: {
        mode: string;
      };
    };
    expect(payload.fingerprint.identity.region).toMatchObject({
      primaryLanguage: 'ja-JP',
      languages: ['ja-JP', 'ja'],
    });
    expect(payload.fingerprint.identity.automationSignals).toMatchObject({
      webdriver: 0,
    });
    expect(payload.fingerprintCore.locale.languages).toEqual(['ja-JP', 'ja']);
    expect(payload.fingerprintCore.browserProfile.browser).toBe('chrome');
    expect(payload.fingerprintSource.mode).toBe('generated');
  });

  it('prefers persisted fingerprint core and normalizes legacy source when reopening a profile form', async () => {
    storeState.profiles = [
      {
        id: 'profile-ext-core-source',
        name: 'extension-core-source',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-core-source',
        proxy: null,
        fingerprint: getDefaultFingerprint('extension'),
        fingerprintCore: {
          osFamily: 'windows',
          browserProfile: {
            browser: 'edge',
            presetId: 'windows-edge-121',
          },
          locale: {
            languages: ['en-US', 'en'],
            timezone: 'America/New_York',
          },
          hardware: {
            hardwareConcurrency: 16,
            deviceMemory: 8,
          },
          display: {
            width: 1920,
            height: 1080,
          },
          graphics: {
            maskedVendor: 'Google Inc. (Intel)',
            maskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
          },
        },
        fingerprintSource: {
          mode: 'file',
          fileFormat: 'txt',
          filePath: 'D:\\fp\\edge.txt',
        },
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog
        open
        onOpenChange={vi.fn()}
        profileId="profile-ext-core-source"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(document.getElementById('name')).toHaveValue('extension-core-source');
    });

    fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));

    expect(screen.queryByRole('button', { name: /启动来源/ })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('D:\\fp\\edge.txt')).not.toBeInTheDocument();

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: ReturnType<typeof getDefaultFingerprint>;
      fingerprintCore: {
        browserProfile: {
          browser: string;
          presetId?: string;
        };
      };
      fingerprintSource: {
        mode: string;
        fileFormat: string;
        filePath?: string;
      };
    };
    expect(payload.fingerprint.identity.hardware.userAgent).toContain('Edg/');
    expect(payload.fingerprintCore.browserProfile).toMatchObject({
      browser: 'edge',
      presetId: 'windows-edge-121',
    });
    expect(payload.fingerprintSource).toEqual({
      mode: 'generated',
      fileFormat: 'txt',
    });
  });

  it('removes startup source guidance panel from advanced settings together with the engine summary banner', async () => {
    storeState.profiles = [
      {
        id: 'profile-ext-2',
        name: 'extension-runtime-profile',
        engine: 'extension',
        groupId: null,
        partition: 'persist:profile-ext-2',
        proxy: null,
        fingerprint: getDefaultFingerprint('extension'),
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog open onOpenChange={vi.fn()} profileId="profile-ext-2" onClose={vi.fn()} />
    );

    expect(screen.queryByText('启动指纹契约')).not.toBeInTheDocument();
    expect(screen.queryByText('主动调用观察')).not.toBeInTheDocument();
    expect(screen.queryByText('DOM 文本')).not.toBeInTheDocument();
    expect(screen.queryByText('OCR 文本')).not.toBeInTheDocument();
    expect(screen.queryByText('网络抓包')).not.toBeInTheDocument();
    expect(screen.queryByText('控制台')).not.toBeInTheDocument();
    expect(screen.queryByText('原生输入')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));
    const fingerprintButton = screen.getByRole('button', { name: /指纹配置/ });
    fireEvent.click(fingerprintButton);

    await waitFor(() => {
      expect(screen.queryByText('像素比')).not.toBeInTheDocument();
      expect(screen.queryByText('触摸支持')).not.toBeInTheDocument();
      expect(screen.queryByText('Canvas 种子')).not.toBeInTheDocument();
      expect(screen.queryByText('WebAudio 种子')).not.toBeInTheDocument();
      expect(screen.queryByText('语音与 WebRTC')).not.toBeInTheDocument();
      expect(screen.queryByText('字体列表')).not.toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /启动来源/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText((_, element) =>
        Boolean(
          element?.textContent?.includes(
            '启动时的原生指纹文件固定由程序根据当前身份配置自动生成，不支持引用外部 filePath'
          )
        )
      )
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText((_, element) =>
        Boolean(
          element?.textContent?.includes(
            '当前仓库内置 Chromium runtime 已按 FingerPrintJSBrowser README 描述的启动字段验证'
          )
        )
      )
    ).not.toBeInTheDocument();
  });

  it('hides non-contract startup controls for ruyi profiles and strips them on submit', async () => {
    storeState.profiles = [
      {
        id: 'profile-ruyi-1',
        name: 'ruyi-stable-only',
        engine: 'ruyi',
        groupId: null,
        partition: 'persist:profile-ruyi-1',
        proxy: null,
        fingerprint: mergeFingerprintConfig(getDefaultFingerprint('ruyi'), {
          identity: {
            display: {
              pixelRatio: 1.5,
            },
            input: {
              touchSupport: true,
              maxTouchPoints: 5,
            },
          },
        }),
        notes: null,
        tags: [],
        color: null,
        status: 'idle',
        lastError: null,
        lastActiveAt: null,
        totalUses: 0,
        quota: 1,
        idleTimeoutMs: 300_000,
        lockTimeoutMs: 300_000,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    render(
      <ProfileFormDialog open onOpenChange={vi.fn()} profileId="profile-ruyi-1" onClose={vi.fn()} />
    );

    fireEvent.click(screen.getByRole('tab', { name: '高级设置' }));
    const fingerprintButton = screen.getByRole('button', { name: /指纹配置/ });
    fireEvent.click(fingerprintButton);

    expect(screen.queryByText('像素比')).not.toBeInTheDocument();
    expect(screen.queryByText('触摸支持')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /启动来源/ })).not.toBeInTheDocument();

    const submitButton = findSubmitButton();
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton as HTMLButtonElement);

    await waitFor(() => {
      expect(storeState.updateProfile).toHaveBeenCalledTimes(1);
    });

    const payload = storeState.updateProfile.mock.calls[0][1] as {
      fingerprint: ReturnType<typeof getDefaultFingerprint>;
    };
    expect(payload.fingerprint.identity.display.pixelRatio).toBeUndefined();
    expect(payload.fingerprint.identity.input).toBeUndefined();
  });
});
