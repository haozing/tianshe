import { createRequiredFieldsVerifier } from '../../shared/snapshot-utils';

export const npmPackageSummaryVerifier = createRequiredFieldsVerifier(
  'npm-package-summary-required-fields',
  ['packageName', 'description', 'version', 'weeklyDownloadCount', 'license', 'sourceUrl']
);
