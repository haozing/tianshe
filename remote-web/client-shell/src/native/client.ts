import type { ChihuNativeApi } from "./types";

export function getChihuNative(): ChihuNativeApi | null {
  return window.chihuNative || null;
}

export function hasChihuNative(): boolean {
  return Boolean(getChihuNative());
}

export function requireChihuNative(): ChihuNativeApi {
  const native = getChihuNative();
  if (!native) throw new Error("window.chihuNative is unavailable");
  return native;
}
