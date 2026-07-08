import type { DoudianAdapterPayload } from "../../types";

export interface SignRequest {
  targetUrl: string;
  partition?: string;
  plan?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export async function signDoudianRequest(_payload: DoudianAdapterPayload, request: SignRequest) {
  return {
    ok: false,
    reason: "signer-window-unavailable",
    targetUrl: request.targetUrl,
    query: "",
    signature: ""
  };
}
