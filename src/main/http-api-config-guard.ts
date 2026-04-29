const HTTP_API_TOKEN_REQUIRED_MESSAGE = 'HTTP API token is required when authentication is enabled';

interface HttpApiAuthConfig {
  enableAuth: boolean;
  token?: string;
}

function readToken(config: HttpApiAuthConfig): string {
  return String(config.token || '').trim();
}

export function assertValidHttpApiConfig(config: HttpApiAuthConfig): void {
  if (config.enableAuth && !readToken(config)) {
    throw new Error(HTTP_API_TOKEN_REQUIRED_MESSAGE);
  }
}

export function getHttpApiAuthToken(config: HttpApiAuthConfig): string | undefined {
  if (!config.enableAuth) {
    return undefined;
  }

  const token = readToken(config);
  if (!token) {
    throw new Error(HTTP_API_TOKEN_REQUIRED_MESSAGE);
  }
  return token;
}
