import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';

/**
 * The single envelope every HTTP error response uses, so that the web client
 * and any future channel decode failures the same way.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
