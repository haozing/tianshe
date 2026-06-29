import { describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { AirpaHttpMcpServer } from './mcp-server-http';

describe('AirpaHttpMcpServer start/stop lifecycle', () => {
  it('start is idempotent for an already running server', async () => {
    const server = new AirpaHttpMcpServer({ port: 0 });

    try {
      await server.start();
      const firstHttpServer = (server as unknown as { httpServer: HttpServer | null })
        .httpServer;
      expect(firstHttpServer?.listening).toBe(true);

      await server.start();
      const secondHttpServer = (server as unknown as { httpServer: HttpServer | null })
        .httpServer;

      expect(secondHttpServer).toBe(firstHttpServer);
      expect(secondHttpServer?.listening).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
