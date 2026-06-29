import type { App } from 'electron';

export function configureChromiumCommandLine(
  app: App,
  options: {
    e2eCdpPort: number | null;
  }
): void {
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

  const { e2eCdpPort } = options;
  if (typeof e2eCdpPort === 'number' && Number.isInteger(e2eCdpPort) && e2eCdpPort > 0) {
    app.commandLine.appendSwitch('remote-debugging-port', String(e2eCdpPort));
  }
}
