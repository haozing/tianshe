import type { Application, Request, Response } from 'express';
import type { RestApiConfig } from '../types/http-api';
import { ErrorCode, createStructuredError } from '../types/error-codes';
import { sendStructuredError } from './http-response-mapper';

interface LoggerLike {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface RegisterTokenAuthMiddlewareOptions {
  app: Application;
  expectedToken: string;
  restApiConfig?: RestApiConfig;
  logger: LoggerLike;
}

/**
 * 注册 Bearer Token 鉴权中间件。
 *
 * 安全策略：
 * - /health: 免鉴权（用于健康检查）
 * - /mcp: 由 mcpRequireAuth 决定是否需要鉴权
 * - 其他路由: 强制鉴权
 */
export const registerTokenAuthMiddleware = ({
  app,
  expectedToken,
  restApiConfig,
  logger,
}: RegisterTokenAuthMiddlewareOptions): void => {
  const mcpRequireAuth = restApiConfig?.mcpRequireAuth ?? true;

  app.use((req: Request, res: Response, next) => {
    if (req.path === '/health') {
      return next();
    }

    if (req.path === '/mcp' && !mcpRequireAuth) {
      return next();
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    if (token !== expectedToken) {
      logger.warn(`Unauthorized request to ${req.path} from ${req.ip || 'unknown'}`);
      return sendStructuredError(
        res,
        createStructuredError(ErrorCode.PERMISSION_DENIED, 'Unauthorized', {
          suggestion: '请检查 Bearer Token 是否正确',
        }),
        401
      );
    }

    return next();
  });

  logger.info(`Token authentication enabled (MCP auth: ${mcpRequireAuth ? 'required' : 'optional'})`);
};
