import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, shutdown } from './server.js';

import { logger } from '#shared/logger';

/* --------
 * Implementation
 * -------- */

/**
 * Starts the MCP server on stdio and registers an orderly shutdown.
 *
 * An absolute constraint for anybody touching this path: **nothing on stdout**. That is where the
 * protocol's JSON-RPC travels, and one log line would corrupt the session. Every diagnostic goes to
 * stderr, which is where the logger writes.
 */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // ---- Lifecycle events
  let closing = false;

  const close = async (reason: string): Promise<void> => {
    if (closing) {
      return;
    }

    closing = true;
    logger.info('shutting down', { reason });

    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await server.connect(transport);

  logger.info('mailbridge listening on stdio');
}
