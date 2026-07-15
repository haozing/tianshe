import { getPreferences } from "../../bridge/storage";
import { requireChihuNative } from "../../native/client";

export function detailedDoudianLoggingEnabled() {
  return getPreferences().autoOperationLog === true;
}

export async function reportDoudianDiagnostic(payload: Record<string, unknown>, always = false) {
  if (!always && !detailedDoudianLoggingEnabled()) return;
  await requireChihuNative().logs.report(payload).catch(() => undefined);
}
