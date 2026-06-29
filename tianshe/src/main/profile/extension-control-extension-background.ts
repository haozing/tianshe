import { renderCommandRuntime } from './extension-control-extension-background-command';
import { renderDomTaskRuntime } from './extension-control-extension-background-dom-task';
import { renderFooter } from './extension-control-extension-background-footer';
import { renderPrelude } from './extension-control-extension-background-prelude';
import {
  getDefaultRuntimeConfig,
  type ExtensionBackgroundRuntimeConfig,
} from './extension-control-extension-background-runtime';

export type { ExtensionBackgroundRuntimeConfig } from './extension-control-extension-background-runtime';

export function renderBackgroundScript(
  runtimeConfig: ExtensionBackgroundRuntimeConfig = getDefaultRuntimeConfig()
): string {
  return [
    renderPrelude(runtimeConfig),
    renderDomTaskRuntime(),
    renderCommandRuntime(),
    renderFooter(),
  ].join('\n\n');
}
