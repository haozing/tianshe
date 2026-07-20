import type { DoudianAdapterPayload } from "../../types";
import { requireChihuNative } from "../../native/client";
import { signWithXzbMstoken } from "./xzbSigner";
import { reportDoudianDiagnostic } from "./diagnosticLog";

export interface SignRequest {
  targetUrl: string;
  partition?: string;
  planKey?: string;
  plan?: Record<string, unknown>;
  context?: Record<string, unknown>;
  trackWindow?: (winId: number) => void;
}

interface SignResult {
  ok: boolean;
  reason?: string;
  targetUrl: string;
  query: string;
  signature: string;
  source?: string;
  mode?: string;
  error?: string;
}

function text(value: unknown) {
  return String(value || "");
}

function numericPlanValue(plan: Record<string, unknown> | undefined, key: string, fallback: number) {
  const value = Number(plan?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function adapterTimeout(payload: DoudianAdapterPayload, key: string, fallback: number) {
  const value = Number(payload.adapter.timeouts?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function signerWindowUrl(payload: DoudianAdapterPayload, request: SignRequest) {
  const plan = request.plan || {};
  const candidate = typeof plan.signerUrl === "string" && plan.signerUrl ? plan.signerUrl : "";
  if (candidate) return candidate;
  return payload.adapter.homeUrl || payload.adapter.loginUrl || payload.adapter.origin;
}

export async function signDoudianRequest(payload: DoudianAdapterPayload, request: SignRequest): Promise<SignResult> {
  const plan = request.plan || {};
  if (plan.signStrategy === "mstoken-myargs" || plan.localSigner === true) {
    const localResult = await signWithXzbMstoken(payload, request);
    if (localResult.ok) {
      await reportDoudianDiagnostic({
        category: "doudian-request-plan",
        event: "signed",
        planKey: request.planKey,
        partition: request.partition || payload.adapter.signerPartition || payload.adapter.sourcePartition,
        openUrl: text(plan.signerUrl),
        targetUrl: request.targetUrl,
        source: localResult.source,
        mode: localResult.mode,
        hasQuery: !!localResult.query,
        hasSignature: !!localResult.signature,
        hasMsToken: !!localResult.detail?.hasMsToken,
        queryLength: localResult.detail?.queryLength,
        bodyLength: localResult.detail?.bodyLength
      });
      return localResult;
    }

    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "sign-failed",
      planKey: request.planKey,
      partition: request.partition || payload.adapter.signerPartition || payload.adapter.sourcePartition,
      openUrl: text(plan.signerUrl),
      targetUrl: request.targetUrl,
      reason: localResult.reason || "local-sign-failed",
      source: localResult.source,
      mode: localResult.mode,
      hasMsToken: !!localResult.detail?.hasMsToken,
      queryLength: localResult.detail?.queryLength,
      bodyLength: localResult.detail?.bodyLength,
      message: localResult.error
    }, true);
    if (plan.localSigner === true || plan.localSignerOnly === true) return localResult;
  }

  const signFactory = payload.scripts?.signFactory;
  if (!signFactory) {
    return { ok: false, reason: "sign-factory-missing", targetUrl: request.targetUrl, query: "", signature: "" };
  }

  const native = requireChihuNative();
  const partition = request.partition || payload.adapter.signerPartition || payload.adapter.sourcePartition;
  const signerUrl = signerWindowUrl(payload, request);
  const waitMs = Math.max(0, numericPlanValue(plan, "signerWaitMs", adapterTimeout(payload, "signerLoadMs", 3000)));
  const timeoutMs = Math.max(3000, numericPlanValue(plan, "signerTimeoutMs", adapterTimeout(payload, "signerLoadMs", 15000)));
  let winId: number | null = null;

  try {
    winId = await native.windows.open({
      url: signerUrl,
      partition,
      show: false,
      waitForLoad: false,
      width: 480,
      height: 360,
      title: "Chihu Doudian Signer",
      nodeIntegration: false,
      contextIsolation: true
    });
    request.trackWindow?.(winId);
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));

    const result = await native.windows.command({
      winId,
      command: "sign",
      args: { planKey: request.planKey || "", targetUrl: request.targetUrl, context: request.context || {} },
      timeoutMs
    }) as Record<string, unknown> | null;
    const query = text(result?.query || result?.myargs);
    const signature = text(result?.signature);
    if (result?.ok === true && (query || signature)) {
      await reportDoudianDiagnostic({
        category: "doudian-request-plan",
        event: "signed",
        planKey: request.planKey,
        partition,
        openUrl: signerUrl,
        targetUrl: request.targetUrl,
        source: text(result.source),
        mode: text(result.mode),
        hasQuery: !!query,
        hasSignature: !!signature
      });
      return {
        ok: true,
        targetUrl: request.targetUrl,
        query,
        signature,
        source: text(result.source),
        mode: text(result.mode)
      };
    }
    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "sign-failed",
      planKey: request.planKey,
      partition,
      openUrl: signerUrl,
      targetUrl: request.targetUrl,
      reason: text(result?.reason || "empty-signature"),
      source: text(result?.source),
      mode: text(result?.mode)
    }, true);
    return {
      ok: false,
      reason: text(result?.reason || "empty-signature"),
      targetUrl: request.targetUrl,
      query,
      signature
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportDoudianDiagnostic({
      category: "doudian-request-plan",
      event: "sign-failed",
      planKey: request.planKey,
      partition,
      openUrl: signerUrl,
      targetUrl: request.targetUrl,
      reason: "signer-window-error",
      message
    }, true);
    return {
      ok: false,
      reason: "signer-window-error",
      targetUrl: request.targetUrl,
      query: "",
      signature: "",
      error: message
    };
  } finally {
    if (winId != null) await native.windows.destroy({ winId }).catch(() => undefined);
  }
}
