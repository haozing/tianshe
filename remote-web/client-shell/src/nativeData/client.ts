import type { NativeDataApi } from "./types";

export function getNativeData(): NativeDataApi | null {
  return window.nativeData || window.chihuNative?.nativeData || null;
}

export function hasNativeData(): boolean {
  return Boolean(getNativeData());
}

export function requireNativeData(): NativeDataApi {
  const nativeData = getNativeData();
  if (!nativeData) throw new Error("window.nativeData is unavailable");
  return nativeData;
}
