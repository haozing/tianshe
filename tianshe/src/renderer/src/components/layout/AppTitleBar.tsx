import { APP_BRAND } from '../../brand/appBrand';

export function AppTitleBar() {
  return (
    <div className="app-titlebar" aria-hidden="true">
      <div className="app-titlebar__brand">
        <img className="app-titlebar__logo" src={APP_BRAND.logoUrl} alt={APP_BRAND.logoAlt} />
        <span className="app-titlebar__name">{APP_BRAND.displayName}</span>
      </div>
    </div>
  );
}

export default AppTitleBar;
