import type { Session } from 'electron';
import { getSessionWebRequestHub } from '../core/browser-core/web-request-hub';
import type { ViewMetadata } from './webcontentsview-manager';

export interface WebContentsViewSecurityPolicy {
  webSecurity: boolean;
  allowRunningInsecureContent: boolean;
  disableCSP: boolean;
}

export class WebContentsViewSecurityController {
  private securityOverridesByPartition: Map<string, { disableCSP: boolean }> = new Map();
  private securityHookedPartitions: Set<string> = new Set();

  private ensureSecurityHooks(session: Session, partition: string): void {
    if (this.securityHookedPartitions.has(partition)) {
      return;
    }
    this.securityHookedPartitions.add(partition);
    const requestHub = getSessionWebRequestHub(session);

    requestHub.subscribeHeadersReceived((details, callback) => {
      const overrides = this.securityOverridesByPartition.get(partition);
      if (!overrides || !overrides.disableCSP || !details.url.startsWith('http')) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const responseHeaders = { ...(details.responseHeaders || {}) } as Record<
        string,
        string | string[]
      >;
      delete responseHeaders['content-security-policy'];
      delete responseHeaders['Content-Security-Policy'];

      callback({ responseHeaders });
    });
  }

  resolvePolicy(metadata?: ViewMetadata): {
    webSecurity: boolean;
    allowRunningInsecureContent: boolean;
    disableCSP: boolean;
  } {
    const defaults = {
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableCSP: false,
    };

    const overrides = metadata?.security || {};
    return {
      webSecurity:
        typeof overrides.webSecurity === 'boolean' ? overrides.webSecurity : defaults.webSecurity,
      allowRunningInsecureContent:
        typeof overrides.allowRunningInsecureContent === 'boolean'
          ? overrides.allowRunningInsecureContent
          : defaults.allowRunningInsecureContent,
      disableCSP:
        typeof overrides.disableCSP === 'boolean' ? overrides.disableCSP : defaults.disableCSP,
    };
  }

  resolveAllowedPermissions(metadata?: ViewMetadata): Set<string> {
    const values = Array.isArray(metadata?.security?.allowedPermissions)
      ? metadata.security.allowedPermissions
      : [];
    return new Set(
      values
        .map((permission) => String(permission || '').trim())
        .filter((permission) => permission.length > 0)
    );
  }


  applyToPartition(
    session: Session,
    partition: string,
    securityPolicy: WebContentsViewSecurityPolicy
  ): void {
    const existingSecurity = this.securityOverridesByPartition.get(partition);
    if (existingSecurity) {
      existingSecurity.disableCSP = existingSecurity.disableCSP || securityPolicy.disableCSP;
    } else {
      this.securityOverridesByPartition.set(partition, {
        disableCSP: securityPolicy.disableCSP,
      });
    }
    this.ensureSecurityHooks(session, partition);
  }
}
