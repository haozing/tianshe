import { renderCommandBrowserRuntime } from './extension-control-extension-background-command-browser';
import { renderCommandDispatcher } from './extension-control-extension-background-command-dispatcher';
import { renderCommandEmulationRuntime } from './extension-control-extension-background-command-emulation';
import { renderCommandInputRuntime } from './extension-control-extension-background-command-input';
import { renderCommandNetworkRuntime } from './extension-control-extension-background-command-network';

export function renderCommandRuntime(): string {
  return [
    renderCommandEmulationRuntime(),
    renderCommandInputRuntime(),
    renderCommandNetworkRuntime(),
    renderCommandBrowserRuntime(),
    renderCommandDispatcher(),
  ].join('\n\n');
}
