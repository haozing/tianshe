import { URL } from 'url';
import path from 'path';
import { AIRPA_RUNTIME_CONFIG, isDevelopmentMode } from '../constants/runtime-config';

export function resolveHtmlPath(htmlFileName: string) {
  if (isDevelopmentMode()) {
    const port = AIRPA_RUNTIME_CONFIG.app.devServerPort;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}
