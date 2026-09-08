import { z } from 'zod';
import { CHANNELS } from '../channel.js';
import { SUPPORTED_CURRENCIES } from '../money.js';

/** A BIGINT minor-unit amount as it travels over the wire: a decimal string. */
export const minorAmountSchema = z
  .string()
  .regex(/^-?\d{1,19}$/, 'Amount must be an integer number of minor units');

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

export const channelSchema = z.enum(CHANNELS);

export const uuidSchema = z.uuid();

export const idempotencyKeySchema = z.string().min(8).max(255);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const moneySchema = z.object({
  amountMinor: minorAmountSchema,
  currency: currencySchema,
});

export type MoneyDto = z.infer<typeof moneySchema>;
