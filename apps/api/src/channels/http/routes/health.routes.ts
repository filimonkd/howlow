import { Router } from 'express';
import { liveness, readiness } from '../controllers/health.controller.js';

export const healthRoutes: Router = Router();

healthRoutes.get('/live', liveness);
healthRoutes.get('/ready', (req, res, next) => {
  void readiness(req, res).catch(next);
});
