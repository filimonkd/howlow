import {
  walletSchema,
  walletTransactionsSchema,
  type WalletDto,
  type WalletEntryDto,
} from '@howlow/shared';
import { apiFetch } from './api.js';
import { getAccessToken } from './auth-api.js';

/**
 * The website's wallet client.
 *
 * It reads the API and nothing else — there is no local balance, no cached
 * total and no computed figure anywhere in the browser. The balance shown is
 * the one the ledger produced, and the responses are parsed against the shared
 * schemas so a shape change is caught here rather than rendered as `undefined`.
 */
function authorized(): RequestInit {
  const token = getAccessToken();
  return token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } };
}

export function fetchWallet(): Promise<WalletDto> {
  return apiFetch('/me/wallet', (value) => walletSchema.parse(value), authorized());
}

export interface TransactionPage {
  readonly entries: readonly WalletEntryDto[];
  readonly nextCursor: string | null;
}

export function fetchTransactions(input: { limit?: number; cursor?: string } = {}): Promise<TransactionPage> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  return apiFetch(
    `/me/wallet/transactions?${query.toString()}`,
    (value) => walletTransactionsSchema.parse(value),
    authorized(),
  );
}
