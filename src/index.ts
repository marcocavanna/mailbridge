#!/usr/bin/env node

import { startServer } from './server-runtime.js';

import { logger } from '#shared/logger';

/* --------
 * Bootstrap
 * -------- */

/**
 * Direct entry point for the MCP server, equivalent to `mailbridge serve`.
 *
 * It exists separately because it is the shortest path with the fewest modules loaded: an MCP client
 * invokes it directly, without going through the command parser.
 */
startServer().catch((cause: unknown) => {
  logger.error('startup failed', { error: cause });
  process.exit(1);
});
