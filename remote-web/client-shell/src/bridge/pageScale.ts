import type { ChihuPreferences, PageScale } from "./storage";
import type { NativeMainZoomResult } from "../native/types";

export type PageScaleChangeResult = {
  ok: boolean;
  factor: PageScale;
  message?: string;
};

export type PageScaleUpdate = {
  result: PageScaleChangeResult;
  preferences?: ChihuPreferences;
};

type PageScaleUpdateArgs = {
  scale: PageScale;
  previousScale: PageScale;
  applyZoom: (scale: PageScale) => Promise<NativeMainZoomResult>;
  savePreferences: (patch: Partial<ChihuPreferences>) => ChihuPreferences;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : error ? String(error) : fallback;
}

export async function applyAndPersistPageScale({
  scale,
  previousScale,
  applyZoom,
  savePreferences
}: PageScaleUpdateArgs): Promise<PageScaleUpdate> {
  let applied: NativeMainZoomResult;
  try {
    applied = await applyZoom(scale);
  } catch (error) {
    return { result: { ok: false, factor: previousScale, message: errorMessage(error, "页面大小设置失败") } };
  }

  if (!applied.ok) {
    return { result: { ok: false, factor: previousScale, message: applied.message || "页面大小设置失败" } };
  }

  try {
    const preferences = savePreferences({ pageScale: applied.factor });
    return { result: { ok: true, factor: preferences.pageScale }, preferences };
  } catch (error) {
    try {
      const restored = await applyZoom(previousScale);
      if (restored.ok) {
        return {
          result: {
            ok: false,
            factor: previousScale,
            message: "页面大小未能保存，已恢复原设置"
          }
        };
      }
    } catch {}

    return {
      result: {
        ok: false,
        factor: previousScale,
        message: `页面大小未能保存，且恢复失败：${errorMessage(error, "请重启客户端")}`
      }
    };
  }
}
