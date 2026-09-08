import type { Request, Response } from 'express';
import { getHealth, getLiveness } from '../../../modules/health/index.js';

/**
 * Controllers translate HTTP to a service call and back. They contain no
 * business rules, no SQL and no transactions.
 */
export function liveness(_req: Request, res: Response): void {
  res.status(200).json(getLiveness());
}

export async function readiness(_req: Request, res: Response): Promise<void> {
  const health = await getHealth();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
}
