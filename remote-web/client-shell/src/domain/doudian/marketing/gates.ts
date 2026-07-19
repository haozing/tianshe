import { isValidMarketingContract, isValidMarketingMutationAction } from "../../../bridge/doudianAdapter";
import type { ChihuConfig, DoudianAdapterConfig, MarketingFeature } from "../../../types";
import { marketingPageAccessEnabled, marketingWriteAccessEnabled } from "./access";

const PAGE_FLAGS: Record<MarketingFeature, string> = {
  limited_time: "marketingLimitedTime",
  new_user_bonus: "marketingNewUserBonus",
  general_coupon: "marketingGeneralCoupon"
};

export function marketingPageEnabled(config: ChihuConfig, adapter: DoudianAdapterConfig | null | undefined, feature: MarketingFeature) {
  return marketingPageAccessEnabled(config, adapter, feature, PAGE_FLAGS[feature], !!adapter && isValidMarketingContract(adapter));
}

export function marketingWriteEnabled(config: ChihuConfig, adapter: DoudianAdapterConfig | null | undefined, feature: MarketingFeature, action: string) {
  return marketingWriteAccessEnabled(
    config,
    adapter,
    feature,
    PAGE_FLAGS[feature],
    action,
    !!adapter && isValidMarketingContract(adapter),
    !!adapter && isValidMarketingMutationAction(adapter, feature, action)
  );
}
