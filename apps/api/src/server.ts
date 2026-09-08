import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closePool, closeRedis } from './db/index.js';
import { getLogger } from './shared/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

export function startServer(): Server {
  const env = loadConfig();
  const logger = getLogger();
  const server = createApp().listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'HOWLOW API listening');
  });

  registerShutdown(server);
  return server;
}

function registerShutdown(server: Server): void {
  const logger = getLogger();
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down HOWLOW API');

    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    server.close(() => {
      void Promise.allSettled([closePool(), closeRedis()]).then(() => {
        clearTimeout(timer);
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}
