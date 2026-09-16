import {
  auctionDetailSchema,
  auctionListSchema,
  categoryTreeSchema,
  productSchema,
  type AuctionAdminDetailDto,
  type AuctionListQuery,
  type AuctionSummaryDto,
  type CategoryTreeDto,
  type ImageUploadTicket,
  type ProductDto,
} from '@howlow/shared';
import { z } from 'zod';
import { apiFetch } from './api.js';
import { getAccessToken } from './auth-api.js';

/**
 * The website's catalog and auction client.
 *
 * Responses are parsed against the shared schemas, so a contract change
 * surfaces here rather than rendering as `undefined` three components deep.
 * Nothing is computed locally: every price, countdown and status comes from
 * the API, which is what keeps the browser and the Telegram bot in agreement.
 */
function authorized(): RequestInit {
  const token = getAccessToken();
  return token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } };
}

function json(body: unknown, method: 'POST' | 'PATCH' = 'POST'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...authorized().headers },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

const categoryListSchema = z.object({ categories: z.array(categoryTreeSchema) });

export function fetchCategories(): Promise<CategoryTreeDto[]> {
  return apiFetch('/categories', (value) => categoryListSchema.parse(value).categories);
}

export interface AuctionPage {
  readonly auctions: readonly AuctionSummaryDto[];
  readonly nextCursor: string | null;
}

export function fetchAuctions(query: Partial<AuctionListQuery> = {}): Promise<AuctionPage> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.categorySlug !== undefined) params.set('categorySlug', query.categorySlug);
  if (query.sort !== undefined) params.set('sort', query.sort);
  params.set('limit', String(query.limit ?? 12));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);

  return apiFetch(`/auctions?${params.toString()}`, (value) => auctionListSchema.parse(value));
}

/** One auction, by uuid or slug — both are public references. */
export function fetchAuction(reference: string): Promise<z.infer<typeof auctionDetailSchema>> {
  return apiFetch(`/auctions/${encodeURIComponent(reference)}`, (value) => auctionDetailSchema.parse(value));
}

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

const productListSchema = z.object({
  products: z.array(productSchema),
  nextCursor: z.string().nullable(),
});

export function fetchMyProducts(): Promise<{
  products: readonly ProductDto[];
  nextCursor: string | null;
}> {
  return apiFetch('/seller/products?limit=50', (v) => productListSchema.parse(v), authorized());
}

export interface NewProduct {
  readonly title: string;
  readonly description: string;
  readonly retailPriceMinor: string;
  readonly stockQuantity: number;
  readonly condition: ProductDto['condition'];
  readonly categoryId?: string | undefined;
  readonly brand?: string | undefined;
  readonly sku?: string | undefined;
}

export function createProduct(input: NewProduct): Promise<ProductDto> {
  return apiFetch('/seller/products', (v) => productSchema.parse(v), json(input));
}

export function updateProduct(
  productId: string,
  changes: Partial<NewProduct> & { status?: 'draft' | 'active' },
): Promise<ProductDto> {
  return apiFetch(`/seller/products/${productId}`, (v) => productSchema.parse(v), json(changes, 'PATCH'));
}

export function archiveProduct(productId: string): Promise<ProductDto> {
  return apiFetch(`/seller/products/${productId}/archive`, (v) => productSchema.parse(v), json({}));
}

/**
 * Ask for an upload slot, then PUT the file straight to storage.
 *
 * The bytes never pass through the API, and the browser never chooses the
 * object path — the server does, which is what stops one seller writing over
 * another's image.
 */
export async function uploadProductImage(input: {
  productId: string;
  file: File;
  altText?: string;
}): Promise<void> {
  const ticket = await apiFetch<ImageUploadTicket>(
    `/seller/products/${input.productId}/images`,
    (v) => v as ImageUploadTicket,
    json({
      contentType: input.file.type,
      sizeBytes: input.file.size,
      ...(input.altText === undefined ? {} : { altText: input.altText }),
    }),
  );

  const response = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: ticket.headers,
    body: input.file,
  });
  if (!response.ok) {
    throw new Error(`The image could not be uploaded (storage responded ${response.status}).`);
  }
}

const auctionAdminSchema = z.object({}).passthrough();

export interface NewAuction {
  readonly productId: string;
  readonly title: string;
  readonly description: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly minBidMinor: string;
  readonly maxBidMinor: string;
  readonly bidIncrementMinor: string;
  readonly maxBidsPerUser: number;
  readonly bidFeeMinor: string;
  readonly winnerPaymentHours?: number;
  readonly shippingNote?: string;
}

export function fetchMyAuctions(): Promise<AuctionPage> {
  return apiFetch('/seller/auctions?limit=50&sort=newest', (v) => auctionListSchema.parse(v), authorized());
}

export function fetchMyAuction(auctionId: string): Promise<AuctionAdminDetailDto> {
  return apiFetch(
    `/seller/auctions/${auctionId}`,
    (v) => auctionAdminSchema.parse(v) as unknown as AuctionAdminDetailDto,
    authorized(),
  );
}

export function createAuction(input: NewAuction): Promise<AuctionAdminDetailDto> {
  return apiFetch(
    '/seller/auctions',
    (v) => auctionAdminSchema.parse(v) as unknown as AuctionAdminDetailDto,
    json(input),
  );
}

const transitionSchema = z.object({ changed: z.boolean(), auction: auctionAdminSchema });

export function submitAuction(auctionId: string): Promise<{ changed: boolean }> {
  return apiFetch(`/seller/auctions/${auctionId}/submit`, (v) => transitionSchema.parse(v), json({}));
}

export function cancelMyAuction(auctionId: string, reason: string): Promise<{ changed: boolean }> {
  return apiFetch(`/seller/auctions/${auctionId}/cancel`, (v) => transitionSchema.parse(v), json({ reason }));
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export function fetchPendingAuctions(): Promise<AuctionPage> {
  return apiFetch('/admin/auctions/pending?limit=50', (v) => auctionListSchema.parse(v), authorized());
}

export function approveAuction(auctionId: string): Promise<{ changed: boolean }> {
  return apiFetch(`/admin/auctions/${auctionId}/approve`, (v) => transitionSchema.parse(v), json({}));
}

export function rejectAuction(auctionId: string, reason: string): Promise<{ changed: boolean }> {
  return apiFetch(`/admin/auctions/${auctionId}/reject`, (v) => transitionSchema.parse(v), json({ reason }));
}

export function suspendAuction(auctionId: string, reason: string): Promise<{ changed: boolean }> {
  return apiFetch(`/admin/auctions/${auctionId}/suspend`, (v) => transitionSchema.parse(v), json({ reason }));
}

export function resumeAuction(auctionId: string): Promise<{ changed: boolean }> {
  return apiFetch(`/admin/auctions/${auctionId}/resume`, (v) => transitionSchema.parse(v), json({}));
}

export function cancelAuction(auctionId: string, reason: string): Promise<{ changed: boolean }> {
  return apiFetch(`/admin/auctions/${auctionId}/cancel`, (v) => transitionSchema.parse(v), json({ reason }));
}

export function fetchAllCategories(): Promise<CategoryTreeDto[]> {
  return apiFetch('/admin/categories', (v) => categoryListSchema.parse(v).categories, authorized());
}

export function createCategory(input: { name: string; parentId?: string }): Promise<CategoryTreeDto> {
  return apiFetch('/admin/categories', (v) => v as CategoryTreeDto, json(input));
}
