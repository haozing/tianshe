import logoUrl from '../../../../assets/brand/tianshe-mark.svg';
import { APP_BRAND as SHARED_APP_BRAND } from '../../../shared/app-brand';

export interface RendererAppBrand {
  displayName: string;
  shortName: string;
  windowTitle: string;
  logoAlt: string;
  logoUrl: string;
}

export const APP_BRAND: RendererAppBrand = {
  ...SHARED_APP_BRAND,
  logoUrl,
};
