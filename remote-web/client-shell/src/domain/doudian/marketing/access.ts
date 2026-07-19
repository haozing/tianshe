export function marketingPageAccessEnabled(
  config: { features?: Record<string, { enabled?: boolean }> },
  adapter: { capabilities?: { marketing?: { features?: Record<string, { read?: boolean; writeActions?: string[] }> } } } | null | undefined,
  feature: string,
  pageFlag: string,
  contractValid: boolean
) {
  return config.features?.marketingMenu?.enabled === true &&
    config.features?.[pageFlag]?.enabled === true &&
    adapter?.capabilities?.marketing?.features?.[feature]?.read === true &&
    contractValid;
}

export function marketingWriteAccessEnabled(
  config: { features?: Record<string, { enabled?: boolean }> },
  adapter: { capabilities?: { marketing?: { features?: Record<string, { read?: boolean; writeActions?: string[] }> } } } | null | undefined,
  feature: string,
  pageFlag: string,
  action: string,
  contractValid: boolean,
  mutationActionValid: boolean
) {
  return marketingPageAccessEnabled(config, adapter, feature, pageFlag, contractValid) &&
    adapter?.capabilities?.marketing?.features?.[feature]?.writeActions?.includes(action) === true &&
    mutationActionValid;
}
