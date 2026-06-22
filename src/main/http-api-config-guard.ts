const HTTP_API_TOKEN_REQUIRED_MESSAGE = 'HTTP API token is required when authentication is enabled';

interface HttpApiAuthConfig {
  enableAuth: boolean;
  agentHandMode?: boolean;
  token?: string;
}

function readToken(config: HttpApiAuthConfig): string {
  return String(config.token || '').trim();
}

export function assertValidHttpApiConfig(config: HttpApiAuthConfig): void {
  if ((config.enableAuth || config.agentHandMode === true) && !readToken(config)) {
    throw new Error(HTTP_API_TOKEN_REQUIRED_MESSAGE);
  }
}

export function getHttpApiAuthToken(config: HttpApiAuthConfig): string | undefined {
  if (!config.enableAuth && config.agentHandMode !== true) {
    return undefined;
  }

  const token = readToken(config);
  if (!token) {
    throw new Error(HTTP_API_TOKEN_REQUIRED_MESSAGE);
  }
  return token;
}
