import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { REQUEST_ID_HEADER } from '@howlow/shared';
import { loadConfig } from './config/index.js';
import { createApiRouter, errorHandler, notFoundHandler, requestId } from './channels/http/index.js';
import { createTelegramRouter } from './channels/telegram/index.js';
import { getLogger } from './shared/index.js';

/**
 * Compose the process's HTTP surface. Both channels are mounted onto one
 * Express app in front of one backend — Telegram is not a separate service and
 * does not get its own database, wallet or bidding path.
 */
export function createApp(): Express {
  const env = loadConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );
  app.use(requestId);
  app.use(pinoHttp({ logger: getLogger(), customProps: (req) => ({ requestId: req.id }) }));

  // Telegram is mounted before the JSON body parser: grammY consumes the raw
  // webhook body itself.
  app.use(createTelegramRouter());

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use('/api/v1', createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
