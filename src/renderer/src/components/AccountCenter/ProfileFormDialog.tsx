/**
 * ProfileFormDialog - 配置表单弹窗
 * 创建和编辑浏览器配置
 */

import { type ReactNode, useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useProfileStore } from '../../stores/profileStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { DialogV2 } from '../ui/dialog-v2';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import type {
  CreateProfileParams,
  UpdateProfileParams,
  ProxyConfig,
  FingerprintConfig,
  FingerprintCoreConfig,
  ProfileGroup,
  AutomationEngine,
} from '../../../../types/profile';
import {
  FINGERPRINT_PRESET_OPTIONS,
  getDefaultFingerprint,
  extractFingerprintCoreConfig,
  mergeFingerprintConfig,
  materializeFingerprintConfigFromCore,
  materializeFingerprintConfigForEngine,
  getGPUOptions,
  SCREEN_RESOLUTIONS,
  MACOS_RETINA_RESOLUTIONS,
  CPU_CORES_OPTIONS,
  DEVICE_MEMORY_OPTIONS,
  TIMEZONE_OPTIONS,
} from '../../../../constants/fingerprint-defaults';
import { validateFingerprintConfig } from '../../../../core/fingerprint/fingerprint-validation';
import {
  DEFAULT_BROWSER_POOL_CONFIG,
  DEFAULT_BROWSER_PROFILE,
  BROWSER_POOL_LIMITS,
} from '../../../../constants/browser-pool';

interface ProfileFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string | null;
  onClose: () => void;
  onProfileMutationApplied?: () => Promise<void> | void;
}

type FingerprintUIOS = 'Windows' | 'macOS' | 'Linux';
type FingerprintUIBrowser = 'Chrome' | 'Firefox' | 'Edge';

const PLATFORM_BY_OS: Record<FingerprintUIOS, string> = {
  Windows: 'Win32',
  macOS: 'MacIntel',
  Linux: 'Linux x86_64',
};

const BROWSER_OPTIONS_BY_ENGINE: Record<AutomationEngine, FingerprintUIBrowser[]> = {
  electron: ['Chrome', 'Edge'],
  extension: ['Chrome', 'Edge'],
  ruyi: ['Firefox'],
};

const CORE_BROWSER_BY_UI: Record<FingerprintUIBrowser, FingerprintCoreConfig['browserProfile']['browser']> = {
  Chrome: 'chrome',
  Firefox: 'firefox',
  Edge: 'edge',
};

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringifyDelimitedList(values?: string[]): string {
  return Array.isArray(values) ? values.join('\n') : '';
}

function parseBrowserVersionWeight(version: string | undefined): number {
  if (!version) return 0;
  const [major = '0', minor = '0'] = String(version).split('.');
  const majorNum = Number.parseInt(major, 10) || 0;
  const minorNum = Number.parseInt(minor, 10) || 0;
  return majorNum * 1000 + minorNum;
}

function getRecommendedPresetOption(
  os: FingerprintUIOS,
  browser: FingerprintUIBrowser
): (typeof FINGERPRINT_PRESET_OPTIONS)[number] | undefined {
  const candidates = FINGERPRINT_PRESET_OPTIONS.filter((preset) => {
    return preset.os === os && preset.browser === browser;
  });
  if (candidates.length === 0) return undefined;

  return candidates
    .slice()
    .sort(
      (a, b) =>
        parseBrowserVersionWeight(b.config.identity.hardware.browserVersion) -
        parseBrowserVersionWeight(a.config.identity.hardware.browserVersion)
    )[0];
}

function toFingerprintUIOS(config: FingerprintConfig): FingerprintUIOS {
  const family = config.identity.hardware.osFamily;
  if (family === 'macos') return 'macOS';
  if (family === 'linux') return 'Linux';
  return 'Windows';
}

function toFingerprintUIBrowser(config: FingerprintConfig): FingerprintUIBrowser {
  const family = config.identity.hardware.browserFamily;
  if (family === 'firefox') return 'Firefox';
  const ua = config.identity.hardware.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  return 'Chrome';
}

function toFingerprintUIBrowserFromCore(
  browser: FingerprintCoreConfig['browserProfile']['browser']
): FingerprintUIBrowser {
  if (browser === 'firefox') return 'Firefox';
  if (browser === 'edge') return 'Edge';
  return 'Chrome';
}

function toFingerprintUIOSFromCore(osFamily: FingerprintCoreConfig['osFamily']): FingerprintUIOS {
  if (osFamily === 'macos') return 'macOS';
  if (osFamily === 'linux') return 'Linux';
  return 'Windows';
}

interface AdvancedSectionProps {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function AdvancedSection({ title, description, open, onToggle, children }: AdvancedSectionProps) {
  return (
    <section className="shell-soft-card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left"
        onClick={onToggle}
        aria-expanded={open}
      >
        <div className="space-y-1">
          <div className="text-sm font-semibold text-slate-900">{title}</div>
          <p className="text-xs leading-5 text-slate-500">{description}</p>
        </div>
        <span
          className={cn(
            'shell-field-chip shell-field-chip--ghost mt-0.5 inline-flex h-8 w-8 items-center justify-center text-slate-500 transition-transform',
            open && 'rotate-90'
          )}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {open ? (
        <div className="border-t border-slate-200/80 bg-white/40 px-5 py-5">{children}</div>
      ) : null}
    </section>
  );
}

function DialogSectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="text-xs leading-5 text-slate-500">{description}</p>
    </div>
  );
}

export function ProfileFormDialog({
  open,
  onOpenChange,
  profileId,
  onClose,
  onProfileMutationApplied,
}: ProfileFormDialogProps) {
  const { profiles, groups, loadGroups, createGroup, createProfile, updateProfile } =
    useProfileStore();

  // 表单状态
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<AutomationEngine>('electron');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const [groupId, setGroupId] = useState<string>(''); // '' 表示无分组
  const [color, setColor] = useState<string>(''); // '' 表示无颜色

  // 浏览器池参数（按 Profile 粒度）
  const [idleTimeoutMin, setIdleTimeoutMin] = useState<string>(
    String(Math.round(DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs / 60000))
  );
  const [lockTimeoutMin, setLockTimeoutMin] = useState<string>(
    String(Math.round(DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs / 60000))
  );

  // 代理配置
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyType, setProxyType] = useState<'http' | 'https' | 'socks4' | 'socks5'>('http');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('');
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');

  // 指纹配置
  const [fingerprint, setFingerprint] = useState<FingerprintConfig>(() =>
    getDefaultFingerprint('electron')
  );
  const [os, setOs] = useState<'Windows' | 'macOS' | 'Linux'>('Windows');
  const [browser, setBrowser] = useState<'Chrome' | 'Firefox' | 'Edge'>('Chrome');
  const [selectedPreset, setSelectedPreset] = useState<string>('custom');

  // WebGL 配置
  const [gpuVendor, setGpuVendor] = useState<string>(
    () => getDefaultFingerprint('electron').identity.graphics?.webgl?.maskedVendor || ''
  );
  const [gpuRenderer, setGpuRenderer] = useState<string>(
    () => getDefaultFingerprint('electron').identity.graphics?.webgl?.maskedRenderer || ''
  );
  const isHydratingFingerprintRef = useRef(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('basic');
  const [advancedFingerprintOpen, setAdvancedFingerprintOpen] = useState(false);
  const [advancedPerformanceOpen, setAdvancedPerformanceOpen] = useState(false);
  const isExtensionEngine = engine === 'extension';
  const isRuyiEngine = engine === 'ruyi';
  const identity = fingerprint.identity;
  const region = identity.region;
  const hardware = identity.hardware;
  const display = identity.display;
  const availableBrowsers = useMemo(() => BROWSER_OPTIONS_BY_ENGINE[engine], [engine]);
  const availablePresets = useMemo(
    () => FINGERPRINT_PRESET_OPTIONS.filter((preset) => availableBrowsers.includes(preset.browser)),
    [availableBrowsers]
  );

  const flattenedGroups = useMemo(() => {
    const out: Array<{ id: string; label: string }> = [];
    const walk = (nodes: ProfileGroup[], depth: number) => {
      for (const node of nodes) {
        out.push({ id: node.id, label: `${'— '.repeat(depth)}${node.name}` });
        if (node.children && node.children.length > 0) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(groups || [], 0);
    return out;
  }, [groups]);

  // 根据操作系统获取 GPU 选项
  const gpuOptions = useMemo(() => getGPUOptions(os), [os]);

  // 根据操作系统获取屏幕分辨率选项
  const screenResolutions = useMemo(() => {
    if (os === 'macOS') {
      return [...SCREEN_RESOLUTIONS, ...MACOS_RETINA_RESOLUTIONS];
    }
    return SCREEN_RESOLUTIONS;
  }, [os]);

  // 获取当前 vendor 对应的 renderer 选项
  const rendererOptions = useMemo(() => {
    const vendorOption = gpuOptions.find((opt) => opt.vendor === gpuVendor);
    return vendorOption?.renderers || [];
  }, [gpuOptions, gpuVendor]);

  const resolvePresetOption = (
    nextOs: FingerprintUIOS,
    nextBrowser: FingerprintUIBrowser,
    presetId: string = selectedPreset
  ) => {
    if (presetId !== 'custom') {
      const matchedPreset = availablePresets.find((preset) => preset.id === presetId);
      if (matchedPreset && matchedPreset.os === nextOs && matchedPreset.browser === nextBrowser) {
        return matchedPreset;
      }
    }
    return getRecommendedPresetOption(nextOs, nextBrowser);
  };

  const rematerializeFingerprintFromSharedControls = (
    prev: FingerprintConfig,
    overrides: Partial<{
      os: FingerprintUIOS;
      browser: FingerprintUIBrowser;
      presetId: string;
      gpuVendor: string;
      gpuRenderer: string;
      languages: string[];
      timezone: string;
      width: number;
      height: number;
      hardwareConcurrency: number;
      deviceMemory: number;
      pixelRatio: number | undefined;
      source: FingerprintConfig['source'];
    }> = {}
  ): FingerprintConfig => {
    const nextOs = overrides.os ?? os;
    const nextBrowser = overrides.browser ?? browser;
    const shouldRebasePersona =
      overrides.presetId !== undefined ||
      overrides.os !== undefined ||
      overrides.browser !== undefined;
    const preset = shouldRebasePersona
      ? resolvePresetOption(nextOs, nextBrowser, overrides.presetId)
      : undefined;
    const languages = Array.from(
      new Set(
        (overrides.languages ?? prev.identity.region.languages)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );
    const primaryLanguage =
      languages[0] ??
      preset?.config.identity.region.primaryLanguage ??
      prev.identity.region.primaryLanguage;
    const nextWidth = overrides.width ?? prev.identity.display.width;
    const nextHeight = overrides.height ?? prev.identity.display.height;
    const nextGpuVendor = overrides.gpuVendor ?? gpuVendor;
    const nextGpuRenderer = overrides.gpuRenderer ?? gpuRenderer;
    const nextPixelRatio =
      engine === 'electron'
        ? (overrides.pixelRatio ?? prev.identity.display.pixelRatio)
        : undefined;

    return materializeFingerprintConfigForEngine(
      mergeFingerprintConfig(prev, {
        identity: {
          region: {
            primaryLanguage,
            languages: languages.length > 0 ? languages : [primaryLanguage],
            timezone: overrides.timezone ?? prev.identity.region.timezone,
          },
          hardware: {
            osFamily: nextOs === 'macOS' ? 'macos' : nextOs === 'Linux' ? 'linux' : 'windows',
            browserFamily: nextBrowser === 'Firefox' ? 'firefox' : 'chromium',
            platform:
              preset?.config.identity.hardware.platform ||
              prev.identity.hardware.platform ||
              PLATFORM_BY_OS[nextOs],
            userAgent:
              preset?.config.identity.hardware.userAgent || prev.identity.hardware.userAgent,
            browserVersion:
              preset?.config.identity.hardware.browserVersion || prev.identity.hardware.browserVersion,
            fontSystem: nextOs === 'macOS' ? 'mac' : nextOs === 'Linux' ? 'linux' : 'windows',
            hardwareConcurrency:
              overrides.hardwareConcurrency ?? prev.identity.hardware.hardwareConcurrency,
            deviceMemory: overrides.deviceMemory ?? prev.identity.hardware.deviceMemory,
          },
          display: {
            width: nextWidth,
            height: nextHeight,
            availWidth: nextWidth,
            availHeight: Math.max(0, nextHeight - 40),
            colorDepth: prev.identity.display.colorDepth,
            ...(engine === 'electron' ? { pixelRatio: nextPixelRatio } : {}),
          },
          graphics: {
            webgl: {
              maskedVendor: nextGpuVendor,
              maskedRenderer: nextGpuRenderer,
              unmaskedVendor: nextGpuVendor,
              unmaskedRenderer: nextGpuRenderer,
            },
          },
          automationSignals: {
            webdriver: 0,
          },
        },
        ...(overrides.source ? { source: overrides.source } : {}),
      }),
      engine
    );
  };

  const alignFingerprintToSelection = (
    nextOs: FingerprintUIOS,
    nextBrowser: FingerprintUIBrowser
  ) => {
    setFingerprint((prev) =>
      rematerializeFingerprintFromSharedControls(prev, {
        os: nextOs,
        browser: nextBrowser,
      })
    );
  };

  const buildFingerprintCorePayload = (): FingerprintCoreConfig => {
    const materialized = rematerializeFingerprintFromSharedControls(fingerprint);
    const core = extractFingerprintCoreConfig(materialized);

    return {
      ...core,
      osFamily: os === 'macOS' ? 'macos' : os === 'Linux' ? 'linux' : 'windows',
      browserProfile: {
        ...core.browserProfile,
        browser: CORE_BROWSER_BY_UI[browser],
        presetId: selectedPreset !== 'custom' ? selectedPreset : undefined,
      },
      graphics: {
        ...core.graphics,
        maskedVendor: gpuVendor,
        maskedRenderer: gpuRenderer,
      },
    };
  };

  // 应用预设配置
  const applyPreset = (presetId: string) => {
    if (presetId === 'custom') {
      setSelectedPreset('custom');
      return;
    }

    const preset = FINGERPRINT_PRESET_OPTIONS.find((p) => p.id === presetId);
    if (preset) {
      setSelectedPreset(presetId);
      setOs(preset.os);
      setBrowser(preset.browser);

      // 合并预设配置和默认配置
      const df = getDefaultFingerprint(engine);
      const newFingerprint: FingerprintConfig = materializeFingerprintConfigForEngine(
        mergeFingerprintConfig(df, preset.config),
        engine
      );

      setFingerprint(newFingerprint);

      // 更新 WebGL 状态
      setGpuVendor(newFingerprint.identity.graphics?.webgl?.maskedVendor || '');
      setGpuRenderer(newFingerprint.identity.graphics?.webgl?.maskedRenderer || '');
    }
  };

  // 随机生成指纹（使用预设中的随机一个）
  const handleRandomGenerate = () => {
    const presetPool = availablePresets.length > 0 ? availablePresets : FINGERPRINT_PRESET_OPTIONS;
    const randomIndex = Math.floor(Math.random() * presetPool.length);
    const randomPreset = presetPool[randomIndex];
    applyPreset(randomPreset.id);
  };

  const handleEngineChange = (nextEngine: AutomationEngine) => {
    setEngine(nextEngine);
    setFingerprint((prev) => materializeFingerprintConfigForEngine(prev, nextEngine));
  };

  // 编辑模式：加载现有配置
  useEffect(() => {
    if (open && profileId) {
      isHydratingFingerprintRef.current = true;
      setActiveTab('basic');
      setAdvancedFingerprintOpen(false);
      setAdvancedPerformanceOpen(false);
      const profile = profiles.find((p) => p.id === profileId);
      if (profile) {
        setName(profile.name);
        setEngine(profile.engine);
        setNotes(profile.notes || '');
        setTags(profile.tags?.join(', ') || '');
        setGroupId(profile.groupId || '');
        setColor(profile.color || '');
        setIdleTimeoutMin(String(Math.round((profile.idleTimeoutMs || 0) / 60000) || 5));
        setLockTimeoutMin(String(Math.round((profile.lockTimeoutMs || 0) / 60000) || 5));

        // 代理
        if (profile.proxy && profile.proxy.type !== 'none') {
          setProxyEnabled(true);
          if (
            profile.proxy.type === 'http' ||
            profile.proxy.type === 'https' ||
            profile.proxy.type === 'socks4' ||
            profile.proxy.type === 'socks5'
          ) {
            setProxyType(profile.proxy.type);
          } else {
            setProxyType('http');
          }
          setProxyHost(profile.proxy.host || '');
          setProxyPort(String(profile.proxy.port || ''));
          setProxyUsername(profile.proxy.username || '');
          setProxyPassword(profile.proxy.password || '');
        } else {
          setProxyEnabled(false);
          setProxyType('http');
          setProxyHost('');
          setProxyPort('');
          setProxyUsername('');
          setProxyPassword('');
        }

        // 指纹
        const normalizedFingerprint =
          profile.fingerprintCore || profile.fingerprintSource
            ? materializeFingerprintConfigFromCore(
                profile.fingerprintCore ?? extractFingerprintCoreConfig(profile.fingerprint),
                profile.fingerprintSource ?? profile.fingerprint.source,
                profile.engine
              )
            : materializeFingerprintConfigForEngine(profile.fingerprint, profile.engine);
        setFingerprint(normalizedFingerprint);
        setOs(
          profile.fingerprintCore
            ? toFingerprintUIOSFromCore(profile.fingerprintCore.osFamily)
            : toFingerprintUIOS(normalizedFingerprint)
        );
        setBrowser(
          profile.fingerprintCore
            ? toFingerprintUIBrowserFromCore(profile.fingerprintCore.browserProfile.browser)
            : toFingerprintUIBrowser(normalizedFingerprint)
        );
        setGpuVendor(normalizedFingerprint.identity.graphics?.webgl?.maskedVendor || '');
        setGpuRenderer(normalizedFingerprint.identity.graphics?.webgl?.maskedRenderer || '');
        setSelectedPreset(profile.fingerprintCore?.browserProfile.presetId || 'custom');
      }
      queueMicrotask(() => {
        isHydratingFingerprintRef.current = false;
      });
    } else if (open) {
      isHydratingFingerprintRef.current = true;
      // 创建模式：重置表单
      setActiveTab('basic');
      setAdvancedFingerprintOpen(false);
      setAdvancedPerformanceOpen(false);
      setName('');
      setEngine('electron');
      setNotes('');
      setTags('');
      setGroupId('');
      setColor('');
      setIdleTimeoutMin(
        String(Math.round(DEFAULT_BROWSER_POOL_CONFIG.defaultIdleTimeoutMs / 60000))
      );
      setLockTimeoutMin(
        String(Math.round(DEFAULT_BROWSER_POOL_CONFIG.defaultLockTimeoutMs / 60000))
      );
      setProxyEnabled(false);
      setProxyType('http');
      setProxyHost('');
      setProxyPort('');
      setProxyUsername('');
      setProxyPassword('');
      setFingerprint(getDefaultFingerprint('electron'));
      setOs('Windows');
      setBrowser('Chrome');
      {
        const df = getDefaultFingerprint('electron');
        setGpuVendor(df.identity.graphics?.webgl?.maskedVendor || '');
        setGpuRenderer(df.identity.graphics?.webgl?.maskedRenderer || '');
      }
      setSelectedPreset('custom');
      queueMicrotask(() => {
        isHydratingFingerprintRef.current = false;
      });
    } else {
      isHydratingFingerprintRef.current = false;
    }
  }, [open, profileId, profiles]);

  useEffect(() => {
    if (!open) return;
    if (activeTab !== 'advanced') {
      setAdvancedFingerprintOpen(false);
      setAdvancedPerformanceOpen(false);
    }
  }, [activeTab, open]);

  useEffect(() => {
    if (open) {
      loadGroups();
    }
  }, [open, loadGroups]);

  useEffect(() => {
    if (!open || isHydratingFingerprintRef.current) return;
    if (availableBrowsers.includes(browser)) {
      return;
    }
    const fallbackBrowser = availableBrowsers[0];
    if (!fallbackBrowser) {
      return;
    }
    setSelectedPreset('custom');
    setBrowser(fallbackBrowser);
    alignFingerprintToSelection(os, fallbackBrowser);
  }, [availableBrowsers, browser, open, os]);

  // 更新指纹的 OS 和浏览器
  useEffect(() => {
    if (!open || isHydratingFingerprintRef.current) return;

    // 当 OS 变化时，仅在当前选项不合法时才重置 GPU（避免覆盖预设/用户选择）
    const newGpuOptions = getGPUOptions(os);
    const vendorOption = newGpuOptions.find((opt) => opt.vendor === gpuVendor);
    if (!vendorOption && newGpuOptions.length > 0) {
      const firstVendor = newGpuOptions[0];
      setGpuVendor(firstVendor.vendor);
      setGpuRenderer(firstVendor.renderers[0] || '');
    } else if (vendorOption && vendorOption.renderers.length > 0) {
      if (!vendorOption.renderers.includes(gpuRenderer)) {
        setGpuRenderer(vendorOption.renderers[0]);
      }
    }
  }, [gpuRenderer, gpuVendor, open, os]);

  // 更新指纹的 WebGL 配置
  useEffect(() => {
    if (!open || isHydratingFingerprintRef.current) return;
    setFingerprint((prev) =>
      rematerializeFingerprintFromSharedControls(prev, {
        gpuVendor,
        gpuRenderer,
      })
    );
  }, [gpuRenderer, gpuVendor, open]);

  // 提交表单
  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.warning('请填写配置名称');
      return;
    }

    setIsSubmitting(true);

    try {
      // 构建代理配置
      let proxy: ProxyConfig | null = null;
      if (proxyEnabled) {
        const host = proxyHost.trim();
        const rawPort = proxyPort.trim();
        if (!host || !rawPort) {
          toast.warning('请填写代理主机和端口');
          return;
        }

        const port = Number.parseInt(rawPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          toast.warning('代理端口必须是 1-65535 的整数');
          return;
        }

        proxy = {
          type: proxyType,
          host,
          port,
          username: proxyUsername.trim() || undefined,
          password: proxyPassword.trim() || undefined,
        };
      }

      // 构建标签数组
      const tagArray = tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const quotaValue = DEFAULT_BROWSER_PROFILE.quota;
      const idleTimeoutMsValue = Math.min(
        BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.max,
        Math.max(
          BROWSER_POOL_LIMITS.defaultIdleTimeoutMs.min,
          (Number.parseInt(idleTimeoutMin, 10) || 5) * 60 * 1000
        )
      );
      const lockTimeoutMsValue = Math.min(
        BROWSER_POOL_LIMITS.defaultLockTimeoutMs.max,
        Math.max(
          BROWSER_POOL_LIMITS.defaultLockTimeoutMs.min,
          (Number.parseInt(lockTimeoutMin, 10) || 5) * 60 * 1000
        )
      );

      let fingerprintPayload: FingerprintConfig =
        rematerializeFingerprintFromSharedControls(fingerprint);
      const fingerprintCorePayload = buildFingerprintCorePayload();
      const fingerprintSourcePayload = {
        mode: 'generated' as const,
        fileFormat: 'txt' as const,
      };

      fingerprintPayload = materializeFingerprintConfigForEngine(fingerprintPayload, engine);

      const fingerprintValidation = validateFingerprintConfig(fingerprintPayload, engine);
      if (!fingerprintValidation.valid) {
        toast.warning(`指纹配置无效: ${fingerprintValidation.warnings.join(', ')}`);
        return;
      }

      if (profileId) {
        // 更新
        const params: UpdateProfileParams = {
          name: trimmedName,
          engine,
          groupId: groupId ? groupId : null,
          color: color ? color : null,
          notes: notes.trim() || null,
          tags: tagArray,
          proxy: proxyEnabled ? proxy : null,
          fingerprint: fingerprintPayload,
          fingerprintCore: fingerprintCorePayload,
          fingerprintSource: fingerprintSourcePayload,
          quota: quotaValue,
          idleTimeoutMs: idleTimeoutMsValue,
          lockTimeoutMs: lockTimeoutMsValue,
        };
        const updated = await updateProfile(profileId, params);
        if (!updated) {
          toast.error('保存失败', '请检查配置项后重试');
          return;
        }
      } else {
        // 创建
        const params: CreateProfileParams = {
          name: trimmedName,
          engine,
          groupId: groupId ? groupId : null,
          color: color ? color : null,
          proxy: proxyEnabled ? proxy : null,
          fingerprint: fingerprintPayload,
          fingerprintCore: fingerprintCorePayload,
          fingerprintSource: fingerprintSourcePayload,
          notes: notes.trim() || null,
          tags: tagArray.length > 0 ? tagArray : undefined,
          quota: quotaValue,
          idleTimeoutMs: idleTimeoutMsValue,
          lockTimeoutMs: lockTimeoutMsValue,
        };
        const created = await createProfile(params);
        if (!created) {
          toast.error('创建失败', '请检查配置项后重试');
          return;
        }
      }

      await onProfileMutationApplied?.();
      onClose();
    } catch (error) {
      toast.error(
        profileId ? '保存失败' : '创建失败',
        error instanceof Error ? error.message : '未知错误'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateGroup = async () => {
    const groupName = window.prompt('请输入分组名称');
    if (!groupName || !groupName.trim()) return;
    try {
      const created = await createGroup({ name: groupName.trim() });
      if (created) {
        setGroupId(created.id);
      }
    } catch (error) {
      console.error('[ProfileFormDialog] Failed to create group:', error);
      toast.error('创建分组失败', error instanceof Error ? error.message : '未知错误');
    }
  };

  const handleDialogClose = () => {
    onOpenChange(false);
    onClose();
  };
  const tagPreview = tags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
  const controlClassName = 'shell-field-input h-10 px-3 py-2 text-sm';
  const textAreaClassName = 'shell-field-input min-h-[104px] resize-y px-3 py-2 text-sm';
  const checkboxClassName =
    'h-4 w-4 rounded border-slate-300 text-primary focus:ring-2 focus:ring-primary/30';

  return (
    <DialogV2
      open={open}
      onClose={handleDialogClose}
      title={profileId ? '编辑浏览器配置' : '新建浏览器配置'}
      maxWidth="5xl"
      closeOnEsc={!isSubmitting}
      closeOnBackdropClick={!isSubmitting}
      disableCloseButton={isSubmitting}
      className="shell-drawer-surface mx-0 ml-auto mr-0 mt-[var(--app-titlebar-height)] flex h-[calc(100dvh-var(--app-titlebar-height))] max-h-[calc(100dvh-var(--app-titlebar-height))] max-w-[920px] self-start flex-col rounded-none border-y-0 border-r-0"
      contentClassName="shell-content-muted flex-1 overflow-y-auto p-5"
      footer={
        <>
          <Button
            variant="outline"
            onClick={handleDialogClose}
            disabled={isSubmitting}
            className="h-10 rounded-xl"
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !name.trim()}
            className="h-10 rounded-xl"
          >
            {isSubmitting ? '保存中...' : profileId ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <TabsList className="shell-tab-strip h-auto w-full justify-start bg-transparent p-1 text-slate-500 shadow-none">
            <TabsTrigger value="basic" className="h-10 flex-1 rounded-xl">
              基本信息
            </TabsTrigger>
            <TabsTrigger value="proxy" className="h-10 flex-1 rounded-xl">
              代理设置
            </TabsTrigger>
            <TabsTrigger value="advanced" className="h-10 flex-1 rounded-xl">
              高级设置
            </TabsTrigger>
          </TabsList>

          {/* 基本信息 */}
          <TabsContent value="basic" className="mt-0 space-y-4">
            <section className="shell-soft-card space-y-4 p-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-xs font-medium text-slate-600">
                    配置名称 *
                  </Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：工作账号、测试环境"
                    className={controlClassName}
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium text-slate-600">引擎</Label>
                    <Select
                      value={engine}
                      onValueChange={(v) => handleEngineChange(v as AutomationEngine)}
                      className={controlClassName}
                    >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="electron">Electron</SelectItem>
                      <SelectItem value="extension">Extension</SelectItem>
                      <SelectItem value="ruyi">Ruyi</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-slate-500">
                    每个 Profile 只绑定一个引擎；运行面板与插件将按该引擎启动或复用。
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr),minmax(0,260px)]">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-xs font-medium text-slate-600">分组</Label>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={handleCreateGroup}
                      className="h-10 rounded-xl px-4"
                    >
                      新建分组
                    </Button>
                  </div>
                  <Select value={groupId} onValueChange={setGroupId} className={controlClassName}>
                    <option value="">无分组</option>
                    {flattenedGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.label}
                      </SelectItem>
                    ))}
                  </Select>
                  {flattenedGroups.length === 0 ? (
                    <p className="text-xs leading-5 text-slate-500">
                      暂无分组，可点击「新建分组」后立即归类。
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium text-slate-600">颜色</Label>
                  <div className="shell-content-muted flex items-center gap-3 rounded-[18px] border border-slate-200/80 p-3">
                    <div
                      className="h-6 w-6 flex-shrink-0 rounded-full border border-slate-200 bg-white"
                      style={{
                        backgroundColor: color || 'transparent',
                      }}
                      title={color || '未设置'}
                    />
                    <Input
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      placeholder="#RRGGBB（可选）"
                      className={cn(controlClassName, 'bg-white')}
                    />
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => setColor('')}
                      disabled={!color}
                      className="h-10 rounded-xl px-4"
                    >
                      清除
                    </Button>
                  </div>
                </div>
              </div>
            </section>

            <section className="shell-soft-card space-y-4 p-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),280px]">
                <div className="space-y-2">
                  <Label htmlFor="notes" className="text-xs font-medium text-slate-600">
                    备注
                  </Label>
                  <textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="记录用途、负责人、账号限制或其他说明"
                    className={textAreaClassName}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="tags" className="text-xs font-medium text-slate-600">
                    标签（逗号分隔）
                  </Label>
                  <Input
                    id="tags"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="例如：工作, 重要, VIP"
                    className={controlClassName}
                  />
                  <div className="shell-content-muted min-h-[104px] rounded-[18px] border border-slate-200/80 p-3">
                    {tagPreview.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {tagPreview.map((tag) => (
                          <span key={tag} className="shell-field-chip px-3 py-1.5 text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs leading-5 text-slate-500">输入标签</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </TabsContent>

          {/* 代理设置 */}
          <TabsContent value="proxy" className="mt-0 space-y-4">
            <section className="shell-soft-card space-y-4 p-5">
              <DialogSectionHeader
                title="代理设置"
                description="启动该 Profile 时会自动带入代理参数。"
              />

              <label className="shell-content-muted flex items-start gap-3 rounded-[18px] border border-slate-200/80 p-4">
                <input
                  type="checkbox"
                  id="proxyEnabled"
                  checked={proxyEnabled}
                  onChange={(e) => setProxyEnabled(e.target.checked)}
                  className={checkboxClassName}
                />
                <div className="space-y-1">
                  <span className="text-sm font-medium text-slate-900">启用代理</span>
                </div>
              </label>

              {proxyEnabled ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-xs font-medium text-slate-600">代理类型</Label>
                    <Select
                      value={proxyType}
                      onValueChange={(v) =>
                        setProxyType(v as 'http' | 'https' | 'socks4' | 'socks5')
                      }
                      className={controlClassName}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="https">HTTPS</SelectItem>
                        <SelectItem value="socks4">SOCKS4</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="proxyHost" className="text-xs font-medium text-slate-600">
                      主机地址
                    </Label>
                    <Input
                      id="proxyHost"
                      value={proxyHost}
                      onChange={(e) => setProxyHost(e.target.value)}
                      placeholder="127.0.0.1"
                      className={controlClassName}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="proxyPort" className="text-xs font-medium text-slate-600">
                      端口
                    </Label>
                    <Input
                      id="proxyPort"
                      type="number"
                      value={proxyPort}
                      onChange={(e) => setProxyPort(e.target.value)}
                      placeholder="1080"
                      className={controlClassName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="proxyUsername" className="text-xs font-medium text-slate-600">
                      用户名（可选）
                    </Label>
                    <Input
                      id="proxyUsername"
                      value={proxyUsername}
                      onChange={(e) => setProxyUsername(e.target.value)}
                      className={controlClassName}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="proxyPassword" className="text-xs font-medium text-slate-600">
                      密码（可选）
                    </Label>
                    <Input
                      id="proxyPassword"
                      type="password"
                      value={proxyPassword}
                      onChange={(e) => setProxyPassword(e.target.value)}
                      className={controlClassName}
                    />
                  </div>
                </div>
              ) : (
                <div className="shell-content-muted rounded-[18px] border border-slate-200/80 p-4 text-sm text-slate-500">
                  当前未启用代理。保留为空时，环境会按本机默认网络直接启动。
                </div>
              )}
            </section>
          </TabsContent>

          {/* 指纹配置 */}
          <TabsContent value="advanced" className="mt-0">
            <AdvancedSection
              title="指纹配置"
              description="默认收起；只在需要细调环境伪装和 Ruyi 指纹注入时展开。"
              open={advancedFingerprintOpen}
              onToggle={() => setAdvancedFingerprintOpen((prev) => !prev)}
            >
              <div className="space-y-4">
                {/* 快速配置区域 */}
                <div className="shell-content-muted space-y-3 rounded-[18px] border border-slate-200/80 p-4">
                  <Label className="text-sm font-medium text-slate-900">快速配置</Label>
                  <div className="flex gap-3">
                    <Select
                      value={selectedPreset}
                      onValueChange={applyPreset}
                      className={cn(controlClassName, 'flex-1')}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="选择预设配置" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="custom">自定义配置</SelectItem>
                        {availablePresets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name} - {preset.description}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      onClick={handleRandomGenerate}
                      className="h-10 rounded-xl"
                    >
                      随机生成
                    </Button>
                  </div>
                  <p className="text-xs leading-5 text-slate-500">
                    {isExtensionEngine
                      ? 'Extension 会把统一身份配置物化为 Chromium 原生文本文件，通过 --ruyi 交给内核，并额外叠加内置控制扩展；启动真值按 FingerPrintJSBrowser README 描述字段已在真实页面验证。'
                      : isRuyiEngine
                        ? 'Ruyi 引擎会将配置写入 Firefox fpfile，并通过原生 Firefox/BiDi 运行时启动持久化环境；运行时 emulation 仍属于 best-effort。'
                        : 'Electron 会忽略原生文件来源配置，只消费 identity 中的浏览器画像。'}
                  </p>
                </div>

                {/* 系统信息 */}
                <div className="shell-content-muted space-y-3 rounded-[18px] border border-slate-200/80 p-4">
                  <Label className="text-sm font-medium text-slate-900">系统信息</Label>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">操作系统</Label>
                      <Select
                        value={os}
                        onValueChange={(v) => {
                          const nextOs = v as FingerprintUIOS;
                          setSelectedPreset('custom');
                          setOs(nextOs);
                          alignFingerprintToSelection(nextOs, browser);
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Windows">Windows</SelectItem>
                          <SelectItem value="macOS">macOS</SelectItem>
                          <SelectItem value="Linux">Linux</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">浏览器</Label>
                      <Select
                        value={browser}
                        onValueChange={(v) => {
                          const next = v as FingerprintUIBrowser;
                          setSelectedPreset('custom');
                          setBrowser(next);
                          alignFingerprintToSelection(os, next);
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableBrowsers.map((browserOption) => (
                            <SelectItem key={browserOption} value={browserOption}>
                              {browserOption}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                {/* 硬件配置 */}
                <div className="shell-content-muted space-y-3 rounded-[18px] border border-slate-200/80 p-4">
                  <Label className="text-sm font-medium text-slate-900">硬件配置</Label>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-slate-600">屏幕分辨率</Label>
                    <Select
                      value={`${display.width}x${display.height}`}
                      onValueChange={(v) => {
                        const [width, height] = v.split('x').map(Number);
                        const resolution = screenResolutions.find(
                          (r) => r.width === width && r.height === height
                        );
                        setSelectedPreset('custom');
                        setFingerprint((prev) =>
                          rematerializeFingerprintFromSharedControls(prev, {
                            width,
                            height,
                            pixelRatio: resolution?.pixelRatio,
                          })
                        );
                      }}
                      className={controlClassName}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {screenResolutions.map((res) => (
                          <SelectItem key={res.label} value={`${res.width}x${res.height}`}>
                            {res.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">CPU 核心数</Label>
                      <Select
                        value={String(hardware.hardwareConcurrency || 8)}
                        onValueChange={(v) => {
                          setSelectedPreset('custom');
                          setFingerprint((prev) =>
                            rematerializeFingerprintFromSharedControls(prev, {
                              hardwareConcurrency: parseInt(v, 10),
                            })
                          );
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CPU_CORES_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={String(opt.value)}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">设备内存</Label>
                      <Select
                        value={String(hardware.deviceMemory || 8)}
                        onValueChange={(v) => {
                          setSelectedPreset('custom');
                          setFingerprint((prev) =>
                            rematerializeFingerprintFromSharedControls(prev, {
                              deviceMemory: parseInt(v, 10),
                            })
                          );
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DEVICE_MEMORY_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={String(opt.value)}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <p className="text-xs leading-5 text-slate-500">
                    颜色深度、像素比、触摸能力等隐藏字段会按当前分辨率模板和引擎契约自动推导。
                  </p>
                </div>

                {/* WebGL 配置 */}
                <div className="shell-content-muted space-y-3 rounded-[18px] border border-slate-200/80 p-4">
                  <Label className="text-sm font-medium text-slate-900">WebGL 配置</Label>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">GPU 厂商</Label>
                      <Select
                        value={gpuVendor}
                        onValueChange={(value) => {
                          setSelectedPreset('custom');
                          setGpuVendor(value);
                          const nextRenderer =
                            gpuOptions.find((option) => option.vendor === value)?.renderers[0] || '';
                          setGpuRenderer(nextRenderer);
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {gpuOptions.map((opt) => (
                            <SelectItem key={opt.vendor} value={opt.vendor}>
                              {opt.vendor}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">GPU 型号</Label>
                      <Select
                        value={gpuRenderer}
                        onValueChange={(value) => {
                          setSelectedPreset('custom');
                          setGpuRenderer(value);
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {rendererOptions.map((renderer) => (
                            <SelectItem key={renderer} value={renderer}>
                              {renderer.length > 50 ? renderer.substring(0, 50) + '...' : renderer}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <p className="text-xs leading-5 text-slate-500">
                    WebGL 版本字符串和更细的数值上限由引擎模板自动补齐，不再单独暴露。
                  </p>
                </div>

                {/* 国际化配置 */}
                <div className="shell-content-muted space-y-3 rounded-[18px] border border-slate-200/80 p-4">
                  <Label className="text-sm font-medium text-slate-900">国际化</Label>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-medium text-slate-600">时区</Label>
                      <Select
                        value={region.timezone}
                        onValueChange={(v) => {
                          setSelectedPreset('custom');
                          setFingerprint((prev) =>
                            rematerializeFingerprintFromSharedControls(prev, {
                              timezone: v,
                            })
                          );
                        }}
                        className={controlClassName}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIMEZONE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label className="text-xs font-medium text-slate-600">语言列表</Label>
                      <textarea
                        className={textAreaClassName}
                        value={stringifyDelimitedList(region.languages)}
                        onChange={(e) => {
                          setSelectedPreset('custom');
                          setFingerprint((prev) =>
                            rematerializeFingerprintFromSharedControls(prev, {
                              languages: parseDelimitedList(e.target.value),
                            })
                          );
                        }}
                        placeholder={'例如：zh-CN\nzh\nen-US\nen'}
                      />
                    </div>
                  </div>

                  <p className="text-xs leading-5 text-slate-500">
                    首项会自动作为 primaryLanguage；User-Agent、platform、fontSystem、webdriver
                    等隐藏字段会在保存前按当前画像自动重建。
                  </p>
                </div>

              </div>
            </AdvancedSection>
          </TabsContent>

          {/* 性能 */}
          <TabsContent value="advanced" className="mt-0">
            <AdvancedSection
              title="性能"
              description="单实例模式下只保留空闲回收、锁定超时和重启入口。"
              open={advancedPerformanceOpen}
              onToggle={() => setAdvancedPerformanceOpen((prev) => !prev)}
            >
              <div className="space-y-4">
                <div className="shell-content-muted space-y-2 rounded-[18px] border border-slate-200/80 p-4">
                  <p className="text-xs text-amber-600">
                    每个 Profile 统一只保留 1 个 live 浏览器实例；再次启动会复用或等待当前实例释放。
                  </p>
                </div>

                <div className="shell-content-muted grid grid-cols-2 gap-4 rounded-[18px] border border-slate-200/80 p-4">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-slate-600">空闲回收（分钟）</Label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={idleTimeoutMin}
                      onChange={(e) => setIdleTimeoutMin(e.target.value)}
                      className={controlClassName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-slate-600">锁定超时（分钟）</Label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={lockTimeoutMin}
                      onChange={(e) => setLockTimeoutMin(e.target.value)}
                      className={controlClassName}
                    />
                  </div>
                </div>

                {profileId && (
                  <div className="shell-content-muted rounded-[18px] border border-slate-200/80 p-4">
                    <Label className="text-sm font-medium text-slate-900">应用变更</Label>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      代理/性能设置不会自动应用到已打开的浏览器实例；如需立即生效，请重启该配置下的浏览器。
                    </p>
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        type="button"
                        className="h-10 rounded-xl"
                        onClick={async () => {
                          if (!profileId) return;
                          if (!window.confirm('将关闭该配置下所有已打开的浏览器，确定要重启吗？'))
                            return;
                          const result =
                            await window.electronAPI.profile.poolDestroyProfileBrowsers(profileId);
                          if (result.success) {
                            toast.success('已重启该配置下的浏览器');
                          } else {
                            toast.error('重启失败', result.error || '未知错误');
                          }
                        }}
                      >
                        重启该配置下所有浏览器
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </AdvancedSection>
          </TabsContent>
        </Tabs>
      </div>
    </DialogV2>
  );
}
